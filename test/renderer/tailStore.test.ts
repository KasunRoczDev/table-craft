import { describe, expect, it, vi } from "vitest";
import {
  MESSAGE_PREVIEW_CHARS,
  type TailMessage,
  type TopicTailSummary,
  type TopicTailWindow,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineRequestError, type EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  appendTailWindow,
  createTailStore,
  drawnTailRows,
  heldBytes,
  TAIL_DISPLAY_BYTES,
  TAIL_DISPLAY_ROWS,
  tailJsonLines,
  tailRowMatches,
  type TailRow,
} from "@table-craft/desktop/renderer/tail/store.js";

const REQUEST = {
  topic: "orders.v1",
  partitions: null,
  from: { kind: "latest" as const },
  keyFormat: "auto" as const,
  valueFormat: "auto" as const,
};

const SUMMARY: TopicTailSummary = { tailId: "t1", request: REQUEST, state: "live", error: null, dropped: "0" };

function message(offset: number, key = `cust-${String(offset)}`): TailMessage {
  return {
    partition: 0,
    offset: String(offset),
    timestamp: null,
    key,
    value: `{"n":${String(offset)}}`,
    headers: [{ name: "source", value: "checkout" }],
    size: 10,
    keySchema: null,
    valueSchema: null,
  };
}

function window(sequences: readonly number[], skipped = "0"): TopicTailWindow {
  return {
    ...SUMMARY,
    rows: sequences.map((sequence) => ({ sequence: String(sequence), message: message(sequence) })),
    skipped,
    through: sequences.length === 0 ? null : String(sequences[sequences.length - 1]),
  };
}

describe("tail windows", () => {
  it("givenSkipped_whenAppended_thenGapRowBeforeTheRows", () => {
    const rows = appendTailWindow([], window([4, 5], "3120"), 100);
    expect(rows.map((row) => row.kind)).toEqual(["gap", "message", "message"]);
    expect(rows[0]).toMatchObject({ kind: "gap", dropped: "3120" });
  });

  it("givenRepeatedSequence_whenAppended_thenHeldOnce", () => {
    const first = appendTailWindow([], window([1, 2]), 100);
    const again = appendTailWindow(first, window([2, 3]), 100);
    expect(again.map((row) => row.sequence)).toEqual(["1", "2", "3"]);
    expect(appendTailWindow(again, window([]), 100)).toBe(again);
  });

  it("givenLimit_whenAppended_thenNewestKept", () => {
    const rows = appendTailWindow([], window([1, 2, 3, 4]), 2);
    expect(rows.map((row) => row.sequence)).toEqual(["3", "4"]);
  });

  it("givenByteBudget_whenLargeMessagesAppended_thenNewestWithinItKept", () => {
    const rows = appendTailWindow([], window([1, 2, 3, 4]), 100, heldBytes(message(1)) * 2);
    expect(rows.map((row) => row.sequence)).toEqual(["3", "4"]);
    expect(appendTailWindow([], window([5]), 100, 1).map((row) => row.sequence)).toEqual(["5"]);
  });

  it("givenLargeRecordsAsPreviews_whenAppended_thenTheBudgetCountsThePreviewsHeld", () => {
    const largeRecord = 262_144;
    const preview = (sequence: number) => ({
      sequence: String(sequence),
      message: { ...message(sequence), value: `${"x".repeat(MESSAGE_PREVIEW_CHARS)}…`, size: largeRecord },
    });
    const sequences = Array.from({ length: 1_000 }, (_, index) => index + 1);
    const rows = appendTailWindow(
      [],
      { ...window([]), rows: sequences.map(preview), through: "1000" },
      TAIL_DISPLAY_ROWS,
    );
    expect(sequences.length * largeRecord).toBeGreaterThan(TAIL_DISPLAY_BYTES);
    expect(rows).toHaveLength(sequences.length);
    expect(heldBytes(preview(1).message)).toBeLessThan(largeRecord / 64);
  });

  it("givenFilter_whenMatched_thenKeyValueOrHeadersAndGapsKept", () => {
    const rows: readonly TailRow[] = appendTailWindow([], window([42, 7], "1"), 100);
    expect(rows.filter((row) => tailRowMatches(row, "cust-42")).map((row) => row.kind)).toEqual(["gap", "message"]);
    expect(rows.filter((row) => tailRowMatches(row, "source=checkout"))).toHaveLength(3);
    expect(tailJsonLines(rows).split("\n")[0]).toBe('{"dropped":"1"}');
  });

  it("givenTail_whenPolled_thenThroughIsTheNextAfter", async () => {
    const windows = [window([1, 2]), window([5], "2")];
    const call = vi.fn((type: string, params: unknown): Promise<unknown> => {
      if (type === "topics.tailStart") return Promise.resolve(SUMMARY);
      if (type === "topics.tailWindow") return Promise.resolve(windows.shift() ?? { ...window([]), through: "5" });
      return Promise.resolve(params === undefined ? null : null);
    });
    const store = createTailStore(() => Promise.resolve({ call } as unknown as EngineClient));
    await store.getState().start("kafka", REQUEST);
    await store.getState().poll("t1");
    expect(call).toHaveBeenNthCalledWith(3, "topics.tailWindow", expect.objectContaining({ after: "2" }));
    const entry = store.getState().entries.t1;
    expect(entry?.rows.map((row) => row.kind)).toEqual(["message", "message", "gap", "message"]);
    expect(entry?.through).toBe("5");
  });

  it("givenPaused_whenPolled_thenShownRowsFrozenAndPendingCounted", async () => {
    const windows = [window([1]), window([2, 3])];
    const call = vi.fn((type: string): Promise<unknown> => {
      if (type === "topics.tailStart") return Promise.resolve(SUMMARY);
      return Promise.resolve(windows.shift() ?? window([]));
    });
    const store = createTailStore(() => Promise.resolve({ call } as unknown as EngineClient));
    await store.getState().start("kafka", REQUEST);
    store.getState().pause("t1");
    await store.getState().poll("t1");
    expect(store.getState().entries.t1).toMatchObject({ paused: true, pending: 2 });
    expect(store.getState().entries.t1?.rows).toHaveLength(1);
    store.getState().pause("t1");
    expect(store.getState().entries.t1?.rows).toHaveLength(3);
  });

  it("givenSpillSetting_whenStarted_thenSentAndClosingClearsTheTail", async () => {
    const call = vi.fn((type: string): Promise<unknown> => {
      if (type === "topics.tailStart") return Promise.resolve(SUMMARY);
      if (type === "topics.tailMessage") return Promise.resolve(message(9));
      return Promise.resolve(window([]));
    });
    const store = createTailStore(
      () => Promise.resolve({ call } as unknown as EngineClient),
      () => false,
    );
    await store.getState().start("kafka", REQUEST);
    expect(call).toHaveBeenCalledWith("topics.tailStart", expect.objectContaining({ spill: false }));
    expect(await store.getState().message("t1", "9")).toMatchObject({ offset: "9" });
    await store.getState().stop("t1", true);
    expect(call).toHaveBeenCalledWith("topics.tailStop", { tailId: "t1" });
    expect(call).toHaveBeenCalledWith("topics.tailClear", { tailId: "t1" });
    expect(store.getState().entries.t1).toBeUndefined();
  });

  it("givenDetachedTail_whenClosedOrAsked_thenNoCallReconnects", async () => {
    const call = vi.fn((type: string): Promise<unknown> =>
      Promise.resolve(type === "topics.tailStart" ? SUMMARY : window([])),
    );
    const connect = vi.fn(() => Promise.resolve({ call } as unknown as EngineClient));
    const store = createTailStore(connect);
    await store.getState().start("kafka", REQUEST);
    store.getState().detach("kafka");
    const before = connect.mock.calls.length;
    expect(await store.getState().message("t1", "1")).toBeNull();
    await store.getState().stop("t1", true);
    expect(connect).toHaveBeenCalledTimes(before);
  });

  it("givenPollInFlight_whenDetached_thenTailStaysStoppedAndClearStaysLocal", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const call = vi.fn((type: string): Promise<unknown> => {
      if (type === "topics.tailStart") return Promise.resolve(SUMMARY);
      if (type === "topics.tailWindow") return new Promise((resolve) => (answer = resolve));
      return Promise.resolve(null);
    });
    const connect = vi.fn(() => Promise.resolve({ call } as unknown as EngineClient));
    const store = createTailStore(connect);
    const started = store.getState().start("kafka", REQUEST);
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("topics.tailWindow", expect.anything()));
    store.getState().detach("kafka");
    answer(window([1]));
    await started;
    const before = connect.mock.calls.length;

    await store.getState().poll("t1");
    await store.getState().clear("t1");

    expect(store.getState().entries.t1?.summary.state).toBe("stopped");
    expect(store.getState().entries.t1?.error).toMatch(/Disconnected/);
    expect(connect).toHaveBeenCalledTimes(before);
    expect(call).not.toHaveBeenCalledWith("topics.tailClear", expect.anything());
  });

  it("givenSkippedWithoutRowsTwice_whenAppended_thenEachGapHasItsOwnKey", () => {
    const empty = { rows: [], skipped: "4", through: null };
    const rows = appendTailWindow(appendTailWindow([], empty, 100), empty, 100);
    expect(new Set(rows.map((row) => row.sequence)).size).toBe(2);
  });

  it("givenGlobalOrStickyFlag_whenFiltered_thenEveryMatchingRowShows", () => {
    const rows = appendTailWindow([], window([41, 42, 43]), 100);
    expect(drawnTailRows(rows, "/cust/g").rows).toHaveLength(3);
    expect(drawnTailRows(rows, "/cust/y").rows).toHaveLength(3);
  });
});

describe("tail copy and export", () => {
  const PREVIEW = `${"v".repeat(MESSAGE_PREVIEW_CHARS)}…`;

  async function heldTail(extract: (params: unknown) => Promise<unknown>) {
    const windows = [
      {
        ...window([1, 2], "3"),
        rows: [
          { sequence: "1", message: { ...message(1), value: PREVIEW } },
          { sequence: "2", message: message(2) },
        ],
      },
    ];
    const call = vi.fn((type: string, params: unknown): Promise<unknown> => {
      if (type === "topics.tailStart") return Promise.resolve(SUMMARY);
      if (type === "topics.tailExtract") return extract(params);
      return Promise.resolve(windows.shift() ?? window([]));
    });
    const store = createTailStore(() => Promise.resolve({ call } as unknown as EngineClient));
    await store.getState().start("kafka", REQUEST);
    return { store, call };
  }

  it("givenEngineHoldsTheRows_whenExtracted_thenItsWholeMessagesAndCutReturned", async () => {
    const { store, call } = await heldTail(() => Promise.resolve({ text: "whole", messages: 2, cut: 0, missing: 0 }));

    const copied = await store.getState().extract("t1", null);
    const exported = await store.getState().extract("t1", "/out/tail.jsonl");

    expect(call).toHaveBeenCalledWith("topics.tailExtract", {
      tailId: "t1",
      rows: [{ dropped: "3" }, { sequence: "1" }, { sequence: "2" }],
      path: null,
    });
    expect(call).toHaveBeenCalledWith("topics.tailExtract", expect.objectContaining({ path: "/out/tail.jsonl" }));
    expect(copied).toEqual({ text: "whole", messages: 2, cut: 0 });
    expect(exported.text).toBe("whole");
  });

  it("givenEngineMissesRows_whenExtracted_thenThePaneRowsWithTheirPreviewsCounted", async () => {
    const { store } = await heldTail(() => Promise.resolve({ text: null, messages: 0, cut: 0, missing: 1 }));
    const entry = store.getState().entries.t1;

    const extracted = await store.getState().extract("t1", "/out/tail.jsonl");

    expect(extracted).toEqual({ text: tailJsonLines(entry?.retained ?? []), messages: 2, cut: 1 });
  });

  it("givenWriteFailed_whenExported_thenTheFailureReachesTheAction", async () => {
    const failure = new EngineRequestError({ code: "exportFailed", message: "disk full", hint: "Choose another." });
    const { store } = await heldTail(() => Promise.reject(failure));

    await expect(store.getState().extract("t1", "/out/tail.jsonl")).rejects.toBe(failure);
  });

  it("givenDetachedTail_whenCopied_thenThePaneRowsWithoutReconnecting", async () => {
    const extract = vi.fn(() => Promise.resolve({}));
    const { store } = await heldTail(extract);
    store.getState().detach("kafka");

    expect((await store.getState().extract("t1", null)).cut).toBe(1);
    expect(extract).not.toHaveBeenCalled();
  });
});
