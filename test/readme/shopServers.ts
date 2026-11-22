import { Admin, Producer, type BaseOptions } from "@platformatic/kafka";
import {
  avroOrder,
  BILLING_COMMITTED,
  HOT_CUSTOMER,
  ORDER_SCHEMA,
  ORDER_SPACING_S,
  ORDERS_PARTITIONS,
  ORDERS_PER_PARTITION,
  toProduce,
  type SeedMessage,
} from "../e2e/kafkaLive.js";
import { liveElasticsearch, seedLiveElasticsearch } from "../e2e/elasticsearchLive.js";
import type { SavedDatasource } from "../e2e/harness.js";
import { startSchemaRegistryMock, type SchemaRegistryMock } from "../support/schemaRegistryMock.js";
import { docker } from "./shop.js";

/**
 * The demo Kafka and Elasticsearch of the datasource scenes (plan 167): disposable containers beside
 * the demo etcd's 52390, never the `test:db` services, which `.env` may point at a shared remote
 * server. Each scene starts its own and removes it, so a recording never shows the last one's writes.
 */

export const SHOP_KAFKA_PORT = 52391;
export const SHOP_ELASTICSEARCH_PORT = 52392;
/** Fixed, because the scene saves the datasource, registry URL and all, before the mock starts. */
export const SHOP_SCHEMA_REGISTRY_PORT = 52393;
export const SHOP_KAFKA_ORDERS = "orders";
export const SHOP_KAFKA_GROUP = "billing";
export const SHOP_KAFKA_HOT_CUSTOMER = HOT_CUSTOMER;

/** The `test:db` services' images, so `readme:media` pulls nothing new. */
const KAFKA_IMAGE = "apache/kafka:4.1.0";
const ELASTICSEARCH_IMAGE = "docker.elastic.co/elasticsearch/elasticsearch:8.19.7";
const KAFKA_CONTAINER = "table-craft-readme-kafka";
const ELASTICSEARCH_CONTAINER = "table-craft-readme-elasticsearch";
const KAFKA_READY_TIMEOUT_MS = 60_000;
const ELASTICSEARCH_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 500;
const KAFKA_CLIENT_ID = "table-craft-readme";
const KAFKA_REQUEST_TIMEOUT_MS = 5_000;
const KAFKA_CONTROLLER_PORT = 9093;
const PAYMENTS = "payments";
const SHIPMENTS = "shipments";
const SHIPPING_GROUP = "shipping";
const PAYMENTS_COUNT = 40;
const SHIPMENTS_COUNT = 24;
const CARRIERS = ["DHL", "UPS", "FedEx"] as const;

function stopContainer(name: string): void {
  try {
    docker(["rm", "--force", name]);
  } catch (error) {
    if (!String(error).includes("No such container")) throw error;
  }
}

async function waitFor(ready: () => Promise<boolean>, timeoutMs: number, failure: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error(failure);
}

function kafkaOptions(): BaseOptions {
  return {
    clientId: KAFKA_CLIENT_ID,
    bootstrapBrokers: [`127.0.0.1:${String(SHOP_KAFKA_PORT)}`],
    timeout: KAFKA_REQUEST_TIMEOUT_MS,
    retries: 1,
  };
}

export function stopShopKafka(): void {
  stopContainer(KAFKA_CONTAINER);
}

/**
 * Starts a single-node KRaft broker whose listener answers on the same port inside and outside the
 * container, so its advertised address works for the app and for the broker itself.
 */
function startKafka(): void {
  stopShopKafka();
  const port = String(SHOP_KAFKA_PORT);
  const environment = {
    KAFKA_NODE_ID: "1",
    KAFKA_PROCESS_ROLES: "broker,controller",
    KAFKA_CONTROLLER_QUORUM_VOTERS: `1@localhost:${String(KAFKA_CONTROLLER_PORT)}`,
    KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER",
    KAFKA_LISTENERS: `PLAINTEXT://:${port},CONTROLLER://:${String(KAFKA_CONTROLLER_PORT)}`,
    KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://127.0.0.1:${port}`,
    KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: "PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT",
    KAFKA_INTER_BROKER_LISTENER_NAME: "PLAINTEXT",
    KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: "1",
    KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: "1",
    KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: "0",
    KAFKA_NUM_PARTITIONS: "1",
  };
  docker([
    "run",
    "--detach",
    "--name",
    KAFKA_CONTAINER,
    "--publish",
    `127.0.0.1:${port}:${port}`,
    "--tmpfs",
    "/tmp/kraft-combined-logs",
    ...Object.entries(environment).flatMap(([name, value]) => ["--env", `${name}=${value}`]),
    KAFKA_IMAGE,
  ]);
}

function orders(schemaId: number, start: number): SeedMessage[] {
  return Array.from({ length: ORDERS_PARTITIONS * ORDERS_PER_PARTITION }, (_, index) => {
    const partition = index % ORDERS_PARTITIONS;
    const customer = partition === 1 && index % 9 === 1 ? HOT_CUSTOMER : `cust-${String(100 + index)}`;
    return {
      partition,
      key: customer,
      value: avroOrder(schemaId, { id: `o-${String(1000 + index)}`, customer, amount: 12 + (index % 17) * 3.5 }),
      timestamp: start + index * ORDER_SPACING_S * 1000,
      headers: { source: "storefront", "trace-id": `t-${String(7000 + index)}` },
    };
  });
}

function payments(start: number): SeedMessage[] {
  return Array.from({ length: PAYMENTS_COUNT }, (_, index) => ({
    partition: index % 2,
    key: `o-${String(1000 + index)}`,
    value: JSON.stringify({ order: `o-${String(1000 + index)}`, status: index % 11 === 0 ? "declined" : "captured" }),
    timestamp: start + index * ORDER_SPACING_S * 1000,
  }));
}

function shipments(start: number): SeedMessage[] {
  return Array.from({ length: SHIPMENTS_COUNT }, (_, index) => ({
    partition: 0,
    key: `o-${String(1000 + index)}`,
    value: JSON.stringify({ order: `o-${String(1000 + index)}`, carrier: CARRIERS[index % CARRIERS.length] }),
    timestamp: start + index * ORDER_SPACING_S * 1000,
  }));
}

/**
 * Starts the demo broker and a Schema Registry mock on `SHOP_SCHEMA_REGISTRY_PORT`, then seeds
 * Avro `orders` (with `cust-42` on partition 1), JSON `payments` and `shipments`, a lagging
 * `billing` group and a caught-up `shipping` one. `close` stops the mock; `stopShopKafka` the broker.
 */
export async function loadShopKafka(): Promise<{ readonly close: () => Promise<void> }> {
  startKafka();
  const options = kafkaOptions();
  const admin = new Admin(options);
  let registry: SchemaRegistryMock | null = null;
  try {
    await waitFor(
      async () => {
        await admin.listTopics();
        return true;
      },
      KAFKA_READY_TIMEOUT_MS,
      `The demo Kafka did not answer on port ${String(SHOP_KAFKA_PORT)}; see \`docker logs ${KAFKA_CONTAINER}\`.`,
    );
    const started = await startSchemaRegistryMock({ port: SHOP_SCHEMA_REGISTRY_PORT });
    registry = started;
    const schema = started.register(`${SHOP_KAFKA_ORDERS}-value`, "AVRO", JSON.stringify(ORDER_SCHEMA));
    await admin.createTopics({ topics: [SHOP_KAFKA_ORDERS], partitions: ORDERS_PARTITIONS, replicas: 1 });
    await admin.createTopics({ topics: [PAYMENTS], partitions: 2, replicas: 1 });
    await admin.createTopics({ topics: [SHIPMENTS], partitions: 1, replicas: 1 });

    const start = Date.now() - ORDERS_PARTITIONS * ORDERS_PER_PARTITION * ORDER_SPACING_S * 1000;
    const producer = new Producer({ ...options, acks: -1, idempotent: false });
    try {
      for (const [topic, messages] of [
        [SHOP_KAFKA_ORDERS, orders(schema.id, start)],
        [PAYMENTS, payments(start)],
        [SHIPMENTS, shipments(start)],
      ] as const) {
        await producer.send({ messages: messages.map((message) => toProduce(topic, message)) });
      }
    } finally {
      await producer.close();
    }

    await admin.alterConsumerGroupOffsets({
      groupId: SHOP_KAFKA_GROUP,
      topics: [
        {
          name: SHOP_KAFKA_ORDERS,
          partitionOffsets: BILLING_COMMITTED.map((offset, partition) => ({ partition, offset: BigInt(offset) })),
        },
      ],
    });
    await admin.alterConsumerGroupOffsets({
      groupId: SHIPPING_GROUP,
      topics: [{ name: SHIPMENTS, partitionOffsets: [{ partition: 0, offset: BigInt(SHIPMENTS_COUNT) }] }],
    });
    return { close: () => started.close() };
  } catch (cause) {
    await registry?.close().catch(() => undefined);
    stopShopKafka();
    throw cause;
  } finally {
    await admin.close().catch(() => undefined);
  }
}

export const SHOP_SEARCH = "search";
/** The demo Elasticsearch as saved, for the datasource scene and the agent one. */
export const SHOP_SEARCH_DATASOURCE: SavedDatasource = {
  id: SHOP_SEARCH,
  name: SHOP_SEARCH,
  pluginId: "elasticsearch",
  color: "yellow",
  config: { host: "127.0.0.1", port: SHOP_ELASTICSEARCH_PORT, authMode: "none", tlsMode: "disable" },
};

export function stopShopElasticsearch(): void {
  stopContainer(ELASTICSEARCH_CONTAINER);
}

/** Starts a single-node Elasticsearch without security and seeds plan 165's live shop into it. */
export async function loadShopElasticsearch(): Promise<void> {
  stopShopElasticsearch();
  docker([
    "run",
    "--detach",
    "--name",
    ELASTICSEARCH_CONTAINER,
    "--publish",
    `127.0.0.1:${String(SHOP_ELASTICSEARCH_PORT)}:9200`,
    "--tmpfs",
    "/usr/share/elasticsearch/data:uid=1000",
    "--env",
    "discovery.type=single-node",
    "--env",
    "xpack.security.enabled=false",
    "--env",
    "xpack.ml.enabled=false",
    "--env",
    "cluster.routing.allocation.disk.threshold_enabled=false",
    "--env",
    "ES_JAVA_OPTS=-Xms512m -Xmx512m",
    ELASTICSEARCH_IMAGE,
  ]);
  const live = liveElasticsearch({ host: "127.0.0.1", port: SHOP_ELASTICSEARCH_PORT });
  try {
    await waitFor(
      async () => (await fetch(`${live.url}/_cluster/health?wait_for_status=yellow&timeout=1s`)).ok,
      ELASTICSEARCH_READY_TIMEOUT_MS,
      `The demo Elasticsearch did not answer on port ${String(SHOP_ELASTICSEARCH_PORT)}; see \`docker logs ${ELASTICSEARCH_CONTAINER}\`.`,
    );
    await seedLiveElasticsearch(live, Date.now());
  } catch (cause) {
    stopShopElasticsearch();
    throw cause;
  }
}
