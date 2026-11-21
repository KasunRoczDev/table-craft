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
/** Java's murmur2 of "foobar" is -790332482 (Kafka's UtilsTest): `& 0x7fffffff` % 3 is 0, `>>> 0` % 3 is 2. */
const JAVA_KEY = "foobar";
const JAVA_KEY_PARTITION = 0;

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
        let internal = await topics.list({ glob: INTERNAL_TOPIC, internal: true });
        if (internal.length === 0) {
          // The broker makes the offsets topic on the first commit it stores.
          const group = `${KAFKA_FIXTURE_TOPIC}_offsets_group`;
          await kafkaStreams().commitOffsets?.(group, KAFKA_FIXTURE_TOPIC, [{ partition: 0, offset: "0" }]);
          await session.services.consumerGroups?.remove(group);
          internal = await topics.list({ glob: INTERNAL_TOPIC, internal: true });
        }
        expect(internal).toHaveLength(1);
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
        expect(await session.services.consumerGroups?.consumersOf(KAFKA_FIXTURE_TOPIC)).toEqual([]);
      });
    });

    it("givenKeyedRecord_whenProduced_thenJavaPartitionAndPastTheEndRefused", async () => {
      await withKafka(async (session) => {
        const topics = session.services.topics;
        if (topics === undefined) throw new Error("no topics service");
        const topic = `${KAFKA_FIXTURE_TOPIC}_keyed`;
        await topics.create({ name: topic, partitions: 3, replicationFactor: 1, configs: [] }, { validateOnly: false });
        try {
          const record = {
            topic,
            partition: null,
            key: JAVA_KEY,
            keyFormat: "string",
            keySchema: null,
            value: "v",
            valueFormat: "string",
            valueSchema: null,
            headers: [],
          } as const;
          expect((await topics.produce(record)).partition).toBe(JAVA_KEY_PARTITION);
          await expect(topics.produce({ ...record, partition: 3 })).rejects.toThrow(/there is no partition 3/);
        } finally {
          await topics.remove(topic);
        }
      });
    });

    it("givenDeletedTopic_whenAnotherTopicRead_thenStillReads", async () => {
      await withKafka(async (session) => {
        const topics = session.services.topics;
        if (topics === undefined) throw new Error("no topics service");
        const doomed = `${KAFKA_FIXTURE_TOPIC}_doomed`;
        await topics.create(
          { name: doomed, partitions: 1, replicationFactor: 1, configs: [] },
          { validateOnly: false },
        );
        await rows(session, `consume ${doomed} --from earliest --limit 1`);
        await topics.remove(doomed);
        expect(await rows(session, `consume ${KAFKA_FIXTURE_TOPIC} --from earliest --limit 1`)).toHaveLength(1);
      });
    });

    it("givenTwoReadsAtOnce_whenRead_thenBothAnswerOnTheirOwnFetchers", async () => {
      await withKafka(async (session) => {
        const topics = session.services.topics;
        if (topics === undefined) throw new Error("no topics service");
        const request = {
          topic: KAFKA_FIXTURE_TOPIC,
          partitions: null,
          from: { kind: "earliest" },
          limit: 1,
          keyFormat: "string",
          valueFormat: "string",
          filter: null,
          maxScan: null,
          resume: null,
        } as const;
        const reads = await Promise.all([topics.read(request), topics.read(request)]);
        for (const read of reads) {
          const all: Row[] = [];
          for await (const row of read.result.rows) all.push(row);
          expect(all).toHaveLength(1);
        }
        expect((session as unknown as { fetcherCount: number }).fetcherCount).toBe(1);
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
