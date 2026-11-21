import type { Consumer } from "@platformatic/kafka";
import { PluginError, type MessageFormat, type TopicRead, type TopicReadRequest } from "@table-craft/plugin-api";
import { isInternalTopic, type KafkaAdmin } from "./admin.js";
import { fetchRound, FETCH_ERRORS, type FetchSizes, type PartitionFetch } from "./fetch.js";
import { decode, schemaIdOf, type DecodeOptions } from "./formats.js";
import { refused, statementFailure } from "./failures.js";
import {
  clampLimit,
  messageFilter,
  newestAcross,
  oldestAcross,
  parseResume,
  resumeToken,
  startOffset,
  timestampMillis,
  type FetchedMessage,
  type PartitionCursor,
} from "./readPlan.js";
import { headerTexts, messagesResult, type DecodedMessage } from "./results.js";
import type { SchemaCache } from "./schemaCache.js";

const READ_SIZES: FetchSizes = { maxWaitMs: 100, maxBytes: 4 * 1024 * 1024, partitionMaxBytes: 1024 * 1024 };
/** The end of a followed partition: past any offset Kafka hands out. */
const FOLLOW_END = 2n ** 63n - 1n;
/** A followed read waits at most this long per Fetch, so a cancel lands within it. */
const FOLLOW_WAIT_MS = 500;
/** Rounds in a row in which a partition may answer nothing new before the read gives up on it. */
const MAX_IDLE_ROUNDS = 3;
const MAX_LEADER_REFRESHES = 3;
const CANCELLED = "Cancelled: the read stopped fetching.";
/**
 * The record bytes one read may keep. The row limit alone does not bound memory: 50,000 rows of
 * 1 MB values, or a filter matching every message of a wide Latest N window, would fill the engine.
 */
const READ_KEPT_BYTES = 134_217_728;
const MEBIBYTE = 1_048_576;

/** What a read needs from its session. */
export interface ReadHost {
  readonly admin: KafkaAdmin;
  /** The session's group-less consumer, used for Fetch only. */
  fetcher(): Consumer;
  readonly registry: SchemaCache | null;
  readonly maxScan: number;
  readonly fullBytes: boolean;
  /** Set when the session's `cancel` asks the running read to stop. */
  readonly signal: AbortSignal | null;
  /** A group's committed offset per partition of `topic`, -1 where it has none. */
  committed(group: string, topic: string, partitions: readonly number[]): Promise<Map<number, bigint>>;
}

interface TopicLayout {
  readonly id: string;
  readonly partitions: readonly number[];
  readonly leaders: Map<number, number>;
}

/**
 * The topic's id and partition leaders as the fetching consumer sees them; for a topic its
 * metadata cache leaves out, such as an internal one, as the admin reads it.
 */
export async function layoutOf(
  consumer: Consumer,
  admin: KafkaAdmin,
  topic: string,
  wanted: readonly number[] | null,
): Promise<TopicLayout> {
  let info: { readonly id: string; readonly partitions: readonly { readonly leader: number }[] } | undefined;
  // The consumer's metadata cache drops internal topics and then fails every Fetch while one is
  // tracked, so an internal topic is never tracked and its layout comes from the admin.
  if (!isInternalTopic(topic)) {
    consumer.topics.track(topic);
    try {
      info = (await consumer.metadata({ topics: [topic], forceUpdate: true })).topics.get(topic);
    } catch (cause) {
      throw statementFailure(cause, `Cannot read the partitions of ${topic}: `);
    }
  }
  if (info === undefined) {
    const fallback = await admin.fetchTopic(topic);
    info = { id: fallback.id, partitions: fallback.topic.partitions };
  }
  const all = info.partitions.map((_, index) => index);
  const partitions = wanted === null ? all : [...new Set(wanted)].sort((a, b) => a - b);
  const missing = partitions.filter((partition) => !all.includes(partition));
  if (missing.length > 0) {
    throw refused(`${topic} has partitions 0-${String(all.length - 1)}; there is no partition ${missing.join(", ")}.`);
  }
  const leaders = new Map<number, number>();
  info.partitions.forEach((partition, index) => {
    if (partition.leader >= 0) leaders.set(index, partition.leader);
  });
  return { id: info.id, partitions, leaders };
}

async function startCursors(
  host: ReadHost,
  request: TopicReadRequest,
  partitions: readonly number[],
): Promise<PartitionCursor[]> {
  const marks = await host.admin.topicWatermarks(request.topic, partitions);
  let resolved = new Map<number, bigint>();
  const from = request.from;
  if (from.kind === "timestamp") {
    const millis = timestampMillis(from.timestamp);
    resolved =
      (await host.admin.offsetsAt(new Map([[request.topic, partitions]]), millis)).get(request.topic) ?? resolved;
  } else if (from.kind === "group") {
    resolved = await host.committed(from.group, request.topic, partitions);
  } else if (from.kind === "offset" && !/^\d+$/.test(from.offset)) {
    throw refused(`The start offset ${from.offset} is not a whole number.`);
  }
  return partitions.flatMap((partition) => {
    const mark = marks.get(partition);
    if (mark === undefined) return [];
    return [{ partition, position: startOffset(from, mark, resolved.get(partition)), end: mark.high, matched: 0 }];
  });
}

/** Every schema id a batch of messages names, so the cache fetches them before decoding. */
function schemaIds(
  messages: readonly FetchedMessage[],
  keyFormat: MessageFormat,
  valueFormat: MessageFormat,
): number[] {
  const ids: number[] = [];
  for (const message of messages) {
    if (keyFormat !== "hex" && keyFormat !== "base64") {
      const id = schemaIdOf(message.key);
      if (id !== null) ids.push(id);
    }
    if (valueFormat !== "hex" && valueFormat !== "base64") {
      const id = schemaIdOf(message.value);
      if (id !== null) ids.push(id);
    }
  }
  return ids;
}

/** Decodes fetched messages as the request asks, fetching the schemas they name first. */
export async function decodeAll(
  messages: readonly FetchedMessage[],
  formats: { readonly keyFormat: MessageFormat; readonly valueFormat: MessageFormat },
  registry: SchemaCache | null,
  fullBytes: boolean,
): Promise<DecodedMessage[]> {
  if (registry !== null) await registry.prepare(schemaIds(messages, formats.keyFormat, formats.valueFormat));
  const options: DecodeOptions = { lookup: registry, fullBytes };
  return messages.map((message) => ({
    ...message,
    decodedKey: decode(message.key, formats.keyFormat, options),
    decodedValue: decode(message.value, formats.valueFormat, options),
  }));
}

function checkCancelled(signal: AbortSignal | null): void {
  if (signal?.aborted === true) throw new PluginError("cancelled", CANCELLED);
}

/**
 * Reads a topic by explicit offsets (decisions 4 and 6 of plan 164): each partition from its start
 * to the high watermark it had when the read began, until `maxScan` messages were fetched; the
 * filter runs over decoded text, and the rows come ordered by timestamp, partition and offset.
 * With `followMs` it reads past the high watermark instead, keeping what arrives until that long
 * has passed, as `kcat` does without `-e`; such a read cannot be resumed.
 */
export async function readTopic(
  host: ReadHost,
  request: TopicReadRequest,
  followMs: number | null = null,
): Promise<TopicRead> {
  const consumer = host.fetcher();
  const filter = messageFilter(request.filter);
  const limit = clampLimit(request.limit);
  const maxScan = request.maxScan ?? host.maxScan;
  let layout = await layoutOf(consumer, host.admin, request.topic, request.partitions);
  const resumed = request.resume === null ? null : parseResume(request.resume, request.topic);
  const latest = resumed?.latest ?? (request.from.kind === "latestN" ? request.from.count : null);
  const started = resumed?.cursors ?? (await startCursors(host, request, layout.partitions));
  const cursors = followMs === null ? started : started.map((cursor) => ({ ...cursor, end: FOLLOW_END }));
  const deadline = followMs === null ? null : Date.now() + followMs;
  /** A Latest N read keeps every match of its window; a forward read the first `limit` of each partition. */
  const perPartition = latest === null ? limit : Number.MAX_SAFE_INTEGER;
  const kept: DecodedMessage[] = [];
  const warnings = new Set<string>();
  const idle = new Map<number, number>();
  let scanned = 0;
  let keptBytes = 0;
  let refreshes = 0;
  const active = (): PartitionCursor[] =>
    cursors.filter(
      (cursor) =>
        cursor.position < cursor.end &&
        cursor.matched < perPartition &&
        (idle.get(cursor.partition) ?? 0) < MAX_IDLE_ROUNDS,
    );
  while (scanned < maxScan && keptBytes < READ_KEPT_BYTES && (deadline === null || Date.now() < deadline)) {
    checkCancelled(host.signal);
    const targets = active();
    if (targets.length === 0) break;
    const sizes =
      deadline === null
        ? READ_SIZES
        : { ...READ_SIZES, maxWaitMs: Math.max(0, Math.min(FOLLOW_WAIT_MS, deadline - Date.now())) };
    let fetched: PartitionFetch[];
    try {
      fetched = await fetchRound(consumer, layout.id, layout.leaders, targets, sizes);
    } catch (cause) {
      if (refreshes >= MAX_LEADER_REFRESHES) throw statementFailure(cause, `Cannot fetch from ${request.topic}: `);
      refreshes += 1;
      layout = await layoutOf(consumer, host.admin, request.topic, request.partitions);
      continue;
    }
    checkCancelled(host.signal);
    let stale = false;
    for (const answer of fetched) {
      const cursor = cursors.find((candidate) => candidate.partition === answer.partition);
      if (cursor === undefined) continue;
      if (answer.errorCode === FETCH_ERRORS.offsetOutOfRange) {
        if (cursor.position < answer.logStartOffset) cursor.position = answer.logStartOffset;
        else cursor.position = cursor.end;
        continue;
      }
      if (answer.errorCode !== FETCH_ERRORS.none) {
        stale = true;
        continue;
      }
      const inRange = answer.messages.filter((message) => message.offset < cursor.end);
      const room = maxScan - scanned;
      const taken = inRange.slice(0, room);
      scanned += taken.length;
      const decoded = await decodeAll(taken, request, host.registry, host.fullBytes);
      for (const message of decoded) {
        for (const decodedPart of [message.decodedKey, message.decodedValue]) {
          if (decodedPart.warning !== null)
            warnings.add(`Some messages ${decodedPart.warning}; they are shown as bytes.`);
        }
        const matches =
          filter === null || filter([message.decodedKey.text, message.decodedValue.text, ...headerTexts(message)]);
        if (!matches || cursor.matched >= perPartition) continue;
        kept.push(message);
        keptBytes += message.size;
        cursor.matched += 1;
      }
      const last = taken.at(-1);
      const before = cursor.position;
      if (taken.length < inRange.length && last !== undefined) cursor.position = last.offset + 1n;
      else if (answer.next !== null) cursor.position = answer.next > cursor.end ? cursor.end : answer.next;
      if (deadline === null) {
        idle.set(cursor.partition, cursor.position === before ? (idle.get(cursor.partition) ?? 0) + 1 : 0);
      }
    }
    if (stale) {
      if (refreshes >= MAX_LEADER_REFRESHES)
        throw refused(`The leaders of ${request.topic} keep moving; read it again in a moment.`);
      refreshes += 1;
      layout = await layoutOf(consumer, host.admin, request.topic, request.partitions);
    }
  }
  if (keptBytes >= READ_KEPT_BYTES) {
    warnings.add(
      `The read stopped after keeping ${String(Math.round(keptBytes / MEBIBYTE))} MB of messages; lower the limit or narrow the filter.`,
    );
  }
  const stuck = cursors.filter(
    (cursor) => cursor.position < cursor.end && (idle.get(cursor.partition) ?? 0) >= MAX_IDLE_ROUNDS,
  );
  for (const cursor of stuck) {
    warnings.add(
      `Partition ${String(cursor.partition)} returned nothing past offset ${cursor.position.toString()}; it was left there.`,
    );
  }
  const rows = latest === null ? oldestAcross(kept, limit) : newestAcross(kept, Math.min(limit, latest));
  const exhausted = deadline !== null || cursors.every((cursor) => cursor.position >= cursor.end);
  return {
    result: messagesResult(rows),
    scanned: String(scanned),
    matched: String(kept.length),
    exhausted,
    resume: exhausted ? null : resumeToken(request.topic, cursors, latest),
    warnings: [...warnings],
  };
}
