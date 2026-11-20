import kafka from "@table-craft/plugin-kafka";
import type { Row, Session } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  databaseEnabled,
  KAFKA_CONFIG,
  KAFKA_SASL_CONFIG,
  kafkaRemoteBootstrap,
  withWrongPassword,
} from "../support/databases.js";
import {
  dropKafkaFixture,
  KAFKA_COMMANDS,
  KAFKA_FIXTURE_TOPIC,
  kafkaSleep,
  kafkaStreams,
  seedKafkaFixture,
  startKafkaRegistry,
} from "../support/kafkaFixture.js";
import { KAFKA_MANIFEST } from "../support/manifests.js";

const ENABLED = databaseEnabled("kafka");
/** The shared remote cluster has no SASL listener of ours; the local `kafka` service does. */
const LOCAL = kafkaRemoteBootstrap() === null;
const INTERNAL_TOPIC = "__consumer_offsets";
const UNREACHABLE = { bootstrapServers: "127.0.0.1:1", security: "PLAINTEXT" } as const;
const VERSION_ESTIMATE = /^(?:≥ \d+\.\d+|version unknown)$/;

const registry = ENABLED ? await startKafkaRegistry() : null;

async function withKafka(use: (session: Session) => Promise<void>, config: unknown = KAFKA_CONFIG): Promise<void> {
  const session = await kafka.connect(kafka.connectionSchema.parse(config), { readOnly: false });
  try {
    await use(session);
  } finally {
    await session.close();
  }
}

async function rows(session: Session, command: string): Promise<Row[]> {
  const result = await session.execute(command);
  const all: Row[] = [];
  for await (const row of result.rows) all.push(row);
  return all;
}

describe.runIf(ENABLED)("kafka server", () => {
  beforeAll(async () => {
    await seedKafkaFixture();
  });

  afterAll(async () => {
    await dropKafkaFixture();
    await registry?.mock.close();
  });

  runPluginContract(kafka, {
    manifest: KAFKA_MANIFEST,
    config: KAFKA_CONFIG,
    ...(LOCAL ? { wrongPasswordConfig: withWrongPassword(KAFKA_SASL_CONFIG) } : {}),
    statements: { sleep: kafkaSleep },
    commands: KAFKA_COMMANDS,
    streams: kafkaStreams(KAFKA_CONFIG, registry === null ? undefined : { config: registry.config }),
  });

  describe("kafka only", () => {
    it("givenSession_whenConnected_thenServerVersionIsAnEstimate", async () => {
      await withKafka(async (session) => {
        expect(session.serverVersion).toMatch(VERSION_ESTIMATE);
        const info = await session.services.serverInfo?.info(null);
        const cluster = info?.sections.find((section) => section.title === "Cluster");
        expect(cluster?.entries.find((entry) => entry.name === "mode")?.value).toMatch(/^(KRaft|ZooKeeper|Redpanda)$/);
      });
    });

    it("givenInternalTopic_whenListedAndRead_thenPartitionsAndAtMostLimitRows", async () => {
      await withKafka(async (session) => {
        const topics = session.services.topics;
        if (topics === undefined) throw new Error("no topics service");
        const internal = await topics.list({ glob: INTERNAL_TOPIC, internal: true });
        if (internal.length === 0) return;
        expect(internal[0]?.internal).toBe(true);
        expect(internal[0]?.partitions).toBeGreaterThan(0);
        expect(await topics.list({ glob: INTERNAL_TOPIC, internal: false })).toEqual([]);
        const described = await topics.describe(INTERNAL_TOPIC);
        expect(described.partitions.length).toBe(internal[0]?.partitions);
        const read = await rows(session, `consume ${INTERNAL_TOPIC} -p 0,1 --from -1 --limit 2 --value-format hex`);
        expect(read.length).toBeLessThanOrEqual(2);
        expect(
          await session.execute(`produce ${INTERNAL_TOPIC} refused`).catch((error: Error) => error.message),
        ).toMatch(/manages itself/);
      });
    });

    it("givenMessageCommand_whenOffsetPastEnd_thenStatementFailedNamingIt", async () => {
      await withKafka(async (session) => {
        const failure = await session.execute(`message ${KAFKA_FIXTURE_TOPIC} 0 99`).catch((error: Error) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toContain("no message at offset 99");
        const text = await session.execute(`message ${KAFKA_FIXTURE_TOPIC} 0 0`);
        expect(text.reply).toEqual({ value: "hello", text: '"hello"', read: true });
      });
    });

    it("givenConsumeWait_whenNothingArrives_thenReturnsAfterTheWait", async () => {
      await withKafka(async (session) => {
        const started = Date.now();
        expect(await rows(session, `consume ${KAFKA_FIXTURE_TOPIC} --from latest --wait 1`)).toEqual([]);
        expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      });
    });

    it("givenUnreachableBootstrap_whenConnect_thenConnectionFailedNamingServers", async () => {
      const failure = await kafka
        .connect(kafka.connectionSchema.parse(UNREACHABLE), { readOnly: true })
        .catch((error: unknown) => error);
      expect((failure as { code?: unknown }).code).toBe("connectionFailed");
      expect((failure as Error).message).toContain(UNREACHABLE.bootstrapServers);
    });
  });
});
