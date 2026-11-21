import {
  MESSAGE_PREVIEW_CHARS,
  type MessageSpill,
  type Row,
  type SpilledMessage,
  type TopicRead,
  type TopicReadRequest,
} from "@table-craft/plugin-api";
import type * as FetchModule from "@table-craft/plugin-kafka/fetch";
import { fetchRound } from "@table-craft/plugin-kafka/fetch";
import { readTopic, type ReadHost } from "@table-craft/plugin-kafka/read";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@table-craft/plugin-kafka/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof FetchModule>()),
  fetchRound: vi.fn(),
}));

const SPILL_TOPIC = "orders";
const LARGE_VALUE_CHARS = 5_000;
const SPILL_FULL = "the temporary disk space for large messages is full (2 GB)";

function largeMessages(count: number): FetchedMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const value = Buffer.from(String(index).repeat(LARGE_VALUE_CHARS));
    return { ...message(0, index, 1_000 + index), value, size: value.byteLength };
  });
}

function readHost(): ReadHost {
  const consumer = {
    topics: { track: () => undefined },
    metadata: () => Promise.resolve({ topics: new Map([[SPILL_TOPIC, { id: "t", partitions: [{ leader: 1 }] }]]) }),
  };
  const admin = {
    topicWatermarks: () => Promise.resolve(new Map([[0, { low: 0n, high: 3n }]])),
  };
  return {
    admin: admin as unknown as ReadHost["admin"],
    fetcher: () => consumer as unknown as ReturnType<ReadHost["fetcher"]>,
    registry: null,
    maxScan: 100,
    fullBytes: false,
    signal: null,
    committed: () => Promise.resolve(new Map()),
  };
}

const spillRequest: TopicReadRequest = {
  topic: SPILL_TOPIC,
  partitions: null,
  from: { kind: "earliest" },
  limit: 10,
  keyFormat: "string",
  valueFormat: "string",
  filter: null,
  maxScan: null,
  resume: null,
};

async function rowsOf(read: TopicRead): Promise<Row[]> {
  const rows: Row[] = [];
  for await (const row of read.result.rows) rows.push(row);
  return rows;
}

describe("kafka read with a spill", () => {
  const VALUE_COLUMN = 4;

  it("givenLargeMessages_whenReadWithSpill_thenRowsKeepPreviewsAndSpillTheFullCells", async () => {
    vi.mocked(fetchRound).mockResolvedValueOnce([
      { partition: 0, errorCode: 0, highWatermark: 3n, logStartOffset: 0n, messages: largeMessages(3), next: 3n },
    ]);
    const spilled = new Map<string, SpilledMessage>();
    const spill: MessageSpill = {
      put: (partition, offset, full) => {
        spilled.set(`${String(partition)}:${offset}`, full);
        return Promise.resolve();
      },
    };
    const read = await readTopic(readHost(), spillRequest, null, spill);
    const rows = await rowsOf(read);
    expect(rows).toHaveLength(3);
    const preview = rows[1]?.[VALUE_COLUMN];
    expect(typeof preview === "string" && preview.length).toBe(MESSAGE_PREVIEW_CHARS + 1);
    expect(typeof preview === "string" && preview.endsWith("…")).toBe(true);
    expect(spilled.get("0:1")?.value).toBe("1".repeat(LARGE_VALUE_CHARS));
    expect(read.exhausted).toBe(true);
  });

  it("givenSpillFull_whenRead_thenStopsWithWarningAndResumesAtRefusedMessage", async () => {
    vi.mocked(fetchRound).mockResolvedValueOnce([
      { partition: 0, errorCode: 0, highWatermark: 3n, logStartOffset: 0n, messages: largeMessages(3), next: 3n },
    ]);
    let puts = 0;
    const spill: MessageSpill = {
      put: () => {
        puts += 1;
        return puts > 1 ? Promise.reject(new Error(SPILL_FULL)) : Promise.resolve();
      },
    };
    const read = await readTopic(readHost(), spillRequest, null, spill);
    expect(await rowsOf(read)).toHaveLength(1);
    expect(read.warnings).toContain(`The read stopped: ${SPILL_FULL}; lower the limit or narrow the filter.`);
    expect(read.exhausted).toBe(false);
    expect(parseResume(read.resume ?? "", SPILL_TOPIC).cursors[0]?.position).toBe(1n);
  });

  it("givenLargeMessages_whenReadWithoutSpill_thenRowsKeepFullCells", async () => {
    vi.mocked(fetchRound).mockResolvedValueOnce([
      { partition: 0, errorCode: 0, highWatermark: 3n, logStartOffset: 0n, messages: largeMessages(3), next: 3n },
    ]);
    const rows = await rowsOf(await readTopic(readHost(), spillRequest));
    expect(rows[2]?.[VALUE_COLUMN]).toBe("2".repeat(LARGE_VALUE_CHARS));
  });
});
