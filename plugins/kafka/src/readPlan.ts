import { TOPIC_READ_LIMIT, type TopicStart } from "@table-craft/plugin-api";
import { refused } from "./failures.js";

/** One record as fetched, before decoding. */
export interface FetchedMessage {
  readonly partition: number;
  readonly offset: bigint;
  /** Milliseconds since the epoch; null when the record carries none. */
  readonly timestamp: bigint | null;
  readonly key: Buffer | null;
  readonly value: Buffer | null;
  readonly headers: readonly (readonly [Buffer | null, Buffer | null])[];
  /** Key, value and header bytes. */
  readonly size: number;
}

/** Where one partition's read stands: the next offset to fetch, and the offset it stops before. */
export interface PartitionCursor {
  readonly partition: number;
  position: bigint;
  readonly end: bigint;
  matched: number;
}

const RESUME_VERSION = 1;
const NO_TIMESTAMP = -1n;
const REGEX_LITERAL = /^\/(.*)\/([a-z]*)$/s;

/** Rows come ordered by timestamp, then partition, then offset (decision 6); no timestamp sorts first. */
export function compareMessages(a: FetchedMessage, b: FetchedMessage): number {
  const at = a.timestamp ?? NO_TIMESTAMP;
  const bt = b.timestamp ?? NO_TIMESTAMP;
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.partition !== b.partition) return a.partition - b.partition;
  if (a.offset === b.offset) return 0;
  return a.offset < b.offset ? -1 : 1;
}

/** The newest `count` across every partition, oldest first: "last 500" of the topic, not of each partition. */
export function newestAcross<T extends FetchedMessage>(messages: readonly T[], count: number): T[] {
  const ordered = [...messages].sort(compareMessages);
  return count <= 0 ? [] : ordered.slice(Math.max(0, ordered.length - count));
}

/** The oldest `count` across every partition, in order. */
export function oldestAcross<T extends FetchedMessage>(messages: readonly T[], count: number): T[] {
  return [...messages].sort(compareMessages).slice(0, Math.max(0, count));
}

/** Rows a read keeps: at least one, at most `TOPIC_READ_LIMIT`. */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return TOPIC_READ_LIMIT;
  return Math.min(TOPIC_READ_LIMIT, Math.max(1, Math.trunc(limit)));
}

function clamp(offset: bigint, low: bigint, high: bigint): bigint {
  if (offset < low) return low;
  return offset > high ? high : offset;
}

export interface Watermark {
  readonly low: bigint;
  readonly high: bigint;
}

/**
 * The first offset each partition reads from, for the starts that need no broker lookup;
 * `resolved` holds the answers for a timestamp or a group (-1 where there is none).
 */
export function startOffset(from: TopicStart, mark: Watermark, resolved: bigint | undefined): bigint {
  switch (from.kind) {
    case "earliest":
      return mark.low;
    case "latest":
      return mark.high;
    case "latestN": {
      const back = mark.high - BigInt(Math.max(0, Math.trunc(from.count)));
      return back < mark.low ? mark.low : back;
    }
    case "offset":
      return clamp(BigInt(from.offset), mark.low, mark.high);
    case "timestamp":
      return resolved === undefined || resolved < 0n ? mark.high : clamp(resolved, mark.low, mark.high);
    case "group":
      return resolved === undefined || resolved < 0n ? mark.low : clamp(resolved, mark.low, mark.high);
  }
}

/** Milliseconds of an ISO 8601 timestamp, refused with the expected form when it is not one. */
export function timestampMillis(text: string): bigint {
  const millis = Date.parse(text);
  if (Number.isNaN(millis)) {
    throw refused(`${text} is not a timestamp; write it as ISO 8601, such as 2026-11-21T09:15:00Z.`);
  }
  return BigInt(millis);
}

/** A test over a message's decoded texts: a substring, or `/regex/flags`; null keeps everything. */
export function messageFilter(filter: string | null): ((texts: readonly (string | null)[]) => boolean) | null {
  if (filter === null || filter === "") return null;
  const literal = REGEX_LITERAL.exec(filter);
  if (literal !== null) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(literal[1] ?? "", (literal[2] ?? "").replaceAll("g", ""));
    } catch (error) {
      throw refused(
        `The filter ${filter} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
    return (texts) => texts.some((text) => text !== null && pattern.test(text));
  }
  return (texts) => texts.some((text) => text !== null && text.includes(filter));
}

interface ResumeState {
  readonly v: number;
  readonly topic: string;
  readonly cursors: readonly (readonly [number, string, string])[];
  readonly latest: number | null;
}

/** A token that continues a read where it stopped (Scan further). */
export function resumeToken(topic: string, cursors: readonly PartitionCursor[], latest: number | null): string {
  const state: ResumeState = {
    v: RESUME_VERSION,
    topic,
    cursors: cursors.map((cursor) => [cursor.partition, cursor.position.toString(), cursor.end.toString()]),
    latest,
  };
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

function cursorOf(entry: unknown): PartitionCursor | null {
  if (!Array.isArray(entry) || entry.length !== 3) return null;
  const [partition, position, end] = entry as unknown[];
  if (typeof partition !== "number" || typeof position !== "string" || typeof end !== "string") return null;
  return { partition, position: BigInt(position), end: BigInt(end), matched: 0 };
}

export function parseResume(token: string, topic: string): { cursors: PartitionCursor[]; latest: number | null } {
  const damaged = refused("The read cannot continue: its resume token is damaged. Read the topic again.");
  let state: Partial<Record<keyof ResumeState, unknown>>;
  try {
    state = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<Record<keyof ResumeState, unknown>>;
  } catch {
    throw damaged;
  }
  if (state.v !== RESUME_VERSION || state.topic !== topic || !Array.isArray(state.cursors)) {
    throw refused(`The resume token belongs to another read than ${topic}. Read the topic again.`);
  }
  const cursors = (state.cursors as unknown[]).map(cursorOf);
  if (cursors.some((cursor) => cursor === null)) throw damaged;
  return {
    cursors: cursors.filter((cursor): cursor is PartitionCursor => cursor !== null),
    latest: typeof state.latest === "number" ? state.latest : null,
  };
}
