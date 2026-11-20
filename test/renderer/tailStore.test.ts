import { describe, expect, it, vi } from "vitest";
import type { TailMessage, TopicTailSummary, TopicTailWindow } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import {
  appendTailWindow,
  createTailStore,
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
});
