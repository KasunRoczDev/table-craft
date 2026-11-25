import type { Consumer } from "@platformatic/kafka";
import {
  FETCH_ERRORS,
  fetchResponseOf,
  fetchRound,
  recoveredPosition,
  type PartitionFetch,
} from "@table-craft/plugin-kafka/fetch";
import { describe, expect, it } from "vitest";

const SIZES = { maxWaitMs: 1, maxBytes: 1024, partitionMaxBytes: 1024 };
const OUT_OF_RANGE_ERROR = "Received response with error while executing API Fetch(v12)";

function record(offset: number, value: string): unknown {
  return {
    firstOffset: BigInt(offset),
    lastOffsetDelta: 0,
    attributes: 0,
    firstTimestamp: 1_000n,
    maxTimestamp: 1_000n,
    records: [{ offsetDelta: 0, timestampDelta: 0n, key: null, value: Buffer.from(value), headers: [] }],
  };
}

function partitionAnswer(partitionIndex: number, errorCode: number, records: unknown[] = []): unknown {
  return { partitionIndex, errorCode, highWatermark: 10n, logStartOffset: 4n, records };
}

function responseOf(...partitions: unknown[]): unknown {
  return { responses: [{ topicId: "t", partitions }] };
}

function consumerAnswering(byNode: Readonly<Record<number, () => Promise<unknown>>>): Consumer {
  return { fetch: ({ node }: { node: number }) => byNode[node]?.() } as unknown as Consumer;
}

function summary(answers: readonly PartitionFetch[]): string[] {
  return answers
    .map((answer) => `${String(answer.partition)}:${String(answer.errorCode)}:${String(answer.messages.length)}`)
    .sort();
}

describe("kafka fetch round", () => {
  it("givenPartitionError_whenDriverThrowsResponseError_thenOtherPartitionsKeepTheirRecords", async () => {
    const thrown = Object.assign(new Error(OUT_OF_RANGE_ERROR), {
      response: responseOf(partitionAnswer(0, FETCH_ERRORS.offsetOutOfRange), partitionAnswer(1, 0, [record(5, "a")])),
    });
    const consumer = consumerAnswering({ 1: () => Promise.reject(thrown) });
    const leaders = new Map([
      [0, 1],
      [1, 1],
    ]);
    const answers = await fetchRound(
      consumer,
      "t",
      leaders,
      [
        { partition: 0, position: 0n },
        { partition: 1, position: 5n },
      ],
      SIZES,
    );
    expect(summary(answers)).toEqual(["0:1:0", "1:0:1"]);
  });

  it("givenRetriedFailure_whenResponseNested_thenFoundOnTheNewestError", () => {
    const response = responseOf(partitionAnswer(0, 0));
    const wrapped = { errors: [new Error("first"), Object.assign(new Error("second"), { response })] };
    expect(fetchResponseOf(wrapped)).toBe(response);
    expect(fetchResponseOf(new Error("plain"))).toBeNull();
  });

  it("givenLeaderlessPartition_whenFetched_thenAnsweredLeaderNotAvailableWithoutARequest", async () => {
    const consumer = consumerAnswering({
      1: () => Promise.resolve(responseOf(partitionAnswer(0, 0, [record(0, "x")]))),
    });
    const answers = await fetchRound(
      consumer,
      "t",
      new Map([[0, 1]]),
      [
        { partition: 0, position: 0n },
        { partition: 1, position: 0n },
      ],
      SIZES,
    );
    expect(summary(answers)).toEqual(["0:0:1", `1:${String(FETCH_ERRORS.leaderNotAvailable)}:0`]);
  });

  it("givenOneLeaderDown_whenFetched_thenItsPartitionsFailAndTheOthersAnswer", async () => {
    const consumer = consumerAnswering({
      1: () => Promise.resolve(responseOf(partitionAnswer(0, 0, [record(0, "x")]))),
      2: () => Promise.reject(new Error("socket closed")),
    });
    const leaders = new Map([
      [0, 1],
      [1, 2],
    ]);
    const targets = [
      { partition: 0, position: 0n },
      { partition: 1, position: 0n },
    ];
    expect(summary(await fetchRound(consumer, "t", leaders, targets, SIZES))).toEqual([
      "0:0:1",
      `1:${String(FETCH_ERRORS.requestFailed)}:0`,
    ]);
    const down = consumerAnswering({
      1: () => Promise.reject(new Error("down")),
      2: () => Promise.reject(new Error("down")),
    });
    await expect(fetchRound(down, "t", leaders, targets, SIZES)).rejects.toThrow("down");
  });

  it("givenOutOfRange_whenRecovered_thenLogStartBelowItElseHighWatermark", () => {
    const answer: PartitionFetch = {
      partition: 0,
      errorCode: FETCH_ERRORS.offsetOutOfRange,
      highWatermark: 10n,
      logStartOffset: 4n,
      messages: [],
      next: null,
    };
    expect(recoveredPosition(1n, answer)).toBe(4n);
    expect(recoveredPosition(50n, answer)).toBe(10n);
    expect(recoveredPosition(50n, answer, 8n)).toBe(8n);
    expect(recoveredPosition(50n, { ...answer, highWatermark: -1n, logStartOffset: -1n }, 60n)).toBe(60n);
  });
});
