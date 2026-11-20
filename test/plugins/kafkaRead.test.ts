import { describe, expect, it } from "vitest";
import {
  clampLimit,
  compareMessages,
  messageFilter,
  newestAcross,
  parseResume,
  resumeToken,
  startOffset,
  type FetchedMessage,
} from "@table-craft/plugin-kafka/readPlan";

function message(partition: number, offset: number, timestamp: number | null): FetchedMessage {
  return {
    partition,
    offset: BigInt(offset),
    timestamp: timestamp === null ? null : BigInt(timestamp),
    key: null,
    value: null,
    headers: [],
    size: 0,
  };
}

function shown(messages: readonly FetchedMessage[]): string[] {
  return messages.map((entry) => `${String(entry.partition)}@${entry.offset.toString()}`);
}

describe("kafka read plan", () => {
  it("givenMessagesOfSeveralPartitions_whenSorted_thenTimestampPartitionOffset", () => {
    const messages = [
      message(1, 5, 200),
      message(0, 9, 200),
      message(0, 3, 100),
      message(2, 1, null),
      message(0, 8, 200),
    ];
    expect(shown([...messages].sort(compareMessages))).toEqual(["2@1", "0@3", "0@8", "0@9", "1@5"]);
  });

  it("givenLastNOfEachPartition_whenNewestAcross_thenNewestNOverall", () => {
    const partition0 = [100, 101, 102].map((at, index) => message(0, index, at));
    const partition1 = [50, 300, 301].map((at, index) => message(1, index, at));
    const partition2 = [10, 11, 12].map((at, index) => message(2, index, at));
    const newest = newestAcross([...partition0, ...partition1, ...partition2], 3);
    expect(shown(newest)).toEqual(["0@2", "1@1", "1@2"]);
  });

  it("givenLatestN_whenStartResolved_thenHighMinusNClampedToLow", () => {
    expect(startOffset({ kind: "latestN", count: 500 }, { low: 100n, high: 1000n }, undefined)).toBe(500n);
    expect(startOffset({ kind: "latestN", count: 500 }, { low: 800n, high: 1000n }, undefined)).toBe(800n);
    expect(startOffset({ kind: "offset", offset: "5000" }, { low: 0n, high: 1000n }, undefined)).toBe(1000n);
    expect(startOffset({ kind: "timestamp", timestamp: "2026-01-01T00:00:00Z" }, { low: 0n, high: 9n }, -1n)).toBe(9n);
    expect(startOffset({ kind: "group", group: "g" }, { low: 4n, high: 9n }, -1n)).toBe(4n);
    expect(startOffset({ kind: "group", group: "g" }, { low: 4n, high: 9n }, 7n)).toBe(7n);
  });

  it("givenFilter_whenMatched_thenSubstringOrRegex", () => {
    const substring = messageFilter("cust-42");
    expect(substring?.([null, '{"customer":"cust-42"}'])).toBe(true);
    expect(substring?.(["cust-4", null])).toBe(false);
    const regex = messageFilter("/^CUST-\\d+$/i");
    expect(regex?.(["cust-7"])).toBe(true);
    expect(messageFilter(null)).toBeNull();
    expect(() => messageFilter("/(/")).toThrow(/not a valid regular expression/);
  });

  it("givenStoppedRead_whenResumed_thenSameCursors", () => {
    const token = resumeToken("orders", [{ partition: 3, position: 10n, end: 99n, matched: 4 }], 500);
    expect(parseResume(token, "orders")).toEqual({
      cursors: [{ partition: 3, position: 10n, end: 99n, matched: 0 }],
      latest: 500,
    });
    expect(() => parseResume(token, "payments")).toThrow(/another read/);
    expect(() => parseResume("garbage", "orders")).toThrow();
  });

  it("givenLimitOutsideRange_whenClamped_thenWithinReadCap", () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1_000_000)).toBe(50_000);
  });
});
