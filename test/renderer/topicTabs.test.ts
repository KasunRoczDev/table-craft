import { describe, expect, it, vi } from "vitest";
import type {
  ExecutedStatement,
  OpenedSession,
  OpenedTopic,
  TopicDescription,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  DEFAULT_DRAFT,
  durationText,
  footerAction,
  instantOf,
  NO_GROUP_TEXT,
  parsePartitions,
  partitionCounts,
  readCommandText,
  readRequestOf,
  scannedScope,
  scannedText,
  toggledPartition,
} from "@table-craft/desktop/renderer/model/topicRead.js";
import { createTopicTabsStore } from "@table-craft/desktop/renderer/state/topicTabs.js";

const TARGET = { datasourceId: "kafka", topic: "orders.v1" };

const DESCRIPTION: TopicDescription = {
  name: "orders.v1",
  id: null,
  internal: false,
  partitions: [0, 1, 2].map((partition) => ({
    partition,
    leader: 1,
    replicas: [1, 2, 3],
    isr: partition === 2 ? [1, 2] : [1, 2, 3],
    offline: [],
    low: "0",
    high: "100",
    bytes: null,
  })),
  configs: [
    {
      name: "retention.ms",
      value: "259200000",
      source: "Topic",
      isDefault: false,
      sensitive: false,
      readOnly: false,
      documentation: null,
    },
  ],
  messages: "300",
};

function statement(handle: string): ExecutedStatement {
  return {
    handle,
    columns: [
      { name: "partition", type: "int" },
      { name: "offset", type: "bigint" },
      { name: "value", type: "string" },
    ],
    typeClasses: ["integer", "integer", "text"],
    rowCount: 3,
    complete: true,
    cursorOpen: false,
    rowsAffected: null,
    firstWindow: {
      offset: 0,
      rows: [
        [0, { kind: "bigint", value: "7" }, "a"],
        [2, { kind: "bigint", value: "9" }, "b"],
        [2, { kind: "bigint", value: "10" }, "c"],
      ],
    },
    transactionOpen: false,
  };
}

function topicEngine(resume: string | null = "r1") {
  let reads = 0;
  const call = vi.fn((type: string, _params?: unknown): Promise<unknown> => {
    if (type === "session.open") {
      const opened: OpenedSession = {
        sessionId: "s1",
        pluginName: "Kafka",
        capabilities: ["commands", "topics"],
        serverVersion: "4.1",
        serverBrand: null,
        namespace: null,
        serverTimeout: null,
        cancelReach: null,
      };
      return Promise.resolve(opened);
    }
    if (type === "topics.describe") return Promise.resolve(DESCRIPTION);
    if (type === "groups.consumersOf") return Promise.resolve([]);
    if (type === "topics.open") {
      reads += 1;
      const opened: OpenedTopic = {
        read: { scanned: "100000", matched: "3", exhausted: resume === null, resume, warnings: [] },
        statement: statement(`h${String(reads)}`),
      };
      return Promise.resolve(opened);
    }
    return Promise.resolve(null);
  });
  return { client: { call } as unknown as EngineClient, call };
}

/** The params of every `topics.open` the engine got, in order. */
function opens(engine: ReturnType<typeof topicEngine>): readonly unknown[] {
  return engine.call.mock.calls.filter(([type]) => type === "topics.open").map(([, params]) => params);
}

function store(engine: ReturnType<typeof topicEngine>, capabilities: readonly string[] = ["topics"]) {
  return createTopicTabsStore({
    connect: () => Promise.resolve(engine.client),
    capabilities: () => capabilities as never,
  });
}

describe("topic tabs", () => {
  it("givenTopic_whenOpened_thenDescribedAndLatest500Read", async () => {
    const engine = topicEngine();
    const tabs = store(engine);
    await tabs.getState().open("topic-0", TARGET);
    const tab = tabs.getState().tabs["topic-0"];
    expect(tab).toMatchObject({ status: "ready", description: DESCRIPTION, consumers: null });
    expect(tab?.result?.windows[0]).toHaveLength(3);
    expect(opens(engine)[0]).toMatchObject({
      sessionId: "s1",
      request: { topic: "orders.v1", from: { kind: "latestN", count: 500 }, limit: 500 },
    });
  });

  it("givenSpillSetting_whenRead_thenSentAndMessageAskedOfTheResult", async () => {
    const engine = topicEngine();
    const tabs = createTopicTabsStore({
      connect: () => Promise.resolve(engine.client),
      capabilities: () => ["topics"],
      spill: () => false,
    });
    await tabs.getState().open("topic-0", TARGET);
    expect(opens(engine)[0]).toMatchObject({ spill: false });
    await tabs.getState().message("topic-0", 2, "41");
    expect(engine.call).toHaveBeenCalledWith("topics.message", { handle: "h1", partition: 2, offset: "41" });
    expect(await tabs.getState().message("missing", 0, "0")).toBeNull();
  });

  it("givenConsumerGroups_whenOpened_thenConsumersRead", async () => {
    const engine = topicEngine();
    const tabs = store(engine, ["topics", "consumerGroups"]);
    await tabs.getState().open("topic-0", TARGET);
    expect(tabs.getState().tabs["topic-0"]?.consumers).toEqual([]);
  });

  it("givenStoppedScan_whenScanFurther_thenResumeSentAndOldRowsReleased", async () => {
    const engine = topicEngine("r1");
    const tabs = store(engine);
    await tabs.getState().open("topic-0", TARGET);
    expect(await tabs.getState().scanFurther("topic-0")).toBe(true);
    expect(opens(engine)[1]).toMatchObject({ request: { resume: "r1" } });
    expect(engine.call).toHaveBeenCalledWith("result.release", { handle: "h1" });
    expect(tabs.getState().tabs["topic-0"]?.result?.handle).toBe("h2");
  });

  it("givenExhaustedRead_whenScanFurther_thenNothingSent", async () => {
    const engine = topicEngine(null);
    const tabs = store(engine);
    await tabs.getState().open("topic-0", TARGET);
    expect(await tabs.getState().scanFurther("topic-0")).toBe(false);
    expect(engine.call.mock.calls.filter(([type]) => type === "topics.open")).toHaveLength(1);
  });

  it("givenBadLimit_whenRead_thenProblemAndNoCall", async () => {
    const engine = topicEngine();
    const tabs = store(engine);
    await tabs.getState().open("topic-0", TARGET);
    tabs.getState().setDraft("topic-0", { limit: "0" });
    expect(await tabs.getState().read("topic-0")).toBe(false);
    expect(tabs.getState().tabs["topic-0"]?.queryError?.message).toMatch(/Limit is a whole number/);
    expect(engine.call.mock.calls.filter(([type]) => type === "topics.open")).toHaveLength(1);
  });

  it("givenPartitionClicked_whenSelected_thenOnlyItReadThenEveryOneAgain", async () => {
    const engine = topicEngine();
    const tabs = store(engine);
    await tabs.getState().open("topic-0", TARGET);
    await tabs.getState().selectPartition("topic-0", 2);
    expect(tabs.getState().tabs["topic-0"]?.applied?.partitions).toEqual([2]);
    await tabs.getState().selectPartition("topic-0", 2);
    expect(tabs.getState().tabs["topic-0"]?.applied?.partitions).toBeNull();
  });

  it("givenDetach_whenEngineGone_thenStaleAndDisconnected", async () => {
    const engine = topicEngine();
    const tabs = store(engine);
    await tabs.getState().open("topic-0", TARGET);
    tabs.getState().detach("kafka", null);
    expect(tabs.getState().tabs["topic-0"]).toMatchObject({ status: "disconnected", sessionId: null });
    expect(tabs.getState().tabs["topic-0"]?.result?.stale).toBe(true);
  });

  it("givenClose_whenClosed_thenSessionClosed", async () => {
    const engine = topicEngine();
    const tabs = store(engine);
    await tabs.getState().open("topic-0", TARGET);
    tabs.getState().close("topic-0");
    expect(tabs.getState().tabs["topic-0"]).toBeUndefined();
    expect(engine.call).toHaveBeenCalledWith("session.close", { sessionId: "s1" });
  });
});

describe("topic read bar", () => {
  it("givenEachStart_whenRequested_thenTopicStart", () => {
    const of = (change: Partial<typeof DEFAULT_DRAFT>) => readRequestOf("t", { ...DEFAULT_DRAFT, ...change });
    expect(of({ from: "earliest" })).toMatchObject({ request: { from: { kind: "earliest" } } });
    expect(of({ from: "offset", offset: " 42 " })).toMatchObject({
      request: { from: { kind: "offset", offset: "42" } },
    });
    expect(of({ from: "offset", offset: "x" })).toHaveProperty("problem", expect.stringMatching(/Offset/));
    expect(of({ from: "timestamp", timestamp: "2026-11-21T09:15:00Z" })).toMatchObject({
      request: { from: { kind: "timestamp", timestamp: "2026-11-21T09:15:00.000Z" } },
    });
    expect(of({ from: "group", group: "" })).toHaveProperty("problem", expect.stringMatching(/consumer group/));
    expect(of({ limit: "50001" })).toHaveProperty("problem", expect.stringMatching(/50,000/));
    expect(of({ filter: "  cust-42 " })).toMatchObject({ request: { filter: "cust-42" } });
  });

  it("givenDateWithoutTime_whenRead_thenLocalMidnightAsTheHintSays", () => {
    expect(instantOf("2026-11-21")).toBe(new Date(2026, 10, 21).toISOString());
    expect(instantOf("2026-11-21 09:15")).toBe(new Date(2026, 10, 21, 9, 15).toISOString());
    expect(instantOf("2026-11-21T00:00:00Z")).toBe("2026-11-21T00:00:00.000Z");
  });

  it("givenRequest_whenNamed_thenConsoleCommand", () => {
    const asked = readRequestOf("orders.v1", {
      ...DEFAULT_DRAFT,
      partitions: [0, 3],
      valueFormat: "avro",
      filter: "cust 42",
    });
    if ("problem" in asked) throw new Error(asked.problem);
    expect(readCommandText(asked.request)).toBe(
      'consume orders.v1 -p 0,3 --from -500 --limit 500 --value-format avro --grep "cust 42"',
    );
  });

  it("givenPartitionsTyped_whenParsed_thenListOrProblem", () => {
    expect(parsePartitions("", 12)).toBeNull();
    expect(parsePartitions("p3, 0 3", 12)).toEqual([0, 3]);
    expect(parsePartitions("12", 12)).toMatch(/does not exist/);
    expect(parsePartitions("a", 12)).toMatch(/numbers/);
    expect(toggledPartition(null, 3)).toEqual([3]);
    expect(toggledPartition([3], 3)).toBeNull();
    expect(toggledPartition([1, 3], 3)).toEqual([3]);
  });

  it("givenLoadedRows_whenCounted_thenPerPartitionStrip", () => {
    const executed = statement("h");
    const counts = partitionCounts(executed.columns, { 0: executed.firstWindow.rows }, 3, 3);
    expect(counts).toEqual({ counts: [1, 0, 2], complete: true });
    expect(partitionCounts(executed.columns, { 0: executed.firstWindow.rows }, 500, 3).complete).toBe(false);
  });

  it("givenCounters_whenFooter_thenShortCountWithTheScopeInItsTooltip", () => {
    expect(scannedText({ scanned: "90411", matched: "191" }, true, 191)).toBe("191 of 90,411 scanned");
    expect(scannedText({ scanned: "500", matched: "500" }, false, 500)).toBe("500 messages");
    expect(scannedText({ scanned: "1", matched: "1" }, false, 1)).toBe("1 message");
    expect(scannedText({ scanned: "600", matched: "600" }, false, 500)).toBe("500 of 600 scanned");
    const head = { scanned: "91", matched: "10", exhausted: true };
    expect(scannedScope(head, true, null).split("\n")).toEqual([
      "Scanned 91 messages; 10 matched the filter.",
      "The read reached the head of every partition.",
      NO_GROUP_TEXT,
    ]);
    expect(footerAction(head, null)).toBeNull();
    const stopped = { ...head, exhausted: false };
    expect(scannedScope(stopped, false, null)).toContain("The read stopped after 91 messages; Scan Further reads on.");
    expect(footerAction(stopped, null)).toBe("scanFurther");
    expect(footerAction(stopped, 500)).toBe("searchEarlier");
    expect(durationText("259200000")).toBe("3 d");
    expect(durationText("-1")).toBe("unlimited");
  });
});
