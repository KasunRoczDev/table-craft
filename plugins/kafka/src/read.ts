import type { Consumer } from "@platformatic/kafka";
import {
  PluginError,
  type MessageFormat,
  type MessageSpill,
  type TopicRead,
  type TopicReadRequest,
} from "@table-craft/plugin-api";
import { isInternalTopic, type KafkaAdmin } from "./admin.js";
import { fetchRound, FETCH_ERRORS, recoveredPosition, type FetchSizes, type PartitionFetch } from "./fetch.js";
import { decode, schemaIdOf, type DecodeOptions } from "./formats.js";
import { refused, statementFailure } from "./failures.js";
import {
  checkStart,
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
import {
  headerTexts,
  isLarge,
  keptCellBytes,
  messageCells,
  messageRow,
  messagesResult,
  previewCells,
  type DecodedMessage,
  type KeptMessage,
} from "./results.js";
import type { SchemaCache } from "./schemaCache.js";

const READ_SIZES: FetchSizes = { maxWaitMs: 100, maxBytes: 4 * 1024 * 1024, partitionMaxBytes: 1024 * 1024 };
/** The end of a followed partition: past any offset Kafka hands out. */
const FOLLOW_END = 2n ** 63n - 1n;
/** A followed read waits at most this long per Fetch, so a cancel lands within it. */
const FOLLOW_WAIT_MS = 500;
/** Rounds in a row in which a partition may answer nothing new before the read gives up on it. */
const MAX_IDLE_ROUNDS = 3;
/** Fetch rounds in a row that may fail outright before the read gives up. */
const MAX_FAILED_ROUNDS = 3;
const CANCELLED = "Cancelled: the read stopped fetching.";
/**
 * The record bytes one read may keep. The row limit alone does not bound memory: 50,000 rows of
 * 1 MB values, or a filter matching every message of a wide Latest N window, would fill the engine.
 */
const READ_KEPT_BYTES = 134_217_728;
/** The memory the rows of a read with a spill may take; their large cells are previews (decision 172). */
const READ_PREVIEW_BYTES = 67_108_864;
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
 * Runs `work` with `topic` tracked by `consumer`, which a Fetch by topic name needs, and untracks
 * it after: every metadata request carries each tracked topic, so one left tracked fails every
 * later read once it is deleted. The consumer's metadata cache drops internal topics and then
 * fails every Fetch while one is tracked, so an internal topic is never tracked.
 */
export async function whileTracked<T>(consumer: Consumer, topic: string, work: () => Promise<T>): Promise<T> {
  if (isInternalTopic(topic)) return work();
  consumer.topics.track(topic);
  try {
    return await work();
  } finally {
    consumer.topics.untrack(topic);
  }
}

/** Waits `ms`, or less when `signal` aborts first. */
export function pause(ms: number, signal: AbortSignal | null): Promise<void> {
  return new Promise((resolve) => {
    const stop = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(stop, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * The topic's id and partition leaders as the fetching consumer sees them; for a topic its
 * metadata cache leaves out, such as an internal one, as the admin reads it. The consumer must
 * track the topic (`whileTracked`).
 */
export async function layoutOf(
  consumer: Consumer,
  admin: KafkaAdmin,
  topic: string,
  wanted: readonly number[] | null,
): Promise<TopicLayout> {
  let info: { readonly id: string; readonly partitions: readonly { readonly leader: number }[] } | undefined;
  if (!isInternalTopic(topic)) {
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
  const from = request.from;
  checkStart(from);
  const marks = await host.admin.topicWatermarks(request.topic, partitions);
  let resolved = new Map<number, bigint>();
  if (from.kind === "timestamp") {
    const millis = timestampMillis(from.timestamp);
    resolved =
      (await host.admin.offsetsAt(new Map([[request.topic, partitions]]), millis)).get(request.topic) ?? resolved;
  } else if (from.kind === "group") {
    resolved = await host.committed(from.group, request.topic, partitions);
  }
  return partitions.flatMap((partition) => {
    const mark = marks.get(partition);
    if (mark === undefined) return [];
    return [{ partition, position: startOffset(from, mark, resolved.get(partition)), end: mark.high, matched: 0 }];
  });
}

/** The formats that look a schema up in the registry. */
const SCHEMA_FORMATS: ReadonlySet<MessageFormat> = new Set(["auto", "avro", "protobuf", "jsonSchema"]);

/** Every schema id a batch of messages names, so the cache fetches them before decoding. */
function schemaIds(
  messages: readonly FetchedMessage[],
  keyFormat: MessageFormat,
  valueFormat: MessageFormat,
): number[] {
  const ids: number[] = [];
  for (const message of messages) {
    if (SCHEMA_FORMATS.has(keyFormat)) {
      const id = schemaIdOf(message.key);
      if (id !== null) ids.push(id);
    }
    if (SCHEMA_FORMATS.has(valueFormat)) {
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

/** Why the spill refused a message, as the host phrased it to follow "The read stopped: ". */
class SpillRefused extends Error {}

/**
 * A matched message as its row, with only the preview of a large message kept when there is a
 * spill; returns the row and the bytes it counts against the read's memory.
 */
async function keep(
  message: DecodedMessage,
  spill: MessageSpill | undefined,
): Promise<{ readonly kept: KeptMessage; readonly bytes: number }> {
  const cells = messageCells(message);
  const place = { partition: message.partition, offset: message.offset, timestamp: message.timestamp };
  if (spill === undefined || !isLarge(cells))
    return { kept: { ...place, row: messageRow(message, cells) }, bytes: keptCellBytes(cells) };
  try {
    await spill.put(message.partition, message.offset.toString(), cells);
  } catch (cause) {
    throw new SpillRefused(cause instanceof Error ? cause.message : String(cause));
  }
  const preview = previewCells(cells);
  return { kept: { ...place, row: messageRow(message, preview) }, bytes: keptCellBytes(preview) };
}

/** Where the scan of one partition's answer left off, and whether the read must stop there. */
interface Taken {
  readonly stop: "spill" | "memory" | null;
}

/**
 * Reads a topic by explicit offsets (decisions 4 and 6 of plan 164): each partition from its start
 * to the high watermark it had when the read began, until `maxScan` messages were fetched; the
 * filter runs over decoded text, and the rows come ordered by timestamp, partition and offset.
 * With `followMs` it reads past the high watermark instead, keeping what arrives until that long
 * has passed, as `kcat` does without `-e`; such a read cannot be resumed. With `spill`, a large
 * message keeps its preview and its full cells go to the spill (decision 172).
 */
export async function readTopic(
  host: ReadHost,
  request: TopicReadRequest,
  followMs: number | null = null,
  spill?: MessageSpill,
): Promise<TopicRead> {
  const consumer = host.fetcher();
  return whileTracked(consumer, request.topic, () => scanTopic(host, consumer, request, followMs, spill));
}

async function scanTopic(
  host: ReadHost,
  consumer: Consumer,
  request: TopicReadRequest,
  followMs: number | null,
  spill: MessageSpill | undefined,
): Promise<TopicRead> {
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
  const kept: KeptMessage[] = [];
  const keptCap = spill === undefined ? READ_KEPT_BYTES : READ_PREVIEW_BYTES;
  let spillStopped = null as string | null;
  const warnings = new Set<string>();
  const idle = new Map<number, number>();
  /** Partitions whose leader did not answer the last time they were asked. */
  const unreachable = new Set<number>();
  let scanned = 0;
  let keptBytes = 0;
  let failedRounds = 0;
  const active = (): PartitionCursor[] =>
    cursors.filter(
      (cursor) =>
        cursor.position < cursor.end &&
        cursor.matched < perPartition &&
        (idle.get(cursor.partition) ?? 0) < MAX_IDLE_ROUNDS,
    );
  // A followed read waits for new messages, so only a forward read counts a partition as idle.
  const noteIdle = (cursor: PartitionCursor, before: bigint): void => {
    if (deadline !== null) return;
    idle.set(cursor.partition, cursor.position === before ? (idle.get(cursor.partition) ?? 0) + 1 : 0);
  };

  const scanAnswer = async (cursor: PartitionCursor, answer: PartitionFetch): Promise<Taken> => {
    const inRange = answer.messages.filter((message) => message.offset < cursor.end);
    const taken = inRange.slice(0, maxScan - scanned);
    scanned += taken.length;
    const decoded = await decodeAll(taken, request, host.registry, host.fullBytes);
    for (const [index, message] of decoded.entries()) {
      for (const decodedPart of [message.decodedKey, message.decodedValue]) {
        if (decodedPart.warning !== null)
          warnings.add(`Some messages ${decodedPart.warning}; they are shown as bytes.`);
      }
      const matches =
        filter === null || filter([message.decodedKey.text, message.decodedValue.text, ...headerTexts(message)]);
      if (!matches || cursor.matched >= perPartition) continue;
      try {
        const { kept: row, bytes } = await keep(message, spill);
        kept.push(row);
        keptBytes += bytes;
      } catch (cause) {
        if (!(cause instanceof SpillRefused)) throw cause;
        spillStopped = cause.message;
        // Scan Further starts again at the message the spill refused.
        cursor.position = message.offset;
        scanned -= decoded.length - index;
        return { stop: "spill" };
      }
      cursor.matched += 1;
      if (keptBytes >= keptCap) {
        cursor.position = message.offset + 1n;
        scanned -= decoded.length - index - 1;
        return { stop: "memory" };
      }
    }
    const last = taken.at(-1);
    if (taken.length < inRange.length && last !== undefined) cursor.position = last.offset + 1n;
    else if (answer.next !== null) cursor.position = answer.next > cursor.end ? cursor.end : answer.next;
    return { stop: null };
  };

  while (
    spillStopped === null &&
    scanned < maxScan &&
    keptBytes < keptCap &&
    (deadline === null || Date.now() < deadline)
  ) {
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
      if (failedRounds >= MAX_FAILED_ROUNDS) throw statementFailure(cause, `Cannot fetch from ${request.topic}: `);
      failedRounds += 1;
      await pause(sizes.maxWaitMs, host.signal);
      checkCancelled(host.signal);
      layout = await layoutOf(consumer, host.admin, request.topic, request.partitions);
      continue;
    }
    failedRounds = 0;
    checkCancelled(host.signal);
    const answered = new Set<number>();
    let stale = false;
    let fetchedAny = false;
    for (const answer of fetched) {
      const cursor = cursors.find((candidate) => candidate.partition === answer.partition);
      if (cursor === undefined) continue;
      answered.add(answer.partition);
      const before = cursor.position;
      if (answer.errorCode === FETCH_ERRORS.offsetOutOfRange) {
        fetchedAny = true;
        unreachable.delete(cursor.partition);
        cursor.position = recoveredPosition(cursor.position, answer, cursor.end);
        continue;
      }
      if (answer.errorCode !== FETCH_ERRORS.none) {
        stale = true;
        unreachable.add(cursor.partition);
        noteIdle(cursor, before);
        continue;
      }
      fetchedAny = true;
      unreachable.delete(cursor.partition);
      const { stop } = await scanAnswer(cursor, answer);
      if (stop !== null) break;
      noteIdle(cursor, before);
    }
    // A fetch session leaves out the partitions that had nothing new.
    for (const target of targets) {
      const cursor = cursors.find((candidate) => candidate.partition === target.partition);
      if (cursor !== undefined && !answered.has(target.partition)) noteIdle(cursor, cursor.position);
    }
    // Without a leader no request went out, so nothing waited: wait here, so a cancel can land
    // and a leader can be elected, instead of spinning.
    if (!fetchedAny && fetched.length > 0) await pause(sizes.maxWaitMs, host.signal);
    if (stale) layout = await layoutOf(consumer, host.admin, request.topic, request.partitions);
  }
  if (spillStopped !== null) {
    warnings.add(`The read stopped: ${spillStopped}; lower the limit or narrow the filter.`);
  } else if (keptBytes >= keptCap) {
    warnings.add(
      `The read stopped after keeping ${String(Math.round(keptBytes / MEBIBYTE))} MB of messages; lower the limit or narrow the filter.`,
    );
  }
  const stuck = cursors.filter(
    (cursor) => cursor.position < cursor.end && (idle.get(cursor.partition) ?? 0) >= MAX_IDLE_ROUNDS,
  );
  for (const cursor of stuck) {
    const at = cursor.position.toString();
    warnings.add(
      unreachable.has(cursor.partition)
        ? `Partition ${String(cursor.partition)} has no leader that answers; it was left at offset ${at}.`
        : `Partition ${String(cursor.partition)} returned nothing past offset ${at}; it was left there.`,
    );
  }
  if (deadline !== null) {
    for (const partition of unreachable) {
      warnings.add(`Partition ${String(partition)} had no leader that answers while the read followed it.`);
    }
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
