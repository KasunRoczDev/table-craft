import { describe, expect, it, vi } from "vitest";
import {
  PluginError,
  z,
  type Capability,
  type DatasourcePlugin,
  type ExecuteResult,
  type GroupManager,
  type ResetPreview,
  type Row,
  type SchemaRegistry,
  type Session,
  type TailMessage,
  type TopicBrowser,
  type TopicRead,
  type TopicTail,
  type TopicTailBatch,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import {
  RESULT_FETCH_ALL_CAP,
  RESULT_PAGE_ROWS,
  type EngineResponse,
  type OpenedTopic,
  type TopicTailSummary,
  type TopicTailWindow,
} from "@table-craft/desktop/engine/protocol.js";
import { TopicTailRing } from "@table-craft/desktop/engine/topicTails.js";
import { SILENT_COMMAND_LANGUAGE, withDeclaredServices } from "../support/declaredServices.js";
import { fakeManifest } from "../support/manifests.js";

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const CAPABILITIES: Capability[] = ["commands", "topics", "consumerGroups", "schemaRegistry"];
const READ = {
  topic: "orders",
  partitions: null,
  from: { kind: "latestN", count: 500 },
  limit: 500,
  keyFormat: "auto",
  valueFormat: "auto",
  filter: null,
  maxScan: null,
  resume: null,
} as const;
const RECORD = {
  topic: "orders",
  partition: null,
  key: "k",
  value: '{"id":1}',
  headers: [],
  keyFormat: "string",
  valueFormat: "json",
  keySchema: null,
  valueSchema: null,
} as const;

type Services = Session["services"];

function setup(open: () => Promise<Session>, readOnly = false) {
  const plugin: DatasourcePlugin = {
    id: "kafka-fake",
    capabilities: CAPABILITIES,
    commandLanguage: SILENT_COMMAND_LANGUAGE,
    connectionSchema: z.object({}),
    connect: async () => withDeclaredServices(await open(), CAPABILITIES),
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/kafka-fake",
    manifest: fakeManifest({ id: plugin.id, name: "Kafka fake", capabilities: CAPABILITIES }),
    plugin,
  };
  return createEngine({
    datasource: { id: "k", pluginId: plugin.id, config: {}, readOnly, keepAliveSeconds: 0 },
    plugins: [loaded],
  });
}

function session(services: Services = {}, close: Session["close"] = vi.fn().mockResolvedValue(undefined)): Session {
  return { execute: vi.fn(), serverVersion: null, close, services };
}

function result<T>(response: EngineResponse): T {
  if (response.type === "engine.error") throw new Error(response.error.message);
  return response.result as T;
}

function message(offset: number): TailMessage {
  return {
    partition: 0,
    offset: String(offset),
    timestamp: null,
    key: null,
    value: `v${String(offset)}`,
    headers: [],
    size: 2,
    keySchema: null,
    valueSchema: null,
  };
}

async function* rowsOf(rows: readonly Row[]): AsyncIterable<Row> {
  await Promise.resolve();
  yield* rows;
}

function messages(rows: readonly Row[]): ExecuteResult {
  return {
    columns: [
      { name: "partition", type: null },
      { name: "offset", type: null },
      { name: "value", type: null },
    ],
    rows: rowsOf(rows),
    rowsAffected: null,
  };
}

describe("kafka engine routes", () => {
  it("givenTopicOpened_whenRead_thenRowsHeldInResultStoreAndCountersReturned", async () => {
    const rows: Row[] = [
      [0, { kind: "bigint", value: "41" }, "a"],
      [1, { kind: "bigint", value: "7" }, "b"],
    ];
    const read = vi.fn((): Promise<TopicRead> =>
      Promise.resolve({
        result: messages(rows),
        scanned: "100000",
        matched: "2",
        exhausted: false,
        resume: "cursor-1",
        warnings: ["1 value is not valid JSON and is shown as hex"],
      }),
    );
    const engine = setup(() => Promise.resolve(session({ topics: { read } as unknown as TopicBrowser })));
    const connection = engine.connect();
    const { sessionId } = result<{ sessionId: string }>(await connection.handle({ id: 1, type: "session.open" }));

    const opened = result<OpenedTopic>(
      await connection.handle({ id: 2, type: "topics.open", sessionId, request: READ, ...PAGING }),
    );

    expect(read).toHaveBeenCalledWith(READ);
    expect(opened.read).toEqual({
      scanned: "100000",
      matched: "2",
      exhausted: false,
      resume: "cursor-1",
      warnings: ["1 value is not valid JSON and is shown as hex"],
    });
    expect(opened.statement.firstWindow.rows).toEqual(rows);
    expect(opened.statement.transactionOpen).toBe(false);
    const window = result<{ rows: Row[] }>(
      await connection.handle({ id: 3, type: "result.window", handle: opened.statement.handle, offset: 1, limit: 1 }),
    );
    expect(window.rows).toEqual([rows[1]]);
    await engine.close();
  });

  it("givenReadOnlyDatasource_whenAnyStreamWriteRequested_thenRefusedBeforeTheService", async () => {
    const write = vi.fn();
    const services = {
      topics: {
        produce: write,
        create: write,
        alterConfigs: write,
        addPartitions: write,
        deleteRecordsPrepared: write,
        remove: write,
      } as unknown as TopicBrowser,
      consumerGroups: { applyReset: write, deleteOffsets: write, remove: write } as unknown as GroupManager,
      schemaRegistry: { register: write, compatibility: write, remove: write } as unknown as SchemaRegistry,
    };
    const open = vi.fn(() => Promise.resolve(session(services)));
    const engine = setup(open, true);
    const connection = engine.connect();
    const requests = [
      { type: "topics.produce", record: RECORD },
      {
        type: "topics.create",
        request: { name: "t", partitions: 1, replicationFactor: null, configs: [] },
        validateOnly: true,
      },
      { type: "topics.alterConfigs", topic: "t", changes: [{ name: "retention.ms", value: "1" }], validateOnly: false },
      { type: "topics.addPartitions", topic: "t", total: 3, validateOnly: false },
      { type: "topics.deleteRecords", token: "token" },
      { type: "topics.delete", topic: "t" },
      { type: "groups.applyReset", token: "token" },
      { type: "groups.deleteOffsets", group: "g", topic: "t" },
      { type: "groups.delete", group: "g" },
      { type: "schemas.register", subject: "s", schemaType: "AVRO", schema: '"string"' },
      { type: "schemas.compatibility", subject: "s", level: "FULL" },
      { type: "schemas.delete", subject: "s", version: 1, permanent: false },
    ];
    for (const request of requests)
      expect(await connection.handle({ id: 1, ...request })).toMatchObject({
        type: "engine.error",
        error: { code: "invalidRequest", message: expect.stringContaining("Read-only") as unknown },
      });
    expect(write).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    await engine.close();
  });

  it("givenBrokerRefusal_whenProduced_thenItsWordsShownNotMayHaveCommitted", async () => {
    const produce = vi.fn().mockRejectedValue(new PluginError("statementFailed", "RECORD_TOO_LARGE"));
    const engine = setup(() => Promise.resolve(session({ topics: { produce } as unknown as TopicBrowser })));
    expect(await engine.connect().handle({ id: 1, type: "topics.produce", record: RECORD })).toMatchObject({
      type: "engine.error",
      error: { code: "statementFailed", message: "RECORD_TOO_LARGE" },
    });
    expect(produce).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("givenLostConnection_whenProduced_thenMayHaveCommittedAndNeverReplayed", async () => {
    const produce = vi.fn().mockRejectedValue(new PluginError("connectionLost", "socket closed"));
    const engine = setup(() => Promise.resolve(session({ topics: { produce } as unknown as TopicBrowser })));
    expect(await engine.connect().handle({ id: 1, type: "topics.produce", record: RECORD })).toMatchObject({
      type: "engine.error",
      error: { code: "statementFailed", message: expect.stringContaining("may have committed") as unknown },
    });
    expect(produce).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("givenResetPrepared_whenApplied_thenTokenPassesThroughOnTheSameSession", async () => {
    const preview: ResetPreview = {
      token: "reset-1",
      group: "billing",
      state: "Empty",
      refusal: null,
      partitions: [
        { topic: "orders", partition: 0, current: "10", next: "0", high: "12", lagAfter: "12", change: "-10" },
      ],
      skipped: "0",
      reread: "10",
    };
    const prepareReset = vi.fn().mockResolvedValue(preview);
    const applyReset = vi.fn().mockResolvedValue(undefined);
    const list = vi.fn().mockResolvedValue([]);
    const open = vi.fn(() =>
      Promise.resolve(session({ consumerGroups: { prepareReset, applyReset, list } as unknown as GroupManager })),
    );
    const engine = setup(open);
    const connection = engine.connect();
    const scope = { topic: "orders", partitions: null };
    const target = { kind: "earliest" } as const;

    expect(
      result(await connection.handle({ id: 1, type: "groups.prepareReset", group: "billing", scope, target })),
    ).toEqual(preview);
    result(await connection.handle({ id: 2, type: "groups.list" }));
    expect(result(await connection.handle({ id: 3, type: "groups.applyReset", token: "reset-1" }))).toBeNull();

    expect(prepareReset).toHaveBeenCalledWith("billing", scope, target);
    expect(applyReset).toHaveBeenCalledWith("reset-1");
    expect(prepareReset.mock.contexts[0]).toBe(applyReset.mock.contexts[0]);
    await engine.close();
  });

  it("givenNoRegistryUrl_whenStatusAsked_thenUnavailableWithItsReason", async () => {
    const reason = "No Schema Registry URL is set for this data source";
    const registry = { available: false, reason } as unknown as SchemaRegistry;
    const engine = setup(() => Promise.resolve(session({ schemaRegistry: registry })));
    expect(result(await engine.connect().handle({ id: 1, type: "schemas.status" }))).toEqual({
      available: false,
      reason,
    });
    await engine.close();
  });

  it("givenRunningTail_whenRingOverflows_thenOldestDroppedAndGapReported", async () => {
    let offset = 0;
    const batches: TopicTailBatch[] = [
      { messages: [0, 1, 2, 3, 4].map(() => message(offset++)), state: "live", error: null },
    ];
    const next = vi.fn((): Promise<TopicTailBatch> =>
      Promise.resolve(batches.shift() ?? { messages: [], state: "stopped", error: "Topic was deleted." }),
    );
    const closeTail = vi.fn().mockResolvedValue(undefined);
    const tail: TopicTail = { next, close: closeTail };
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const tailOf = vi.fn().mockResolvedValue(tail);
    const engine = setup(() =>
      Promise.resolve(session({ topics: { tail: tailOf } as unknown as TopicBrowser }, closeSession)),
    );
    const connection = engine.connect();

    const started = result<TopicTailSummary>(
      await connection.handle({
        id: 1,
        type: "topics.tailStart",
        topic: "orders",
        partitions: null,
        from: { kind: "latest" },
        keyFormat: "auto",
        valueFormat: "auto",
        maxMessages: 3,
        maxBytes: 1_000_000,
      }),
    );
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledTimes(1));

    const window = result<TopicTailWindow>(
      await connection.handle({
        id: 2,
        type: "topics.tailWindow",
        tailId: started.tailId,
        after: null,
        count: 10,
        maxBytes: 1_000_000,
      }),
    );
    expect(window.rows.map((row) => row.message.offset)).toEqual(["2", "3", "4"]);
    expect(window).toMatchObject({
      skipped: "2",
      dropped: "2",
      through: "5",
      state: "stopped",
      error: "Topic was deleted.",
    });
    expect(closeTail).toHaveBeenCalledTimes(1);
    await engine.close();
  });

  it("givenPortClosed_whenTailRunning_thenTailAndItsSessionClose", async () => {
    const closeTail = vi.fn().mockResolvedValue(undefined);
    const tail: TopicTail = {
      next: () => new Promise<TopicTailBatch>(() => undefined),
      close: closeTail,
    };
    const closeSession = vi.fn().mockResolvedValue(undefined);
    const engine = setup(() =>
      Promise.resolve(
        session({ topics: { tail: () => Promise.resolve(tail) } as unknown as TopicBrowser }, closeSession),
      ),
    );
    const connection = engine.connect();
    result(
      await connection.handle({
        id: 1,
        type: "topics.tailStart",
        topic: "orders",
        partitions: [0],
        from: { kind: "latest" },
        keyFormat: "auto",
        valueFormat: "auto",
        maxMessages: 10,
        maxBytes: 1_000,
      }),
    );
    await connection.close();
    expect(closeTail).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    await engine.close();
  });
});

describe("topic tail ring", () => {
  it("givenReaderBehind_whenRingDropsBetweenWindows_thenSkippedCountsOnlyWhatItMissed", () => {
    const ring = new TopicTailRing(2, 1_000_000);
    ring.append(message(0));
    const first = ring.window(null, 10, 1_000_000);
    expect(first).toMatchObject({ skipped: "0", through: "1" });
    for (const offset of [1, 2, 3, 4]) ring.append(message(offset));

    const second = ring.window(first.through, 10, 1_000_000);

    expect(second.rows.map((row) => row.message.offset)).toEqual(["3", "4"]);
    expect(second).toMatchObject({ skipped: "2", through: "5" });
    expect(ring.droppedTotal()).toBe("3");
  });

  it("givenCleared_whenWindowRead_thenClearedMessagesNeverCountAsSkipped", () => {
    const ring = new TopicTailRing(10, 1_000_000);
    for (const offset of [0, 1, 2]) ring.append(message(offset));
    ring.clear();
    ring.append(message(3));

    const window = ring.window(null, 10, 1_000_000);

    expect(window.rows.map((row) => row.message.offset)).toEqual(["3"]);
    expect(window).toMatchObject({ skipped: "0", through: "4" });
  });

  it("givenMessageLargerThanRing_whenAppended_thenDroppedAndShownAsGap", () => {
    const ring = new TopicTailRing(10, 400);
    ring.append({ ...message(0), value: "x".repeat(1_000) });
    ring.append(message(1));

    const window = ring.window(null, 10, 1_000_000);

    expect(window.rows.map((row) => row.message.offset)).toEqual(["1"]);
    expect(window).toMatchObject({ skipped: "1", through: "2" });
  });

  it("givenLargeMessagesPastTheByteCap_whenManyArrive_thenDroppedOnesAreNotKept", () => {
    const ring = new TopicTailRing(100_000, 5_000);
    for (let offset = 0; offset < 10_000; offset += 1) ring.append({ ...message(offset), value: "x".repeat(1_000) });

    expect(ring.referenced()).toBeLessThanOrEqual(10);
    expect(ring.window(null, 10, 1_000_000).rows.at(-1)?.message.offset).toBe("9999");
  });
});
