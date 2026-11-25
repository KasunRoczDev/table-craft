import { describe, expect, it, vi } from "vitest";
import type {
  ExecutedStatement,
  OpenedSearch,
  OpenedSession,
  SearchHistogram,
  SearchTargetDescription,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  analyzedFields,
  CUSTOM_RANGE,
  DEFAULT_RANGE,
  defaultDraft,
  droppedTokens,
  EMPTY_SEARCH_DRAFT,
  HISTOGRAM_BUCKETS,
  histogramPlot,
  hitsText,
  roundScale,
  searchRequestOf,
  sortableFields,
  stoppedEarly,
  windowLabel,
  type SearchDraft,
} from "@table-craft/desktop/renderer/model/indexSearch.js";
import { createIndexTabsStore, searchCommandText } from "@table-craft/desktop/renderer/state/indexTabs.js";

const NOW = Date.parse("2026-11-21T09:15:00.000Z");
const QUARTER_HOUR_AGO = "2026-11-21T09:00:00.000Z";

const TARGET = { datasourceId: "search", target: "logs-checkout" };

function description(timeField: string | null): SearchTargetDescription {
  return {
    name: "logs-checkout",
    kind: "alias",
    indices: ["logs-checkout-000411", "logs-checkout-000412"],
    mappingType: null,
    fields: [
      { path: "@timestamp", type: "date", multiOf: null, analyzer: null, aggregatable: true },
      { path: "message", type: "text", multiOf: null, analyzer: "standard", aggregatable: false },
      { path: "message.keyword", type: "keyword", multiOf: "message", analyzer: null, aggregatable: true },
      { path: "status", type: "keyword", multiOf: null, analyzer: null, aggregatable: true },
    ],
    timeField,
    mapping: "{}",
    settings: "{}",
    warnings: [],
  };
}

function statement(handle: string): ExecutedStatement {
  return {
    handle,
    columns: [
      { name: "_id", type: "keyword" },
      { name: "status", type: "keyword" },
    ],
    typeClasses: ["text", "text"],
    rowCount: 2,
    complete: true,
    cursorOpen: false,
    rowsAffected: null,
    firstWindow: {
      offset: 0,
      rows: [
        ["a1", "paid"],
        ["a2", "failed"],
      ],
    },
    transactionOpen: false,
  };
}

const HISTOGRAM: SearchHistogram = {
  field: "@timestamp",
  interval: "15s",
  buckets: [{ at: QUARTER_HOUR_AGO, count: 2 }],
};

interface EngineOptions {
  readonly timeField?: string | null;
  readonly refuse?: boolean;
  /** Requests the cluster refuses for want of a privilege, as per-index-pattern permissions do. */
  readonly deny?: readonly string[];
}

const DENIED = "This user lacks the privilege for indices:data/read/search (read or all): unauthorized";

function searchEngine({ timeField = "@timestamp", refuse = false, deny = [] }: EngineOptions = {}) {
  let searches = 0;
  const call = vi.fn((type: string, _params?: unknown): Promise<unknown> => {
    if (deny.includes(type)) {
      return Promise.reject(new EngineRequestError({ code: "statementFailed", message: DENIED, hint: "Fix it." }));
    }
    if (type === "session.open") {
      const opened: OpenedSession = {
        sessionId: "s1",
        pluginName: "Elasticsearch",
        capabilities: ["commands", "searchIndices"],
        serverVersion: "8.15.0",
        serverBrand: null,
        namespace: null,
        serverTimeout: null,
        cancelReach: null,
      };
      return Promise.resolve(opened);
    }
    if (type === "indices.describe") return Promise.resolve(description(timeField));
    if (type === "indices.histogram") return Promise.resolve(HISTOGRAM);
    if (type === "indices.analyze") {
      return Promise.resolve([
        { name: "standard", kind: "tokenizer", tokens: [{ token: "The", position: 0 }] },
        { name: "lowercase", kind: "tokenFilter", tokens: [{ token: "the", position: 0 }] },
      ]);
    }
    if (type === "indices.open") {
      searches += 1;
      if (refuse) {
        return Promise.reject(
          new EngineRequestError({ code: "statementFailed", message: "Failed to parse query", hint: "Fix it." }),
        );
      }
      const opened: OpenedSearch = {
        search: {
          total: { value: "2431", relation: "eq" },
          tookMs: 6,
          shards: { total: 5, successful: 5, skipped: 0, failed: 0 },
          request: 'GET logs-checkout/_search\n{"size": 100}',
          warnings: [],
        },
        statement: statement(`h${String(searches)}`),
      };
      return Promise.resolve(opened);
    }
    return Promise.resolve(null);
  });
  return { client: { call } as unknown as EngineClient, call };
}

type Engine = ReturnType<typeof searchEngine>;

function callsOf(engine: Engine, type: string): readonly unknown[] {
  return engine.call.mock.calls.filter(([called]) => called === type).map(([, params]) => params);
}

function store(engine: Engine) {
  return createIndexTabsStore({ connect: () => Promise.resolve(engine.client), clock: () => NOW });
}

function token(text: string, position: number) {
  return { token: text, position };
}

describe("index tabs", () => {
  it("givenTimeField_whenOpened_thenDescribedAndLastQuarterHourSearchedNewestFirstWithHistogram", async () => {
    const engine = searchEngine();
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    const tab = tabs.getState().tabs["index-0"];
    expect(tab).toMatchObject({ status: "ready", kind: "alias", queryError: null });
    expect(tab?.draft).toMatchObject({ sortField: "@timestamp", sortOrder: "desc", range: DEFAULT_RANGE });
    expect(tab?.result?.windows[0]).toHaveLength(2);
    expect(tab?.search?.tookMs).toBe(6);
    expect(tab?.histogram).toEqual(HISTOGRAM);
    expect(callsOf(engine, "indices.open")[0]).toMatchObject({
      sessionId: "s1",
      request: {
        target: "logs-checkout",
        language: "lucene",
        query: "",
        sort: [{ field: "@timestamp", order: "desc" }],
        time: { field: "@timestamp", from: QUARTER_HOUR_AGO, to: null },
      },
    });
    expect(callsOf(engine, "indices.histogram")[0]).toMatchObject({ buckets: HISTOGRAM_BUCKETS });
  });

  it("givenNoTimeField_whenOpened_thenScoreOrderAndNoRangeNorHistogram", async () => {
    const engine = searchEngine({ timeField: null });
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    expect(tabs.getState().tabs["index-0"]?.draft).toEqual(EMPTY_SEARCH_DRAFT);
    expect(callsOf(engine, "indices.open")[0]).toMatchObject({ request: { sort: [], time: null } });
    expect(callsOf(engine, "indices.histogram")).toHaveLength(0);
    expect(tabs.getState().tabs["index-0"]?.histogram).toBeNull();
  });

  it("givenDslDraft_whenRun_thenRequestCarriesItAndOldRowsReleased", async () => {
    const engine = searchEngine();
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    tabs.getState().setDraft("index-0", { language: "dsl", query: ' {"match": {"status": "paid"}} ', range: "all" });
    expect(await tabs.getState().run("index-0")).toBe(true);
    expect(callsOf(engine, "indices.open")[1]).toMatchObject({
      request: { language: "dsl", query: '{"match": {"status": "paid"}}', time: null },
    });
    expect(engine.call).toHaveBeenCalledWith("result.release", { handle: "h1" });
    expect(tabs.getState().tabs["index-0"]?.result?.handle).toBe("h2");
  });

  it("givenRefusedQuery_whenRun_thenQueryErrorNotConnectionError", async () => {
    const engine = searchEngine({ refuse: true });
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    const tab = tabs.getState().tabs["index-0"];
    expect(tab?.queryError?.message).toBe("Failed to parse query");
    expect(tab).toMatchObject({ error: null, status: "ready", result: null });
  });

  it("givenSearchForbidden_whenRun_thenThePrivilegeShowsInlineAndTheOtherViewsKeepWorking", async () => {
    const engine = searchEngine({ deny: ["indices.open", "indices.histogram"] });
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    await Promise.resolve();
    const tab = tabs.getState().tabs["index-0"];
    expect(tab?.queryError?.message).toBe(DENIED);
    expect(tab).toMatchObject({ error: null, status: "ready", histogramError: null, kind: "alias" });
    tabs.getState().setAnalyzeDraft("index-0", { field: "message", text: "The" });
    await tabs.getState().analyze("index-0");
    expect(tabs.getState().tabs["index-0"]?.analysis).toHaveLength(2);
  });

  it("givenHistogramForbidden_whenRun_thenHitsStandAndTheRefusalShowsInline", async () => {
    const engine = searchEngine({ deny: ["indices.histogram"] });
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    await vi.waitFor(() => expect(tabs.getState().tabs["index-0"]?.histogramError?.message).toBe(DENIED));
    const tab = tabs.getState().tabs["index-0"];
    expect(tab).toMatchObject({ error: null, queryError: null, status: "ready", histogram: null });
    expect(tab?.result?.windows[0]).toHaveLength(2);
  });

  it("givenAnalyzeForbidden_whenAnalyzed_thenTheRefusalShowsInTheAnalyzeViewOnly", async () => {
    const engine = searchEngine({ deny: ["indices.analyze"] });
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    tabs.getState().setAnalyzeDraft("index-0", { field: "message", text: "The" });
    await tabs.getState().analyze("index-0");
    const tab = tabs.getState().tabs["index-0"];
    expect(tab?.analyzeError?.message).toBe(DENIED);
    expect(tab).toMatchObject({ error: null, queryError: null, status: "ready", analyzing: false });
    expect(tab?.result?.windows[0]).toHaveLength(2);
  });

  it("givenAnalyzeDraft_whenAnalyzed_thenStepsKept", async () => {
    const engine = searchEngine();
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    tabs.getState().setAnalyzeDraft("index-0", { field: "message", text: "The" });
    await tabs.getState().analyze("index-0");
    expect(callsOf(engine, "indices.analyze")[0]).toEqual({
      request: { target: "logs-checkout", field: "message", analyzer: null, text: "The" },
    });
    expect(tabs.getState().tabs["index-0"]?.analysis).toHaveLength(2);
  });

  it("givenDetach_whenEngineGone_thenStaleAndDisconnected", async () => {
    const engine = searchEngine();
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    tabs.getState().detach("search", null);
    expect(tabs.getState().tabs["index-0"]).toMatchObject({ status: "disconnected", sessionId: null });
    expect(tabs.getState().tabs["index-0"]?.result?.stale).toBe(true);
  });

  it("givenInitialChange_whenOpened_thenFirstSearchCarriesIt", async () => {
    const engine = searchEngine();
    const tabs = store(engine);
    const window = { from: "2026-11-21T08:00:00Z", to: "2026-11-21T08:10:00Z" };
    await tabs.getState().open("index-0", TARGET, {
      change: { query: "status:failed", sortOrder: "asc", range: CUSTOM_RANGE, window },
      run: true,
    });
    expect(callsOf(engine, "indices.open")).toHaveLength(1);
    expect(callsOf(engine, "indices.open")[0]).toMatchObject({
      request: {
        query: "status:failed",
        sort: [{ field: "@timestamp", order: "asc" }],
        time: { field: "@timestamp", ...window },
      },
    });
  });

  it("givenInitialChangeNotRun_whenOpened_thenDraftFilledInAndNothingSearched", async () => {
    const engine = searchEngine();
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET, { change: { query: "status:failed" }, run: false });
    expect(callsOf(engine, "indices.open")).toHaveLength(0);
    expect(tabs.getState().tabs["index-0"]).toMatchObject({ status: "ready", result: null });
    expect(tabs.getState().tabs["index-0"]?.draft).toMatchObject({ query: "status:failed", sortField: "@timestamp" });
  });

  it("givenSearchRunning_whenApplied_thenItIsCancelledAndTheNewRequestFollows", async () => {
    const engine = searchEngine();
    const base = engine.call.getMockImplementation();
    let stop: (() => void) | null = null;
    engine.call.mockImplementation((type: string, params?: unknown) => {
      if (type === "indices.open" && stop === null && callsOf(engine, "indices.open").length === 1) {
        return new Promise((_resolve, reject) => {
          stop = () =>
            reject(new EngineRequestError({ code: "cancelled", message: "Cancelled", hint: "Run it again." }));
        });
      }
      if (type === "statement.cancel") stop?.();
      return base?.(type, params) ?? Promise.resolve(null);
    });
    const tabs = store(engine);
    const opened = tabs.getState().open("index-0", TARGET);
    await vi.waitFor(() => expect(tabs.getState().tabs["index-0"]?.status).toBe("loading"));
    await tabs.getState().apply("index-0", { change: { query: "status:failed" }, run: true });
    await opened;
    await vi.waitFor(() => expect(callsOf(engine, "indices.open")).toHaveLength(2));
    expect(callsOf(engine, "statement.cancel")).toHaveLength(1);
    expect(callsOf(engine, "indices.open")[1]).toMatchObject({ request: { query: "status:failed" } });
    await vi.waitFor(() => expect(tabs.getState().tabs["index-0"]?.applied?.query).toBe("status:failed"));
  });

  it("givenTabStillOpening_whenApplied_thenTheFirstSearchCarriesTheChange", async () => {
    const engine = searchEngine();
    const base = engine.call.getMockImplementation();
    const gate: { describeNow?: () => void } = {};
    engine.call.mockImplementation((type: string, params?: unknown) => {
      if (type === "indices.describe") {
        return new Promise((resolve) => {
          gate.describeNow = () => resolve(description("@timestamp"));
        });
      }
      return base?.(type, params) ?? Promise.resolve(null);
    });
    const tabs = store(engine);
    const opened = tabs.getState().open("index-0", TARGET, { change: { query: "status:paid" }, run: true });
    await vi.waitFor(() => expect(gate.describeNow).toBeDefined());
    await tabs.getState().apply("index-0", { change: { range: "24h" }, run: true });
    gate.describeNow?.();
    await opened;
    expect(callsOf(engine, "indices.open")).toHaveLength(1);
    expect(callsOf(engine, "indices.open")[0]).toMatchObject({
      request: { query: "status:paid", time: { field: "@timestamp", from: "2026-11-20T09:15:00.000Z" } },
    });
  });

  it("givenClose_whenClosed_thenSessionClosed", async () => {
    const engine = searchEngine();
    const tabs = store(engine);
    await tabs.getState().open("index-0", TARGET);
    tabs.getState().close("index-0");
    expect(tabs.getState().tabs["index-0"]).toBeUndefined();
    expect(engine.call).toHaveBeenCalledWith("session.close", { sessionId: "s1" });
  });
});

describe("index search bar", () => {
  it("givenDescription_whenDefaulted_thenTimeFirstOnlyWithTimeField", () => {
    expect(defaultDraft(null)).toEqual(EMPTY_SEARCH_DRAFT);
    expect(defaultDraft({ timeField: "@timestamp" })).toMatchObject({ sortField: "@timestamp", range: "15m" });
  });

  it("givenRangeWithoutTimeField_whenRequested_thenNoTimeAndPageClamped", () => {
    const draft = { ...EMPTY_SEARCH_DRAFT, range: "7d" as const };
    expect(searchRequestOf("orders", draft, null, 50_000, NOW)).toMatchObject({ time: null, pageSize: 10_000 });
    expect(searchRequestOf("orders", draft, "created", 0, NOW)).toMatchObject({
      time: { field: "created", from: "2026-11-14T09:15:00.000Z", to: null },
      pageSize: 1,
    });
  });

  it("givenCustomWindow_whenRequestedAndLabelled_thenItsEnds", () => {
    const window = { from: "2026-11-21T15:00:00Z", to: "2026-11-21T15:10:00Z" };
    const draft: SearchDraft = { ...EMPTY_SEARCH_DRAFT, range: CUSTOM_RANGE, window };
    expect(searchRequestOf("orders", draft, "created", 100, NOW)).toMatchObject({
      time: { field: "created", ...window },
    });
    expect(searchRequestOf("orders", { ...draft, window: null }, "created", 100, NOW)).toMatchObject({ time: null });
    expect(windowLabel(window)).toBe("2026-11-21 15:00 – 15:10 UTC");
    expect(windowLabel({ from: window.from, to: null })).toBe("2026-11-21 15:00 – … UTC");
    expect(windowLabel({ from: window.from, to: "2026-11-22T01:00:00Z" })).toBe(
      "2026-11-21 15:00 – 2026-11-22 01:00 UTC",
    );
  });

  it("givenRequest_whenNamed_thenServicesText", () => {
    const request = searchRequestOf("orders", { ...EMPTY_SEARCH_DRAFT, query: "status:paid" }, null, 100, NOW);
    expect(searchCommandText(request)).toBe("GET orders/_search status:paid");
    expect(searchCommandText({ ...request, query: "" })).toBe("GET orders/_search");
  });

  it("givenFields_whenFiltered_thenSortableAndAnalyzed", () => {
    const fields = description(null).fields;
    expect(sortableFields(fields).map((field) => field.path)).toEqual(["@timestamp", "message.keyword", "status"]);
    expect(analyzedFields(fields).map((field) => field.path)).toEqual(["message"]);
  });

  it("givenTotals_whenFooter_thenHitsText", () => {
    expect(hitsText(100, { value: "2431", relation: "eq" })).toBe("1–100 of 2,431 hits");
    expect(hitsText(100, { value: "10000", relation: "gte" })).toBe("1–100 of ≥ 10,000 hits");
    expect(hitsText(1, { value: "1", relation: "eq" })).toBe("1–1 of 1 hit");
    expect(hitsText(0, { value: "0", relation: "eq" })).toBe("0 hits");
    expect(hitsText(0, null)).toBe("0 hits");
  });

  it("givenAnalysisChain_whenCompared_thenDroppedTokensPerStep", () => {
    const steps = [
      { kind: "tokenizer", tokens: [token("The", 0), token("Crème", 1), token("go", 2)] },
      { kind: "tokenFilter", tokens: [token("the", 0), token("crème", 1), token("go", 2)] },
      { kind: "tokenFilter", tokens: [token("the", 0), token("creme", 1)] },
    ];
    expect(droppedTokens(steps)).toEqual([
      { kept: ["The", "Crème", "go"], dropped: [] },
      { kept: ["the", "crème", "go"], dropped: [] },
      { kept: ["the", "creme"], dropped: ["go"] },
    ]);
  });

  it("givenCharFilterFirst_whenCompared_thenTheTokenizerDropsNothing", () => {
    const steps = [
      { kind: "charFilter", tokens: [token("<b>Tea</b>", 0)] },
      { kind: "tokenizer", tokens: [token("Tea", 0), token("cup", 1)] },
    ];
    expect(droppedTokens(steps)[1]).toEqual({ kept: ["Tea", "cup"], dropped: [] });
  });
});

describe("index search stopped early", () => {
  it.each([
    { rows: 500, complete: true, total: { value: "3263", relation: "eq" as const }, stopped: true },
    { rows: 500, complete: false, total: { value: "3263", relation: "eq" as const }, stopped: false },
    { rows: 3263, complete: true, total: { value: "3263", relation: "eq" as const }, stopped: false },
    { rows: 9000, complete: true, total: { value: "10000", relation: "gte" as const }, stopped: true },
    { rows: 0, complete: true, total: { value: "5", relation: "eq" as const }, stopped: false },
  ])("givenRows $rows of $total.value complete $complete_whenChecked_thenStopped $stopped", (c) => {
    expect(stoppedEarly(c.rows, c.complete, c.total)).toBe(c.stopped);
  });

  it("givenNoTotal_whenChecked_thenNotStopped", () => {
    expect(stoppedEarly(10, true, null)).toBe(false);
  });
});

describe("index histogram plot", () => {
  const MINUTE_MS = 60_000;
  const START = Date.parse("2026-03-02T10:00:00.000Z");
  const minuteBuckets = (counts: readonly number[]) =>
    counts.map((count, index) => ({ at: new Date(START + index * MINUTE_MS).toISOString(), count }));

  it.each([
    [0, 1],
    [1, 1],
    [3, 5],
    [10, 10],
    [11, 20],
    [325, 500],
    [5001, 10_000],
  ])("givenHighestBar%s_whenScaled_thenTopIs%s", (value, top) => {
    expect(roundScale(value)).toBe(top);
  });

  it("givenAnOpenLastHour_whenPlotted_thenTheEdgeBucketsArePartial", () => {
    const counts = Array.from({ length: 61 }, (_, index) => (index === 30 ? 40 : 20));
    const plot = histogramPlot(minuteBuckets(counts), {
      from: new Date(START + 30_000).toISOString(),
      to: null,
    });

    expect(plot.top).toBe(50);
    expect(plot.bars.map((bar) => bar.partial).filter(Boolean)).toHaveLength(2);
    expect(plot.bars[0]?.partial).toBe(true);
    expect(plot.bars[60]?.partial).toBe(true);
    expect(plot.bars[30]?.ratio).toBe(0.8);
  });

  it("givenAClosedRange_whenPlotted_thenNoBucketIsPartial", () => {
    const buckets = minuteBuckets([1, 2, 3, 4]);
    const plot = histogramPlot(buckets, {
      from: new Date(START).toISOString(),
      to: new Date(START + 4 * MINUTE_MS).toISOString(),
    });

    expect(plot.bars.some((bar) => bar.partial)).toBe(false);
  });

  it("givenAnHour_whenPlotted_thenFourClockLabelsFromTheStart", () => {
    const plot = histogramPlot(minuteBuckets(Array.from({ length: 61 }, () => 1)), null);

    expect(plot.ticks.map((tick) => tick.index)).toEqual([0, 15, 30, 45]);
    for (const tick of plot.ticks) expect(tick.label).toMatch(/^\d{2}:\d{2}$/);
  });

  it("givenFewerBucketsThanLabels_whenPlotted_thenNoLabels", () => {
    expect(histogramPlot(minuteBuckets([1, 2, 3]), null).ticks).toEqual([]);
  });
});
