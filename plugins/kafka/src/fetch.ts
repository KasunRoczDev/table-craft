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
  none: 0,
  offsetOutOfRange: 1,
  unknownTopicOrPartition: 3,
  notLeader: 6,
  fencedLeaderEpoch: 74,
  unknownLeaderEpoch: 75,
} as const;

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
 * One Fetch per partition leader, by explicit offset (decision 4): no JoinGroup, no OffsetCommit,
 * no group request of any kind. The consumer must track the topic first, so brokers that take
 * Fetch v12 and older get its name rather than its id.
 */
export async function fetchRound(
  consumer: Consumer,
  topicId: string,
  leaders: ReadonlyMap<number, number>,
  targets: readonly FetchTarget[],
  sizes: FetchSizes,
): Promise<PartitionFetch[]> {
  const byLeader = new Map<number, FetchTarget[]>();
  for (const target of targets) {
    const leader = leaders.get(target.partition);
    if (leader === undefined) continue;
    byLeader.set(leader, [...(byLeader.get(leader) ?? []), target]);
  }
  const rounds = await Promise.all(
    [...byLeader.entries()].map(async ([node, group]) => {
      const positions = new Map(group.map((target) => [target.partition, target.position]));
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
    }),
  );
  return rounds.flat();
}
