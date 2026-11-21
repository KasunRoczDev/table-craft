import { describe, expect, it } from "vitest";
import {
  isPluginError,
  MESSAGE_PREVIEW_CHARS,
  type DatasourcePlugin,
  type GroupManager,
  type MessageFormat,
  type MessageSpill,
  type SpilledMessage,
  type PluginErrorCode,
  type Row,
  type SchemaRegistry,
  type Session,
  type TopicBrowser,
  type TopicRead,
  type TopicReadRequest,
  type TopicStart,
  type WireValue,
} from "@table-craft/plugin-api";

/**
 * What a plugin declaring `topics`, `consumerGroups` or `schemaRegistry` needs to run its gated
 * contract cases (plan 164). Every case makes its own `${scratchPrefix}<random>` topic, group or
 * subject through the plugin and removes it at the end, so the cases may run against a shared
 * cluster that holds other people's topics.
 */
export interface StreamsFixture {
  /** Every topic, group and subject a case creates starts with it, such as `tc_run_`. */
  readonly scratchPrefix: string;
  /** Partitions of each scratch topic, at least 2; 3 by default. */
  readonly partitions?: number;
  /** Replicas of each scratch topic; null for the broker's default, the default. */
  readonly replicationFactor?: number | null;
  /**
   * Commits `offsets` for `group` on `topic` from outside the plugin, as a consumer would; the
   * group cases that need committed offsets skip without it.
   */
  readonly commitOffsets?: (
    group: string,
    topic: string,
    offsets: readonly { readonly partition: number; readonly offset: string }[],
  ) => Promise<void>;
  /**
   * Starts a consumer that joins `group` subscribed to `topic` and stays a member until the
   * returned function is called; the active-group case skips without it.
   */
  readonly joinGroup?: (group: string, topic: string) => Promise<() => Promise<void>>;
  /** A configuration of the same cluster with a Schema Registry; the registry cases skip without it. */
  readonly registry?: { readonly config: unknown };
}

/** What the streams cases need from the main contract. */
export interface StreamsContract {
  readonly plugin: DatasourcePlugin;
  readonly config: unknown;
  readonly streams: StreamsFixture | undefined;
}

const DEFAULT_PARTITIONS = 3;
const RANDOM_RADIX = 36;
const RANDOM_LENGTH = 10;
const READ_LIMIT = 500;
/** A large message is this many previews long. */
const LARGE_MESSAGE_PREVIEWS = 3;
const PRODUCE_GAP_MS = 5;
const TAIL_COUNT = 10;
const TAIL_BYTES = 1 << 20;
const TAIL_WAIT_MS = 1000;
const TAIL_ATTEMPTS = 10;
const RETENTION_KEY = "retention.ms";
const RETENTION_VALUE = "3600000";
const DEFAULT_SOURCE = "DEFAULT_CONFIG";
const DELETE_BEFORE = "2";
const GROUP_REMOVE_ATTEMPTS = 20;
const GROUP_REMOVE_GAP_MS = 500;
const WRITABLE = { readOnly: false } as const;
const READ_ONLY = { readOnly: true } as const;
const ORDER_V1 = JSON.stringify({
  type: "record",
  name: "ContractOrder",
  fields: [
    { name: "id", type: "string" },
    { name: "amount", type: "long" },
  ],
});
const ORDER_V2 = JSON.stringify({
  type: "record",
  name: "ContractOrder",
  fields: [
    { name: "id", type: "string" },
    { name: "amount", type: "long" },
    { name: "currency", type: "string", default: "EUR" },
  ],
});
const ORDER_BREAKING = JSON.stringify({
  type: "record",
  name: "ContractOrder",
  fields: [
    { name: "id", type: "string" },
    { name: "region", type: "string" },
  ],
});
/** The `value` column of `TOPIC_MESSAGE_COLUMNS`. */
const VALUE_COLUMN = 4;
const PARTITION_COLUMN = 0;
const KEY_COLUMN = 3;
const VALUE_SCHEMA_COLUMN = 8;
const TIMESTAMP_COLUMN = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collect(rows: AsyncIterable<Row>): Promise<Row[]> {
  const all: Row[] = [];
  for await (const row of rows) all.push(row);
  return all;
}

async function rejectionCode(pending: Promise<unknown>): Promise<PluginErrorCode | "notAPluginError" | "resolved"> {
  try {
    await pending;
    return "resolved";
  } catch (error) {
    return isPluginError(error) ? error.code : "notAPluginError";
  }
}

function isoOf(cell: WireValue | undefined): string {
  return typeof cell === "object" && cell !== null && cell.kind === "date" ? cell.iso : "";
}

/** The streams cases, gated on each capability the plugin declares (plan 164). */
export function runStreamsContract(contract: StreamsContract): void {
  const { plugin, streams } = contract;
  const declares = (capability: "topics" | "consumerGroups" | "schemaRegistry"): boolean =>
    plugin.capabilities.includes(capability);

  function fixture(): StreamsFixture {
    if (streams === undefined) throw new Error("A plugin that declares topics needs fixture.streams.");
    return streams;
  }

  function scratch(suffix = ""): string {
    const random = Math.random().toString(RANDOM_RADIX).slice(2).padEnd(RANDOM_LENGTH, "0").slice(0, RANDOM_LENGTH);
    return `${fixture().scratchPrefix}${String(Date.now())}_${random}${suffix}`;
  }

  async function withSession(
    use: (session: Session) => Promise<void>,
    config: unknown = contract.config,
    options: { readonly readOnly: boolean } = WRITABLE,
  ): Promise<void> {
    const session = await plugin.connect(plugin.connectionSchema.parse(config), options);
    try {
      await use(session);
    } finally {
      await session.close();
    }
  }

  function topicsOf(session: Session): TopicBrowser {
    const found = session.services.topics;
    if (found === undefined) throw new Error("The session has no topics service.");
    return found;
  }

  function groupsOf(session: Session): GroupManager {
    const found = session.services.consumerGroups;
    if (found === undefined) throw new Error("The session has no consumerGroups service.");
    return found;
  }

  function registryOf(session: Session): SchemaRegistry {
    const found = session.services.schemaRegistry;
    if (found === undefined) throw new Error("The session has no schemaRegistry service.");
    return found;
  }

  /** Creates a scratch topic, runs `use`, and removes the topic whatever happened. */
  async function withTopic(session: Session, use: (topic: string) => Promise<void>): Promise<void> {
    const topics = topicsOf(session);
    const topic = scratch();
    await topics.create(
      {
        name: topic,
        partitions: fixture().partitions ?? DEFAULT_PARTITIONS,
        replicationFactor: fixture().replicationFactor ?? null,
        configs: [],
      },
      { validateOnly: false },
    );
    try {
      await use(topic);
    } finally {
      await topics.remove(topic).catch(() => undefined);
    }
  }

  async function produce(
    session: Session,
    topic: string,
    partition: number | null,
    value: string,
    key: string | null = null,
    format: MessageFormat = "string",
  ): Promise<{ partition: number; offset: string | null }> {
    const sent = await topicsOf(session).produce({
      topic,
      partition,
      key,
      value,
      headers: [],
      keyFormat: "string",
      valueFormat: format,
      keySchema: null,
      valueSchema: null,
    });
    await delay(PRODUCE_GAP_MS);
    return sent;
  }

  function request(topic: string, from: TopicStart, overrides: Partial<TopicReadRequest> = {}): TopicReadRequest {
    return {
      topic,
      partitions: null,
      from,
      limit: READ_LIMIT,
      keyFormat: "auto",
      valueFormat: "auto",
      filter: null,
      maxScan: null,
      resume: null,
      ...overrides,
    };
  }

  async function readRows(read: Promise<TopicRead>): Promise<Row[]> {
    return collect((await read).result.rows);
  }

  async function removeGroup(session: Session, group: string): Promise<void> {
    for (let attempt = 0; attempt < GROUP_REMOVE_ATTEMPTS; attempt += 1) {
      try {
        await groupsOf(session).remove(group);
        return;
      } catch {
        const listed = await groupsOf(session)
          .list()
          .catch(() => []);
        if (!listed.some((summary) => summary.id === group)) return;
        await delay(GROUP_REMOVE_GAP_MS);
      }
    }
  }

  describe.runIf(declares("topics"))("topics", () => {
    it("givenTopics_whenList_thenInternalOnlyWhenAsked", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          const plain = await topicsOf(session).list({ glob: null, internal: false });
          const all = await topicsOf(session).list({ glob: null, internal: true });
          expect(plain.some((summary) => summary.internal)).toBe(false);
          expect(plain.map((summary) => summary.name)).toContain(topic);
          expect(all.map((summary) => summary.name)).toEqual(expect.arrayContaining(plain.map((s) => s.name)));
          const globbed = await topicsOf(session).list({ glob: topic, internal: false });
          expect(globbed.map((summary) => summary.name)).toEqual([topic]);
        });
      });
    });

    it("givenTopic_whenDescribe_thenPartitionsWatermarksAndConfigs", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          for (const value of ["a", "b", "c"]) await produce(session, topic, 0, value);
          const described = await topicsOf(session).describe(topic);
          expect(described.name).toBe(topic);
          expect(described.partitions.map((partition) => partition.partition)).toEqual(
            Array.from({ length: fixture().partitions ?? DEFAULT_PARTITIONS }, (_, index) => index),
          );
          expect(described.partitions[0]).toMatchObject({ low: "0", high: "3" });
          for (const partition of described.partitions) expect(partition.leader).not.toBeNull();
          expect(described.messages).toBe("3");
          expect(described.configs.map((config) => config.name)).toContain(RETENTION_KEY);
          for (const config of described.configs.filter((entry) => entry.sensitive)) expect(config.value).toBeNull();
        });
      });
    });

    it("givenProducedAcrossPartitions_whenReadLatestN_thenNewestNInTimestampOrder", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          const values = ["m0", "m1", "m2", "m3", "m4", "m5"];
          for (const [index, value] of values.entries()) await produce(session, topic, index % 2, value);
          const rows = await readRows(topicsOf(session).read(request(topic, { kind: "latestN", count: 4 })));
          expect(rows.map((row) => row[VALUE_COLUMN])).toEqual(values.slice(2));
          const times = rows.map((row) => isoOf(row[TIMESTAMP_COLUMN]));
          expect(times).toEqual([...times].sort());
        });
      });
    });

    it("givenSpill_whenLargeMessageRead_thenPreviewKeptAndWholeValuePutOrWholeRow", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          const large = "v".repeat(MESSAGE_PREVIEW_CHARS * LARGE_MESSAGE_PREVIEWS);
          await produce(session, topic, 0, large);
          await produce(session, topic, 0, "small");
          const spilled = new Map<string, SpilledMessage>();
          const spill: MessageSpill = {
            put: (partition, offset, message) => {
              spilled.set(`${String(partition)}:${offset}`, message);
              return Promise.resolve();
            },
          };
          const rows = await readRows(topicsOf(session).read(request(topic, { kind: "earliest" }), spill));
          expect(rows.map((row) => row[VALUE_COLUMN])).toHaveLength(2);
          expect(rows[1]?.[VALUE_COLUMN]).toBe("small");
          expect(spilled.has("0:1")).toBe(false);
          const shown = rows[0]?.[VALUE_COLUMN];
          if (spilled.size === 0) expect(shown).toBe(large);
          else {
            expect(typeof shown === "string" && shown.length <= MESSAGE_PREVIEW_CHARS + 1).toBe(true);
            expect(spilled.get("0:0")?.value).toBe(large);
          }
        });
      });
    });

    it("givenTimestamp_whenRead_thenFirstRowAtOrAfterIt", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          await produce(session, topic, 0, "before-1");
          await produce(session, topic, 1, "before-2");
          await delay(PRODUCE_GAP_MS * 4);
          const mark = new Date().toISOString();
          await delay(PRODUCE_GAP_MS * 4);
          await produce(session, topic, 0, "after-1");
          await produce(session, topic, 1, "after-2");
          const rows = await readRows(topicsOf(session).read(request(topic, { kind: "timestamp", timestamp: mark })));
          expect(rows.map((row) => row[VALUE_COLUMN])).toEqual(["after-1", "after-2"]);
          for (const row of rows) expect(isoOf(row[TIMESTAMP_COLUMN]) >= mark).toBe(true);
        });
      });
    });

    it("givenKeyFilter_whenRead_thenOnlyMatchesAndScannedCount", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          for (let index = 1; index <= 5; index += 1) {
            await produce(session, topic, index % 2, `value-${String(index)}`, `cust-${String(index)}`);
          }
          const read = await topicsOf(session).read(request(topic, { kind: "earliest" }, { filter: "cust-3" }));
          const rows = await collect(read.result.rows);
          expect(rows.map((row) => row[KEY_COLUMN])).toEqual(["cust-3"]);
          expect(read.scanned).toBe("5");
          expect(read.matched).toBe("1");
          expect(read.exhausted).toBe(true);
          const regex = await readRows(
            topicsOf(session).read(request(topic, { kind: "earliest" }, { filter: "/^VALUE-[12]$/i" })),
          );
          expect(regex.map((row) => row[VALUE_COLUMN])).toEqual(["value-1", "value-2"]);
        });
      });
    });

    it("givenMaxScanReached_whenRead_thenNotExhaustedAndScanFurtherContinues", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          for (let index = 0; index < 5; index += 1) await produce(session, topic, 0, `v${String(index)}`);
          const first = await topicsOf(session).read(request(topic, { kind: "earliest" }, { maxScan: 2 }));
          expect(first.scanned).toBe("2");
          expect(first.exhausted).toBe(false);
          expect(first.resume).not.toBeNull();
          const firstRows = await collect(first.result.rows);
          const further = await topicsOf(session).read(
            request(topic, { kind: "earliest" }, { maxScan: READ_LIMIT, resume: first.resume }),
          );
          expect(further.exhausted).toBe(true);
          expect(further.resume).toBeNull();
          const rest = await collect(further.result.rows);
          expect([...firstRows, ...rest].map((row) => row[VALUE_COLUMN])).toEqual(["v0", "v1", "v2", "v3", "v4"]);
        });
      });
    });

    it("givenRecord_whenProduce_thenPartitionAndOffsetReturnedAndReadable", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          expect(await produce(session, topic, 1, "first", "k")).toEqual({ partition: 1, offset: "0" });
          expect(await produce(session, topic, 1, "second", "k")).toEqual({ partition: 1, offset: "1" });
          const rows = await readRows(
            topicsOf(session).read(request(topic, { kind: "offset", offset: "1" }, { partitions: [1] })),
          );
          expect(rows.map((row) => [row[PARTITION_COLUMN], row[KEY_COLUMN], row[VALUE_COLUMN]])).toEqual([
            [1, "k", "second"],
          ]);
        });
      });
    });

    it("givenReadOnly_whenProduce_thenStatementFailedAndNothingSent", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          await withSession(
            async (readOnly) => {
              expect(await rejectionCode(produce(readOnly, topic, 0, "refused"))).toBe("statementFailed");
            },
            contract.config,
            READ_ONLY,
          );
          expect(await readRows(topicsOf(session).read(request(topic, { kind: "earliest" })))).toEqual([]);
        });
      });
    });

    it("givenCreateTopic_whenValidateOnly_thenNothingCreated", async () => {
      await withSession(async (session) => {
        const topic = scratch();
        await topicsOf(session).create(
          { name: topic, partitions: 1, replicationFactor: fixture().replicationFactor ?? null, configs: [] },
          { validateOnly: true },
        );
        expect(await topicsOf(session).list({ glob: topic, internal: false })).toEqual([]);
        const refused = topicsOf(session).create(
          { name: topic, partitions: 0, replicationFactor: null, configs: [] },
          { validateOnly: true },
        );
        expect(await rejectionCode(refused)).toBe("statementFailed");
      });
    });

    it("givenConfigChange_whenAlter_thenDescribeShowsNewValueAndSource", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          const topics = topicsOf(session);
          const change = [{ name: RETENTION_KEY, value: RETENTION_VALUE }];
          await topics.alterConfigs(topic, change, { validateOnly: true });
          const unchanged = (await topics.describe(topic)).configs.find((config) => config.name === RETENTION_KEY);
          expect(unchanged?.value).not.toBe(RETENTION_VALUE);
          await topics.alterConfigs(topic, change, { validateOnly: false });
          const altered = (await topics.describe(topic)).configs.find((config) => config.name === RETENTION_KEY);
          expect(altered).toMatchObject({ value: RETENTION_VALUE, isDefault: false });
          expect(altered?.source).not.toBe(DEFAULT_SOURCE);
          await topics.alterConfigs(topic, [{ name: RETENTION_KEY, value: null }], { validateOnly: false });
          const reset = (await topics.describe(topic)).configs.find((config) => config.name === RETENTION_KEY);
          expect(reset?.isDefault).toBe(true);
        });
      });
    });

    it("givenDeleteRecords_whenPreparedAndApplied_thenLowWatermarkMoved", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          const topics = topicsOf(session);
          for (const value of ["a", "b", "c"]) await produce(session, topic, 0, value);
          const preview = await topics.prepareDeleteRecords(topic, [0], { kind: "offset", offset: DELETE_BEFORE });
          expect(preview.partitions).toEqual([
            { partition: 0, low: "0", newLow: DELETE_BEFORE, high: "3", removed: "2" },
          ]);
          expect(preview.removed).toBe("2");
          expect((await topics.describe(topic)).partitions[0]?.low).toBe("0");
          await topics.deleteRecordsPrepared(preview.token);
          expect((await topics.describe(topic)).partitions[0]?.low).toBe(DELETE_BEFORE);
          expect(await rejectionCode(topics.deleteRecordsPrepared(preview.token))).toBe("statementFailed");
          const rows = await readRows(topics.read(request(topic, { kind: "earliest" })));
          expect(rows.map((row) => row[VALUE_COLUMN])).toEqual(["c"]);
        });
      });
    });

    it("givenTail_whenProducedAfterOpen_thenBatchHoldsIt", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          await produce(session, topic, 0, "old");
          const tail = await topicsOf(session).tail({
            topic,
            partitions: null,
            from: { kind: "latest" },
            keyFormat: "auto",
            valueFormat: "auto",
          });
          try {
            await produce(session, topic, 1, "live", "tail-key");
            const seen: string[] = [];
            for (let attempt = 0; attempt < TAIL_ATTEMPTS && seen.length === 0; attempt += 1) {
              const batch = await tail.next({ count: TAIL_COUNT, maxBytes: TAIL_BYTES, timeoutMs: TAIL_WAIT_MS });
              expect(batch.state).not.toBe("stopped");
              seen.push(...batch.messages.map((message) => `${message.key ?? ""}=${message.value ?? ""}`));
            }
            expect(seen).toEqual(["tail-key=live"]);
          } finally {
            await tail.close();
          }
          const closed = await tail.next({ count: TAIL_COUNT, maxBytes: TAIL_BYTES, timeoutMs: 0 });
          expect(closed.state).toBe("stopped");
        });
      });
    });

    it("givenRemovedTopic_whenListed_thenGone", async () => {
      await withSession(async (session) => {
        let removed = "";
        await withTopic(session, async (topic) => {
          removed = topic;
          await topicsOf(session).remove(topic);
        });
        expect(await topicsOf(session).list({ glob: removed, internal: false })).toEqual([]);
        expect(await rejectionCode(topicsOf(session).describe(removed))).toBe("statementFailed");
      });
    });
  });

  describe.runIf(declares("topics") && declares("consumerGroups"))("consumerGroups", () => {
    const commitOffsets = streams?.commitOffsets;
    const joinGroup = streams?.joinGroup;

    it("givenRead_whenConsumersOfTopic_thenNoGroupCreated", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          await produce(session, topic, 0, "browse");
          await readRows(topicsOf(session).read(request(topic, { kind: "earliest" })));
          await readRows(topicsOf(session).read(request(topic, { kind: "latestN", count: 1 })));
          expect(await groupsOf(session).consumersOf(topic)).toEqual([]);
        });
      });
    });

    it.runIf(commitOffsets !== undefined)("givenCommittedGroup_whenDescribe_thenLagPerPartition", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          const group = scratch("_group");
          for (const value of ["a", "b", "c"]) await produce(session, topic, 0, value);
          for (const value of ["d", "e"]) await produce(session, topic, 1, value);
          try {
            await commitOffsets?.(group, topic, [
              { partition: 0, offset: "1" },
              { partition: 1, offset: "2" },
            ]);
            const described = await groupsOf(session).describe(group);
            expect(described.members).toEqual([]);
            expect(
              described.offsets.map(({ partition, committed, high, lag }) => ({ partition, committed, high, lag })),
            ).toEqual([
              { partition: 0, committed: "1", high: "3", lag: "2" },
              { partition: 1, committed: "2", high: "2", lag: "0" },
            ]);
            expect(described.lag).toBe("2");
            const consumers = await groupsOf(session).consumersOf(topic);
            expect(consumers.map((summary) => [summary.id, summary.lag])).toEqual([[group, "2"]]);
          } finally {
            await removeGroup(session, group);
          }
        });
      });
    });

    it.runIf(commitOffsets !== undefined)(
      "givenEmptyGroup_whenResetToTimestamp_thenPreviewThenCommittedOffsetsMatch",
      async () => {
        await withSession(async (session) => {
          await withTopic(session, async (topic) => {
            const group = scratch("_group");
            await produce(session, topic, 0, "early-1");
            await produce(session, topic, 0, "early-2");
            await delay(PRODUCE_GAP_MS * 4);
            const mark = new Date().toISOString();
            await delay(PRODUCE_GAP_MS * 4);
            await produce(session, topic, 0, "late-1");
            await produce(session, topic, 0, "late-2");
            try {
              await commitOffsets?.(group, topic, [{ partition: 0, offset: "4" }]);
              const groups = groupsOf(session);
              const preview = await groups.prepareReset(
                group,
                { topic, partitions: [0] },
                { kind: "timestamp", timestamp: mark },
              );
              expect(preview.refusal).toBeNull();
              expect(preview.token).not.toBeNull();
              expect(preview.partitions).toEqual([
                { topic, partition: 0, current: "4", next: "2", high: "4", lagAfter: "2", change: "-2" },
              ]);
              expect(preview.reread).toBe("2");
              expect((await groups.describe(group)).offsets[0]?.committed).toBe("4");
              await groups.applyReset(preview.token ?? "");
              expect((await groups.describe(group)).offsets.map((offset) => offset.committed)).toEqual(["2"]);
              expect(await rejectionCode(groups.applyReset(preview.token ?? ""))).toBe("statementFailed");
            } finally {
              await removeGroup(session, group);
            }
          });
        });
      },
    );

    it.runIf(joinGroup !== undefined)("givenActiveGroup_whenPrepareReset_thenRefusedNamingMembers", async () => {
      await withSession(async (session) => {
        await withTopic(session, async (topic) => {
          const group = scratch("_group");
          await produce(session, topic, 0, "a");
          const leave = await joinGroup?.(group, topic);
          try {
            const preview = await groupsOf(session).prepareReset(
              group,
              { topic, partitions: null },
              { kind: "earliest" },
            );
            expect(preview.token).toBeNull();
            expect(preview.refusal).toMatch(/\b1 member\b|\bmembers?\b.*\bactive\b/);
            expect((await groupsOf(session).describe(group)).members.length).toBeGreaterThan(0);
            expect(await rejectionCode(groupsOf(session).remove(group))).toBe("statementFailed");
          } finally {
            await leave?.();
            await removeGroup(session, group);
          }
        });
      });
    });
  });

  describe.runIf(declares("schemaRegistry"))("schemaRegistry", () => {
    const registryConfig = streams?.registry?.config;

    async function withSubject(registry: SchemaRegistry, subject: string, use: () => Promise<void>): Promise<void> {
      try {
        await use();
      } finally {
        await registry.remove(subject, null, false).catch(() => undefined);
        await registry.remove(subject, null, true).catch(() => undefined);
      }
    }

    it("givenAnyConfig_whenSchemaRegistry_thenAvailableOrReasoned", async () => {
      await withSession(async (session) => {
        const registry = registryOf(session);
        if (registry.available) {
          expect(registry.reason).toBeNull();
          return;
        }
        expect(registry.reason).toMatch(/\S/);
        expect(await rejectionCode(registry.subjects(null))).toBe("statementFailed");
      });
    });

    it.runIf(registryConfig !== undefined)("givenSubjects_whenVersions_thenBothVersionsAndCompatibility", async () => {
      await withSession(async (session) => {
        const registry = registryOf(session);
        expect(registry.available).toBe(true);
        const subject = scratch("-value");
        await withSubject(registry, subject, async () => {
          const first = await registry.register(subject, "AVRO", ORDER_V1);
          const second = await registry.register(subject, "AVRO", ORDER_V2);
          expect(second.id).not.toBe(first.id);
          expect(await registry.versions(subject)).toEqual([1, 2]);
          expect(await registry.subjects(subject)).toEqual([{ subject, latestVersion: 2, type: "AVRO" }]);
          expect(await registry.get(subject, null)).toMatchObject({ subject, version: 2, id: second.id, type: "AVRO" });
          expect(await registry.get(subject, 1)).toMatchObject({ version: 1, id: first.id });
          expect(await registry.compatibility(subject, null)).toMatch(/^[A-Z_]+$/);
        });
      }, registryConfig);
    });

    it.runIf(registryConfig !== undefined)("givenIncompatibleSchema_whenCheck_thenRegistryMessages", async () => {
      await withSession(async (session) => {
        const registry = registryOf(session);
        const subject = scratch("-value");
        await withSubject(registry, subject, async () => {
          await registry.register(subject, "AVRO", ORDER_V1);
          expect((await registry.check(subject, "AVRO", ORDER_V2)).compatible).toBe(true);
          const check = await registry.check(subject, "AVRO", ORDER_BREAKING);
          expect(check.compatible).toBe(false);
          expect(check.messages.length).toBeGreaterThan(0);
        });
      }, registryConfig);
    });

    it.runIf(registryConfig !== undefined && declares("topics"))(
      "givenAvroSubject_whenProduceInvalidValue_thenRefusedBeforeSend",
      async () => {
        await withSession(async (session) => {
          await withTopic(session, async (topic) => {
            const registry = registryOf(session);
            const subject = `${topic}-value`;
            await withSubject(registry, subject, async () => {
              const { id } = await registry.register(subject, "AVRO", ORDER_V1);
              const invalid = produce(session, topic, 0, '{"id":"o-1","amount":"lots"}', null, "avro");
              expect(await rejectionCode(invalid)).toBe("statementFailed");
              expect(await readRows(topicsOf(session).read(request(topic, { kind: "earliest" })))).toEqual([]);
              await produce(session, topic, 0, '{"id":"o-2","amount":7}', null, "avro");
              const rows = await readRows(topicsOf(session).read(request(topic, { kind: "earliest" })));
              expect(rows).toHaveLength(1);
              expect(rows[0]?.[VALUE_COLUMN]).toEqual({ kind: "json", text: '{"id":"o-2","amount":7}' });
              expect(rows[0]?.[VALUE_SCHEMA_COLUMN]).toEqual(expect.stringContaining(String(id)));
            });
          });
        }, registryConfig);
      },
    );
  });
}
