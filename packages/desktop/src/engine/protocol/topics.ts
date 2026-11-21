import type { ExecutedStatement } from "./sessions.js";
import type { WireValue } from "./wire.js";

/** Mirrors `MESSAGE_FORMATS` in plugin-api (plan 164). */
export const MESSAGE_FORMATS = [
  "auto",
  "string",
  "json",
  "avro",
  "protobuf",
  "jsonSchema",
  "hex",
  "base64",
  "int32",
  "int64",
  "double",
] as const;
export type MessageFormat = (typeof MESSAGE_FORMATS)[number];

/** Mirrors `TOPIC_MESSAGE_COLUMNS` in plugin-api: the columns of a topic read, in order. */
export const TOPIC_MESSAGE_COLUMNS = [
  "partition",
  "offset",
  "timestamp",
  "key",
  "value",
  "headers",
  "size",
  "keySchema",
  "valueSchema",
] as const;

/** Mirrors `TOPIC_READ_LIMIT` in plugin-api: the most rows one read keeps. */
export const TOPIC_READ_LIMIT = 50_000;

/** Mirrors `TopicSummary` in plugin-api. Offsets and counts are decimal strings; null is unknown. */
export interface TopicSummary {
  readonly name: string;
  readonly internal: boolean;
  readonly partitions: number;
  readonly replicationFactor: number | null;
  readonly messages: string | null;
}

/** Mirrors `PartitionInfo` in plugin-api. */
export interface PartitionInfo {
  readonly partition: number;
  readonly leader: number | null;
  readonly replicas: readonly number[];
  readonly isr: readonly number[];
  readonly offline: readonly number[];
  readonly low: string | null;
  readonly high: string | null;
  readonly bytes: string | null;
}

/** Mirrors `ConfigEntry` in plugin-api. */
export interface ConfigEntry {
  readonly name: string;
  readonly value: string | null;
  readonly source: string;
  readonly isDefault: boolean;
  readonly sensitive: boolean;
  readonly readOnly: boolean;
  readonly documentation: string | null;
}

/** Mirrors `TopicDescription` in plugin-api. */
export interface TopicDescription {
  readonly name: string;
  readonly id: string | null;
  readonly internal: boolean;
  readonly partitions: readonly PartitionInfo[];
  readonly configs: readonly ConfigEntry[];
  readonly messages: string | null;
}

/** Mirrors `TopicStart` in plugin-api. Offsets are decimal strings; a timestamp is ISO 8601. */
export type TopicStart =
  | { readonly kind: "earliest" }
  | { readonly kind: "latest" }
  | { readonly kind: "latestN"; readonly count: number }
  | { readonly kind: "offset"; readonly offset: string }
  | { readonly kind: "timestamp"; readonly timestamp: string }
  | { readonly kind: "group"; readonly group: string };

/** Mirrors `TopicReadRequest` in plugin-api. */
export interface TopicReadRequest {
  readonly topic: string;
  readonly partitions: readonly number[] | null;
  readonly from: TopicStart;
  readonly limit: number;
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
  readonly filter: string | null;
  readonly maxScan: number | null;
  readonly resume: string | null;
}

/** `TopicRead` in plugin-api without its rows, which stay in the result store (decision 009). */
export interface TopicReadInfo {
  readonly scanned: string;
  readonly matched: string;
  readonly exhausted: boolean;
  /** Pass as `TopicReadRequest.resume` to scan further; null when `exhausted`. */
  readonly resume: string | null;
  readonly warnings: readonly string[];
}

/** A topic read opened in its tab: the read's counters, and its rows as a held result. */
export interface OpenedTopic {
  readonly read: TopicReadInfo;
  readonly statement: ExecutedStatement;
}

/** Mirrors `SchemaReference` in plugin-api. */
export interface SchemaReference {
  readonly subject: string;
  readonly version: number | null;
}

/** Mirrors `MessageHeader` in plugin-api. */
export interface MessageHeader {
  readonly name: string;
  readonly value: string | null;
}

/** Mirrors `ProduceRecord` in plugin-api. */
export interface ProduceRecord {
  readonly topic: string;
  readonly partition: number | null;
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: readonly MessageHeader[];
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
  readonly keySchema: SchemaReference | null;
  readonly valueSchema: SchemaReference | null;
}

/** Mirrors `ProduceResult` in plugin-api. */
export interface ProduceResult {
  readonly partition: number;
  readonly offset: string | null;
}

/** Mirrors `TopicConfigValue` in plugin-api. */
export interface TopicConfigValue {
  readonly name: string;
  readonly value: string;
}

/** Mirrors `TopicCreate` in plugin-api. */
export interface TopicCreate {
  readonly name: string;
  readonly partitions: number;
  readonly replicationFactor: number | null;
  readonly configs: readonly TopicConfigValue[];
}

/** Mirrors `ConfigChange` in plugin-api: a null value resets the entry to its default. */
export interface ConfigChange {
  readonly name: string;
  readonly value: string | null;
}

/** Mirrors `RecordsBefore` in plugin-api. */
export type RecordsBefore =
  | { readonly kind: "offset"; readonly offset: string }
  | { readonly kind: "timestamp"; readonly timestamp: string }
  | { readonly kind: "latest" };

/** Mirrors `DeleteRecordsPartition` in plugin-api. */
export interface DeleteRecordsPartition {
  readonly partition: number;
  readonly low: string;
  readonly newLow: string;
  readonly high: string;
  readonly removed: string;
}

/** Mirrors `DeleteRecordsPreview` in plugin-api. */
export interface DeleteRecordsPreview {
  readonly token: string;
  readonly topic: string;
  readonly partitions: readonly DeleteRecordsPartition[];
  readonly removed: string;
}

/** Mirrors `TopicTailRequest` in plugin-api. */
export interface TopicTailRequest {
  readonly topic: string;
  readonly partitions: readonly number[] | null;
  readonly from: TopicStart;
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
}

/** Mirrors `TailMessage` in plugin-api. */
export interface TailMessage {
  readonly partition: number;
  readonly offset: string;
  readonly timestamp: string | null;
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: readonly MessageHeader[];
  readonly size: number;
  readonly keySchema: string | null;
  readonly valueSchema: string | null;
}

/** Mirrors `MESSAGE_PREVIEW_CHARS` in plugin-api: what a spilled cell keeps in memory, before its `…`. */
export const MESSAGE_PREVIEW_CHARS = 1024;

/** Mirrors `SpilledMessage` in plugin-api: the full cells `topics.message` reads back. */
export interface SpilledMessage {
  readonly key: WireValue;
  readonly value: WireValue;
  readonly headers: WireValue;
}

/** Mirrors `TopicTailState` in plugin-api. */
export type TopicTailState = "live" | "reconnecting" | "stopped";

/** The most messages and bytes a tail's ring holds; the oldest go first past either. */
export const TOPIC_TAIL_MAX_MESSAGES = 100_000;
export const TOPIC_TAIL_MAX_RING_BYTES = 67_108_864;
/** What a tail's file of large messages holds on disk; past it the oldest are deleted (decision 172). */
export const TOPIC_TAIL_SPILL_BYTES = 536_870_912;
/** The most messages and bytes one `topics.tailWindow` answers with. */
export const TOPIC_TAIL_MAX_WINDOW = 1_000;
export const TOPIC_TAIL_MAX_WINDOW_BYTES = 4_194_304;

export interface TopicTailSummary {
  readonly tailId: string;
  readonly request: TopicTailRequest;
  readonly state: TopicTailState;
  /** Why the tail stopped or reconnects; null while it is live. */
  readonly error: string | null;
  /** Messages the ring dropped since the tail started, as a decimal string. */
  readonly dropped: string;
}

export interface TopicTailRow {
  /** The engine's own order of arrival, a decimal string; never the Kafka offset. */
  readonly sequence: string;
  readonly message: TailMessage;
}

export interface TopicTailWindow extends TopicTailSummary {
  readonly rows: readonly TopicTailRow[];
  /**
   * Messages after the request's `after` the ring dropped before they were read, as a decimal
   * string: the gap row ("dropped 3,120 messages") shown before `rows`. Never counts a clear.
   */
  readonly skipped: string;
  /** The `after` of the next window: the last sequence this one covered, its rows or its gap. */
  readonly through: string | null;
}
