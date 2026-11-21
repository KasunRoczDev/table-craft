import type * as KafkaModule from "@platformatic/kafka";
import type { TopicStart, TopicTailRequest } from "@table-craft/plugin-api";
import type { KafkaAdmin } from "@table-craft/plugin-kafka/admin";
import type * as FetchModule from "@table-craft/plugin-kafka/fetch";
import { FETCH_ERRORS, fetchRound, type PartitionFetch } from "@table-craft/plugin-kafka/fetch";
import type { FetchedMessage } from "@table-craft/plugin-kafka/readPlan";
import { MAX_BUFFERED_BYTES, openTail, tailMessageBytes } from "@table-craft/plugin-kafka/tail";
import { afterEach, describe, expect, it, vi } from "vitest";

const consumers = vi.hoisted(() => ({ opened: 0, closed: 0 }));

vi.mock("@platformatic/kafka", async (importOriginal) => {
  const original = await importOriginal<typeof KafkaModule>();
  class FakeConsumer {
    readonly topics = { track: () => undefined, untrack: () => undefined };
    constructor() {
      consumers.opened += 1;
    }
    metadata() {
      return Promise.resolve({ topics: new Map([["orders", { id: "t", partitions: [{ leader: 1 }] }]]) });
    }
    close() {
      consumers.closed += 1;
      return Promise.resolve();
    }
  }
  return { ...original, Consumer: FakeConsumer };
});

vi.mock("@table-craft/plugin-kafka/fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof FetchModule>()),
  fetchRound: vi.fn(),
}));

const HIGH_WATERMARK = 10n;
const LARGE_VALUE_BYTES = 3 * 1024 * 1024;
const MANY = 100;

function admin(): KafkaAdmin {
  return {
    topicWatermarks: () => Promise.resolve(new Map([[0, { low: 0n, high: HIGH_WATERMARK }]])),
  } as unknown as KafkaAdmin;
}

function tailRequest(from: TopicStart): TopicTailRequest {
  return { topic: "orders", partitions: null, from, keyFormat: "string", valueFormat: "string" };
}

function largeMessage(offset: number): FetchedMessage {
  return {
    partition: 0,
    offset: BigInt(offset),
    timestamp: 0n,
    key: null,
    value: Buffer.alloc(LARGE_VALUE_BYTES, "a"),
    headers: [],
    size: LARGE_VALUE_BYTES,
  };
}

function answer(fields: Partial<PartitionFetch>): PartitionFetch {
  return {
    partition: 0,
    errorCode: FETCH_ERRORS.none,
    highWatermark: HIGH_WATERMARK,
    logStartOffset: 0n,
    messages: [],
    next: null,
    ...fields,
  };
}

function positionsAsked(call: number): bigint[] {
  const targets = vi.mocked(fetchRound).mock.calls[call]?.[3] ?? [];
  return targets.map((target) => target.position);
}

describe("kafka tail", () => {
  afterEach(() => {
    vi.mocked(fetchRound).mockReset();
  });

  it("givenLargeMessagesBuffered_whenNextAsksForMore_thenNoFetchPastTheByteCap", async () => {
    vi.mocked(fetchRound).mockResolvedValue([
      answer({ messages: [0, 1, 2].map(largeMessage), next: 3n, highWatermark: 3n }),
    ]);
    const tail = await openTail(
      { clientId: "t", bootstrapBrokers: [] },
      admin(),
      null,
      tailRequest({ kind: "earliest" }),
    );
    const first = await tail.next({ count: 1, maxBytes: MAX_BUFFERED_BYTES, timeoutMs: 0 });
    expect(first.messages).toHaveLength(1);
    const held = first.messages[0];
    expect(held === undefined ? 0 : tailMessageBytes(held) * 2).toBeGreaterThan(MAX_BUFFERED_BYTES);
    const second = await tail.next({ count: MANY, maxBytes: 1, timeoutMs: 0 });
    expect(second.messages).toHaveLength(1);
    expect(fetchRound).toHaveBeenCalledTimes(1);
    await tail.close();
  });

  it("givenPositionBelowLogStart_whenOutOfRange_thenTailResumesAtLogStart", async () => {
    vi.mocked(fetchRound)
      .mockResolvedValueOnce([answer({ errorCode: FETCH_ERRORS.offsetOutOfRange, logStartOffset: 5n })])
      .mockResolvedValue([answer({})]);
    const tail = await openTail(
      { clientId: "t", bootstrapBrokers: [] },
      admin(),
      null,
      tailRequest({ kind: "earliest" }),
    );
    await tail.next({ count: 1, maxBytes: 1, timeoutMs: 0 });
    await tail.next({ count: 1, maxBytes: 1, timeoutMs: 0 });
    expect(positionsAsked(0)).toEqual([0n]);
    expect(positionsAsked(1)).toEqual([5n]);
    await tail.close();
  });

  it("givenPositionAboveTruncatedLog_whenOutOfRange_thenTailResumesAtHighWatermarkNotStart", async () => {
    vi.mocked(fetchRound)
      .mockResolvedValueOnce([
        answer({ errorCode: FETCH_ERRORS.offsetOutOfRange, logStartOffset: 0n, highWatermark: 8n }),
      ])
      .mockResolvedValue([answer({})]);
    const tail = await openTail(
      { clientId: "t", bootstrapBrokers: [] },
      admin(),
      null,
      tailRequest({ kind: "latest" }),
    );
    await tail.next({ count: 1, maxBytes: 1, timeoutMs: 0 });
    await tail.next({ count: 1, maxBytes: 1, timeoutMs: 0 });
    expect(positionsAsked(0)).toEqual([HIGH_WATERMARK]);
    expect(positionsAsked(1)).toEqual([8n]);
    await tail.close();
  });

  it("givenClosedTail_whenNext_thenEmptyStoppedBatchWithoutFetch", async () => {
    const tail = await openTail(
      { clientId: "t", bootstrapBrokers: [] },
      admin(),
      null,
      tailRequest({ kind: "latest" }),
    );
    await tail.close();
    expect(await tail.next({ count: 1, maxBytes: 1, timeoutMs: 0 })).toEqual({
      messages: [],
      state: "stopped",
      error: null,
    });
    expect(fetchRound).not.toHaveBeenCalled();
  });

  it("givenBadStart_whenOpened_thenRefusedBeforeAConsumerOpens", async () => {
    const before = consumers.opened;
    await expect(
      openTail({ clientId: "t", bootstrapBrokers: [] }, admin(), null, tailRequest({ kind: "offset", offset: "-1" })),
    ).rejects.toThrow(/offset/);
    await expect(
      openTail({ clientId: "t", bootstrapBrokers: [] }, admin(), null, tailRequest({ kind: "latestN", count: -3 })),
    ).rejects.toThrow();
    expect(consumers.opened).toBe(before);
  });
});
