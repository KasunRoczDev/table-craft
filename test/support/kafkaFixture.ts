import { randomBytes } from "node:crypto";
import { Admin, Consumer, Producer, type BaseOptions } from "@platformatic/kafka";
import type { CommandsFixture, StreamsFixture } from "@table-craft/plugin-api/testing";
import { noteTopicSize } from "@table-craft/plugin-kafka/sizes";
import { KAFKA_CONFIG, KAFKA_SCRATCH_PREFIX } from "./databases.js";
import { startSchemaRegistryMock, type SchemaRegistryMock } from "./schemaRegistryMock.js";

const RANDOM_BYTES = 4;
const CLIENT_ID = "table-craft-tests";
const REQUEST_TIMEOUT_MS = 20_000;
const JOIN_DEADLINE_MS = 30_000;
const JOIN_POLL_MS = 250;
const SECOND_MS = 1000n;
/** 2026-01-01T00:00:00Z: the seeded records carry fixed timestamps, so their rows are exact. */
const SEED_EPOCH_MS = 1_767_225_600_000n;
const BINARY_VALUE = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
/** Above the 1 M messages that make `consume` without `--limit` costly (decision 10 of plan 164). */
const BIG_TOPIC_MESSAGES = "2000000";
const MESSAGE_COLUMNS = [
  "partition",
  "offset",
  "timestamp",
  "key",
  "value",
  "headers",
  "size",
  "keySchema",
  "valueSchema",
];

const suffix = randomBytes(RANDOM_BYTES).toString("hex");

/**
 * The one topic the commands contract reads, created and seeded once per run by
 * `seedKafkaFixture` with three records of fixed timestamps, and never written by a case.
 */
export const KAFKA_FIXTURE_TOPIC = `${KAFKA_SCRATCH_PREFIX}contract_${suffix}`;
/** A topic no case creates; the fixture tells the language it is big, as a listing would. */
const BIG_TOPIC = `${KAFKA_SCRATCH_PREFIX}contract_big_${suffix}`;
const PROBE_TOPIC = `${KAFKA_SCRATCH_PREFIX}contract_probe_${suffix}`;

noteTopicSize(BIG_TOPIC, BIG_TOPIC_MESSAGES);

function iso(offsetSeconds: bigint): { kind: "date"; iso: string } {
  return { kind: "date", iso: new Date(Number(SEED_EPOCH_MS + offsetSeconds * SECOND_MS)).toISOString() };
}

function driverOptions(config: { readonly bootstrapServers: string }): BaseOptions {
  return {
    clientId: CLIENT_ID,
    bootstrapBrokers: config.bootstrapServers.split(",").map((broker) => broker.trim()),
    timeout: REQUEST_TIMEOUT_MS,
    retries: 1,
  };
}

/** Creates and seeds `KAFKA_FIXTURE_TOPIC` through the driver, before the contract runs. */
export async function seedKafkaFixture(config: { readonly bootstrapServers: string } = KAFKA_CONFIG): Promise<void> {
  const admin = new Admin(driverOptions(config));
  const producer = new Producer({ ...driverOptions(config), acks: -1, idempotent: false });
  try {
    await admin.createTopics({ topics: [KAFKA_FIXTURE_TOPIC], partitions: 1, replicas: 1 });
    await producer.send({
      messages: [
        {
          topic: KAFKA_FIXTURE_TOPIC,
          partition: 0,
          key: Buffer.from("k1"),
          value: Buffer.from("hello"),
          timestamp: SEED_EPOCH_MS,
        },
        {
          topic: KAFKA_FIXTURE_TOPIC,
          partition: 0,
          key: Buffer.from("k2"),
          value: Buffer.from('{"n":1}'),
          timestamp: SEED_EPOCH_MS + SECOND_MS,
        },
        {
          topic: KAFKA_FIXTURE_TOPIC,
          partition: 0,
          key: Buffer.from("k3"),
          value: BINARY_VALUE,
          timestamp: SEED_EPOCH_MS + 2n * SECOND_MS,
        },
      ],
    });
  } finally {
    await producer.close();
    await admin.close();
  }
}

/** Deletes `KAFKA_FIXTURE_TOPIC` after the run. */
export async function dropKafkaFixture(config: { readonly bootstrapServers: string } = KAFKA_CONFIG): Promise<void> {
  const admin = new Admin(driverOptions(config));
  try {
    await admin.deleteTopics({ topics: [KAFKA_FIXTURE_TOPIC] }).catch(() => undefined);
  } finally {
    await admin.close();
  }
}

/** What the commands contract runs against `KAFKA_FIXTURE_TOPIC` (decision 9 of plan 164). */
export const KAFKA_COMMANDS: CommandsFixture = {
  scripts: [
    {
      text: `# a comment\ntopics ${KAFKA_SCRATCH_PREFIX}*\n\n  describe orders  \n`,
      statements: [`topics ${KAFKA_SCRATCH_PREFIX}*`, "describe orders"],
    },
    {
      text: 'produce orders {\n  "id": 1,\n  "lines": [1,\n    2]\n} --key k\nbrokers',
      statements: ['produce orders {\n  "id": 1,\n  "lines": [1,\n    2]\n} --key k', "brokers"],
    },
  ],
  scalar: {
    command: `create-topic ${PROBE_TOPIC} --partitions 1 --validate-only`,
    text: `Kafka would create topic ${PROBE_TOPIC} with 1 partition.`,
  },
  array: {
    command: `consume ${KAFKA_FIXTURE_TOPIC} --from earliest --limit 2`,
    columns: MESSAGE_COLUMNS,
    rows: [
      [0, { kind: "bigint", value: "0" }, iso(0n), "k1", "hello", null, 7, null, null],
      [0, { kind: "bigint", value: "1" }, iso(1n), "k2", { kind: "json", text: '{"n":1}' }, null, 9, null, null],
    ],
  },
  map: {
    command: `topics ${KAFKA_FIXTURE_TOPIC}`,
    columns: ["topic", "partitions", "replication", "messages", "internal"],
    rows: [[KAFKA_FIXTURE_TOPIC, 1, 1, 3, false]],
  },
  binary: { command: `message ${KAFKA_FIXTURE_TOPIC} 0 2`, hex: BINARY_VALUE.toString("hex") },
  write: { command: `produce ${KAFKA_FIXTURE_TOPIC} refused`, name: "produce" },
  costly: { command: `consume ${BIG_TOPIC}`, fixed: `consume ${BIG_TOPIC} --limit 500` },
  confirmByName: `delete-topic ${KAFKA_FIXTURE_TOPIC}`,
};

/** A console command that runs `seconds` unless cancelled: follow the idle fixture topic. */
export function kafkaSleep(seconds: number): string {
  return `consume ${KAFKA_FIXTURE_TOPIC} --from latest --wait ${String(seconds)}`;
}

async function waitForMembers(admin: Admin, group: string): Promise<void> {
  const deadline = Date.now() + JOIN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const described = await admin.describeGroups({ groups: [group] }).catch(() => null);
    if ((described?.get(group)?.members.size ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, JOIN_POLL_MS));
  }
  throw new Error(`Consumer group ${group} got no member within ${String(JOIN_DEADLINE_MS)} ms.`);
}

/** The streams contract's fixture: scratch topics, and offsets and members made with the driver. */
export function kafkaStreams(
  config: { readonly bootstrapServers: string } = KAFKA_CONFIG,
  registry: { readonly config: unknown } | undefined = undefined,
): StreamsFixture {
  return {
    scratchPrefix: KAFKA_SCRATCH_PREFIX,
    partitions: 3,
    replicationFactor: 1,
    commitOffsets: async (group, topic, offsets) => {
      const admin = new Admin(driverOptions(config));
      try {
        await admin.alterConsumerGroupOffsets({
          groupId: group,
          topics: [
            {
              name: topic,
              partitionOffsets: offsets.map(({ partition, offset }) => ({ partition, offset: BigInt(offset) })),
            },
          ],
        });
      } finally {
        await admin.close();
      }
    },
    joinGroup: async (group, topic) => {
      const consumer = new Consumer({ ...driverOptions(config), groupId: group });
      const admin = new Admin(driverOptions(config));
      try {
        const stream = await consumer.consume({ topics: [topic], mode: "latest", autocommit: false });
        stream.on("data", () => undefined);
        await waitForMembers(admin, group);
        return async () => {
          await stream.close().catch(() => undefined);
          await consumer.close().catch(() => undefined);
        };
      } catch (error) {
        await consumer.close().catch(() => undefined);
        throw error;
      } finally {
        await admin.close();
      }
    },
    ...(registry === undefined ? {} : { registry }),
  };
}

/** The in-process Schema Registry the registry cases use, and the same cluster's config with its URL. */
export async function startKafkaRegistry(
  config: typeof KAFKA_CONFIG = KAFKA_CONFIG,
): Promise<{ readonly mock: SchemaRegistryMock; readonly config: unknown }> {
  const mock = await startSchemaRegistryMock();
  return { mock, config: { ...config, registryUrl: mock.url } };
}
