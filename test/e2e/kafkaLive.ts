import { randomBytes } from "node:crypto";
import { Admin, Consumer, Producer, type BaseOptions, type MessageToProduce } from "@platformatic/kafka";
import { KAFKA_CONFIG, KAFKA_SCRATCH_PREFIX } from "../support/databases.js";
import { startSchemaRegistryMock, type SchemaRegistryMock } from "../support/schemaRegistryMock.js";

/**
 * Plan 164's live seed: `tc_run_<random>_*` topics and groups on the Kafka the run names (the remote
 * one from `.env`, else the compose broker), and a Schema Registry mock in this process, which the
 * app in the same box reaches on 127.0.0.1. Everything it makes is removed by `drop`, even when a
 * scenario failed; it never touches a topic or group it did not create.
 */

const CLIENT_ID = "table-craft-live-164";
const REQUEST_TIMEOUT_MS = 20_000;
const JOIN_DEADLINE_MS = 30_000;
const JOIN_POLL_MS = 250;
const RANDOM_BYTES = 3;
const SEND_BATCH = 200;
const BULK_VALUE_BYTES = 200;
const BULK_BATCH = 2000;
/** Two large values per request, so a batch stays under the broker's default 1 MB message cap. */
const LARGE_BATCH = 2;
/** Ends every large value, so a test can tell the whole value from its 1,024-character preview. */
export const LARGE_VALUE_END = "|end";

export const ORDERS_PARTITIONS = 3;
export const ORDERS_PER_PARTITION = 30;
/** Seconds between two seeded orders, so a timestamp read can start halfway. */
export const ORDER_SPACING_S = 10;
export const HOT_CUSTOMER = "cust-42";
/**
 * The billing group commits these offsets on orders, one per partition: lag 30, 4 and 3, so
 * partition 0 runs hot against the median.
 */
export const BILLING_COMMITTED = [0, 26, 27] as const;
/** The lag warning the live datasource sets, below the billing group's total lag. */
export const LIVE_LAG_WARNING = 22;
export const HISTORY_FILLERS = 600;
export const EARLY_KEY = "cust-early";
export const PURGE_PARTITIONS = 2;
export const PURGE_PER_PARTITION = 10;

export const ORDER_SCHEMA = {
  type: "record",
  name: "Order",
  fields: [
    { name: "id", type: "string" },
    { name: "customer", type: "string" },
    { name: "amount", type: "double" },
  ],
};
/** A compatible second version: the added field has a default. */
export const ORDER_SCHEMA_V2 = {
  ...ORDER_SCHEMA,
  fields: [...ORDER_SCHEMA.fields, { name: "note", type: "string", default: "" }],
};
/** Not BACKWARD compatible with v2: a new field without a default. */
export const ORDER_SCHEMA_BROKEN = {
  ...ORDER_SCHEMA,
  fields: [...ORDER_SCHEMA_V2.fields, { name: "region", type: "string" }],
};

export interface LiveKafka {
  readonly bootstrapServers: string;
  readonly registry: SchemaRegistryMock;
  readonly orders: string;
  readonly history: string;
  readonly events: string;
  readonly purge: string;
  /** Created by a scenario, through the app; listed so `drop` removes it when one fails half way. */
  readonly created: string;
  /** Filled only by the scenario that cancels a long read, through `fillBulk`. */
  readonly bulk: string;
  /** Filled only by the scenario that reads large messages, through `fillLarge`. */
  readonly large: string;
  readonly billing: string;
  readonly active: string;
  readonly orderSubject: string;
  /** When the first order was stamped; order i is `ORDER_SPACING_S * i` seconds later. */
  readonly ordersStart: number;
  /** Sends `messages` in batches of `batch`; send a big message alone, as one batch must fit a request. */
  readonly produce: (topic: string, messages: readonly SeedMessage[], batch?: number) => Promise<void>;
  /** Creates `bulk` and fills it with `count` records, enough that reading it all takes a while. */
  readonly fillBulk: (count: number) => Promise<void>;
  /** Creates `large` and fills it with `count` values of `bytes` each, ending with `LARGE_VALUE_END`. */
  readonly fillLarge: (count: number, bytes: number) => Promise<void>;
  readonly drop: () => Promise<void>;
}

export interface SeedMessage {
  readonly partition?: number;
  readonly key: string | null;
  readonly value: Buffer | string;
  readonly timestamp?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

function driverOptions(bootstrapServers: string): BaseOptions {
  return {
    clientId: CLIENT_ID,
    bootstrapBrokers: bootstrapServers.split(",").map((broker) => broker.trim()),
    timeout: REQUEST_TIMEOUT_MS,
    retries: 1,
  };
}

function zigzag(value: number): Buffer {
  let rest = BigInt(value);
  rest = rest >= 0n ? rest << 1n : (-rest << 1n) - 1n;
  const bytes: number[] = [];
  while (rest > 0x7fn) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
}

function avroString(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([zigzag(bytes.length), bytes]);
}

function avroDouble(value: number): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleLE(value);
  return bytes;
}

/** An `Order` v1 value in the Confluent wire format: magic 0, the schema id, then Avro binary. */
export function avroOrder(schemaId: number, order: { id: string; customer: string; amount: number }): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(schemaId, 1);
  return Buffer.concat([header, avroString(order.id), avroString(order.customer), avroDouble(order.amount)]);
}

export function toProduce(topic: string, message: SeedMessage): MessageToProduce {
  return {
    topic,
    ...(message.partition === undefined ? {} : { partition: message.partition }),
    ...(message.key === null ? {} : { key: Buffer.from(message.key) }),
    value: typeof message.value === "string" ? Buffer.from(message.value) : message.value,
    timestamp: BigInt(message.timestamp ?? Date.now()),
    ...(message.headers === undefined
      ? {}
      : {
          headers: new Map(
            Object.entries(message.headers).map(([name, value]) => [Buffer.from(name), Buffer.from(value)]),
          ),
        }),
  };
}

/** Seeds the run's topics, groups and subjects; a failure part way removes what it made. */
export async function seedLiveKafka(bootstrapServers: string = KAFKA_CONFIG.bootstrapServers): Promise<LiveKafka> {
  const prefix = `${KAFKA_SCRATCH_PREFIX}${randomBytes(RANDOM_BYTES).toString("hex")}_`;
  const names = {
    orders: `${prefix}orders`,
    history: `${prefix}history`,
    events: `${prefix}events`,
    purge: `${prefix}purge`,
    created: `${prefix}created`,
    bulk: `${prefix}bulk`,
    large: `${prefix}large`,
    billing: `${prefix}billing`,
    active: `${prefix}active`,
  };
  const options = driverOptions(bootstrapServers);
  const admin = new Admin(options);
  const producer = new Producer({ ...options, acks: -1, idempotent: false });
  const registry = await startSchemaRegistryMock();
  let member: { close: () => Promise<void> } | null = null;

  const produce = async (topic: string, messages: readonly SeedMessage[], batch = SEND_BATCH) => {
    for (let at = 0; at < messages.length; at += batch) {
      await producer.send({ messages: messages.slice(at, at + batch).map((message) => toProduce(topic, message)) });
    }
  };

  const fillBulk = async (count: number) => {
    await admin.createTopics({ topics: [names.bulk], partitions: 1, replicas: 1 });
    const filler = "x".repeat(BULK_VALUE_BYTES);
    await produce(
      names.bulk,
      Array.from({ length: count }, (_, n) => ({ partition: 0, key: `bulk-${String(n)}`, value: filler })),
      BULK_BATCH,
    );
  };

  const fillLarge = async (count: number, bytes: number) => {
    await admin.createTopics({ topics: [names.large], partitions: 1, replicas: 1 });
    const filler = "x".repeat(bytes - LARGE_VALUE_END.length);
    await produce(
      names.large,
      Array.from({ length: count }, (_, n) => ({
        partition: 0,
        key: `large-${String(n)}`,
        value: `${filler}${LARGE_VALUE_END}`,
      })),
      LARGE_BATCH,
    );
  };

  const drop = async () => {
    await member?.close().catch(() => undefined);
    member = null;
    await admin.deleteGroups({ groups: [names.billing, names.active] }).catch(() => undefined);
    for (const topic of [
      names.orders,
      names.history,
      names.events,
      names.purge,
      names.created,
      names.bulk,
      names.large,
    ]) {
      await admin.deleteTopics({ topics: [topic] }).catch(() => undefined);
    }
    await producer.close().catch(() => undefined);
    await admin.close().catch(() => undefined);
    await registry.close().catch(() => undefined);
  };

  try {
    await admin.createTopics({ topics: [names.orders], partitions: ORDERS_PARTITIONS, replicas: 1 });
    await admin.createTopics({ topics: [names.history, names.events], partitions: 1, replicas: 1 });
    await admin.createTopics({ topics: [names.purge], partitions: PURGE_PARTITIONS, replicas: 1 });

    const orderSubject = `${names.orders}-value`;
    const v1 = registry.register(orderSubject, "AVRO", JSON.stringify(ORDER_SCHEMA));
    registry.register(orderSubject, "AVRO", JSON.stringify(ORDER_SCHEMA_V2));

    const ordersStart = Date.now() - ORDERS_PARTITIONS * ORDERS_PER_PARTITION * ORDER_SPACING_S * 1000;
    const orders: SeedMessage[] = [];
    for (let index = 0; index < ORDERS_PARTITIONS * ORDERS_PER_PARTITION; index += 1) {
      const partition = index % ORDERS_PARTITIONS;
      const customer = partition === 1 && index % 9 === 1 ? HOT_CUSTOMER : `cust-${String(100 + index)}`;
      orders.push({
        partition,
        key: customer,
        value: avroOrder(v1.id, { id: `o-${String(index)}`, customer, amount: index + 0.5 }),
        timestamp: ordersStart + index * ORDER_SPACING_S * 1000,
        headers: { source: "live-seed", "trace-id": `t-${String(index)}` },
      });
    }
    await produce(names.orders, orders);

    await produce(names.history, [
      { partition: 0, key: EARLY_KEY, value: JSON.stringify({ note: "the only early one" }) },
      ...Array.from({ length: HISTORY_FILLERS }, (_, n) => ({
        partition: 0,
        key: `filler-${String(n)}`,
        value: JSON.stringify({ n }),
      })),
    ]);

    await produce(
      names.purge,
      Array.from({ length: PURGE_PARTITIONS * PURGE_PER_PARTITION }, (_, n) => ({
        partition: n % PURGE_PARTITIONS,
        key: `purge-${String(n)}`,
        value: JSON.stringify({ n }),
      })),
    );
    await produce(names.events, [{ partition: 0, key: "boot", value: JSON.stringify({ event: "boot" }) }]);

    await admin.alterConsumerGroupOffsets({
      groupId: names.billing,
      topics: [
        {
          name: names.orders,
          partitionOffsets: BILLING_COMMITTED.map((offset, partition) => ({ partition, offset: BigInt(offset) })),
        },
      ],
    });

    await admin.alterConsumerGroupOffsets({
      groupId: names.active,
      topics: [{ name: names.events, partitionOffsets: [{ partition: 0, offset: 0n }] }],
    });
    member = await joinGroup(options, admin, names.active, names.events);

    return { bootstrapServers, registry, ...names, orderSubject, ordersStart, produce, fillBulk, fillLarge, drop };
  } catch (cause) {
    await drop();
    throw cause;
  }
}

/** Joins `group` on `topic` and holds the membership until closed, so the group is Stable. */
async function joinGroup(
  options: BaseOptions,
  admin: Admin,
  group: string,
  topic: string,
): Promise<{ close: () => Promise<void> }> {
  const consumer = new Consumer({ ...options, groupId: group });
  const stream = await consumer.consume({ topics: [topic], mode: "latest", autocommit: false });
  stream.on("data", () => undefined);
  const deadline = Date.now() + JOIN_DEADLINE_MS;
  for (;;) {
    const described = await admin.describeGroups({ groups: [group] });
    if ((described.get(group)?.members.size ?? 0) > 0) break;
    if (Date.now() > deadline) throw new Error(`${group} did not get a member within ${String(JOIN_DEADLINE_MS)} ms.`);
    await new Promise((done) => setTimeout(done, JOIN_POLL_MS));
  }
  return {
    close: async () => {
      await stream.close().catch(() => undefined);
      await consumer.close(true).catch(() => undefined);
    },
  };
}
