import type { Consumer, RecordsBatch } from "@platformatic/kafka";
import type { FetchedMessage } from "./readPlan.js";

/** Batch attribute bits, from Kafka's `DefaultRecordBatch`. */
const TIMESTAMP_TYPE_LOG_APPEND = 0x08;
const CONTROL_BATCH = 0x20;
const NO_TIMESTAMP = -1n;
const NO_LEADER_EPOCH = -1;
const READ_UNCOMMITTED = 0;
const MIN_BYTES = 1;

/**
 * The driver's Consumer needs a group id, but browsing never sends a group request (decision 4),
 * so this id is never joined, committed to or created on the broker.
 */
export const UNJOINED_GROUP_ID = "tablecraft-browse-unjoined";

/** Kafka's error codes a read reacts to rather than reports. */
export const FETCH_ERRORS = {
  /** Kafka's UNKNOWN_SERVER_ERROR; here also a partition whose leader's request failed outright. */
  requestFailed: -1,
  none: 0,
  offsetOutOfRange: 1,
  unknownTopicOrPartition: 3,
  leaderNotAvailable: 5,
  notLeader: 6,
  fencedLeaderEpoch: 74,
  unknownLeaderEpoch: 75,
} as const;
const MAX_ERROR_DEPTH = 6;

export interface FetchSizes {
  readonly maxWaitMs: number;
  readonly maxBytes: number;
  readonly partitionMaxBytes: number;
}

export interface FetchTarget {
  readonly partition: number;
  readonly position: bigint;
}

export interface PartitionFetch {
  readonly partition: number;
  readonly errorCode: number;
  readonly highWatermark: bigint;
  readonly logStartOffset: bigint;
  /** Records at or after the position asked for, in offset order. */
  readonly messages: FetchedMessage[];
  /** The offset after the last batch returned; null when none came. */
  readonly next: bigint | null;
}

function bytesOf(buffer: Buffer | null): number {
  return buffer?.length ?? 0;
}

function messagesOf(partition: number, position: bigint, batches: readonly RecordsBatch[]): FetchedMessage[] {
  const messages: FetchedMessage[] = [];
  for (const batch of batches) {
    if ((batch.attributes & CONTROL_BATCH) !== 0) continue;
    const logAppend = (batch.attributes & TIMESTAMP_TYPE_LOG_APPEND) !== 0;
    for (const record of batch.records) {
      const offset = batch.firstOffset + BigInt(record.offsetDelta);
      if (offset < position) continue;
      const created = batch.firstTimestamp === NO_TIMESTAMP ? null : batch.firstTimestamp + record.timestampDelta;
      const timestamp = logAppend ? batch.maxTimestamp : created;
      const headers = record.headers.map(([name, value]) => [name, value] as const);
      const size =
        bytesOf(record.key) +
        bytesOf(record.value) +
        headers.reduce((sum, [name, value]) => sum + bytesOf(name) + bytesOf(value), 0);
      messages.push({
        partition,
        offset,
        timestamp: timestamp === NO_TIMESTAMP ? null : timestamp,
        key: record.key,
        value: record.value,
        headers,
        size,
      });
    }
  }
  return messages;
}

function nextOf(batches: readonly RecordsBatch[]): bigint | null {
  const last = batches.at(-1);
  return last === undefined ? null : last.firstOffset + BigInt(last.lastOffsetDelta) + 1n;
}

/**
 * Where to go on after OFFSET_OUT_OF_RANGE: the log start when retention moved past `position`,
 * else the high watermark, as a position above it means the log was truncated; never past `end`.
 */
export function recoveredPosition(position: bigint, answer: PartitionFetch, end: bigint | null = null): bigint {
  const next =
    answer.logStartOffset >= 0n && position < answer.logStartOffset
      ? answer.logStartOffset
      : answer.highWatermark >= 0n
        ? answer.highWatermark
        : (end ?? position);
  return end !== null && next > end ? end : next;
}

type FetchResponse = Awaited<ReturnType<Consumer["fetch"]>>;

function isFetchResponse(value: unknown): value is FetchResponse {
  return typeof value === "object" && value !== null && Array.isArray((value as { responses?: unknown }).responses);
}

/**
 * The Fetch response a driver error carries. The driver throws when any partition has an error
 * code, so the other partitions' records and each partition's own code only survive on the error,
 * possibly nested in the errors of its retries.
 */
export function fetchResponseOf(error: unknown, depth = 0): FetchResponse | null {
  if (depth > MAX_ERROR_DEPTH || typeof error !== "object" || error === null) return null;
  const { response, errors } = error as { readonly response?: unknown; readonly errors?: unknown };
  if (isFetchResponse(response)) return response;
  if (!Array.isArray(errors)) return null;
  for (const nested of [...(errors as unknown[])].reverse()) {
    const found = fetchResponseOf(nested, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function failedFetch(partition: number, errorCode: number): PartitionFetch {
  return { partition, errorCode, highWatermark: -1n, logStartOffset: -1n, messages: [], next: null };
}

function partitionFetches(response: FetchResponse, positions: ReadonlyMap<number, bigint>): PartitionFetch[] {
  return response.responses.flatMap((topic) =>
    topic.partitions.map((partition): PartitionFetch => {
      const batches = partition.records ?? [];
      return {
        partition: partition.partitionIndex,
        errorCode: partition.errorCode,
        highWatermark: partition.highWatermark,
        logStartOffset: partition.logStartOffset,
        messages: messagesOf(partition.partitionIndex, positions.get(partition.partitionIndex) ?? 0n, batches),
        next: nextOf(batches),
      };
    }),
  );
}

/**
 * One Fetch per partition leader, by explicit offset (decision 4): no JoinGroup, no OffsetCommit,
 * no group request of any kind. The consumer must track the topic first, so brokers that take
 * Fetch v12 and older get its name rather than its id.
 *
 * Every partition's trouble comes back as its own error code, so one partition never costs the
 * others their records: `leaderNotAvailable` for a partition without a leader, `requestFailed` for
 * those of a leader whose request failed. Only when no leader answered at all does it throw. A
 * partition missing from the answer had nothing new: a fetch session leaves unchanged ones out.
 */
export async function fetchRound(
  consumer: Consumer,
  topicId: string,
  leaders: ReadonlyMap<number, number>,
  targets: readonly FetchTarget[],
  sizes: FetchSizes,
): Promise<PartitionFetch[]> {
  const byLeader = new Map<number, FetchTarget[]>();
  const leaderless: PartitionFetch[] = [];
  for (const target of targets) {
    const leader = leaders.get(target.partition);
    if (leader === undefined) leaderless.push(failedFetch(target.partition, FETCH_ERRORS.leaderNotAvailable));
    else byLeader.set(leader, [...(byLeader.get(leader) ?? []), target]);
  }
  const groups = [...byLeader.entries()];
  const rounds = await Promise.allSettled(
    groups.map(async ([node, group]) => {
      const positions = new Map(group.map((target) => [target.partition, target.position]));
      try {
        const response = await consumer.fetch({
          node,
          topics: [
            {
              topicId,
              partitions: group.map((target) => ({
                partition: target.partition,
                currentLeaderEpoch: NO_LEADER_EPOCH,
                fetchOffset: target.position,
                lastFetchedEpoch: NO_LEADER_EPOCH,
                partitionMaxBytes: sizes.partitionMaxBytes,
              })),
            },
          ],
          maxWaitTime: sizes.maxWaitMs,
          minBytes: MIN_BYTES,
          maxBytes: sizes.maxBytes,
          isolationLevel: READ_UNCOMMITTED,
        });
        return partitionFetches(response, positions);
      } catch (cause) {
        const response = fetchResponseOf(cause);
        if (response === null) throw cause;
        return partitionFetches(response, positions);
      }
    }),
  );
  const first = rounds[0];
  if (first?.status === "rejected" && rounds.every((round) => round.status === "rejected")) throw first.reason;
  const answers: PartitionFetch[] = [...leaderless];
  rounds.forEach((round, index) => {
    if (round.status === "fulfilled") answers.push(...round.value);
    else
      for (const target of groups[index]?.[1] ?? []) {
        answers.push(failedFetch(target.partition, FETCH_ERRORS.requestFailed));
      }
  });
  return answers;
}
