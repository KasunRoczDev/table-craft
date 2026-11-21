import type { ExecuteResult } from "./plugin.js";
import type { WireValue } from "./values.js";

/**
 * How a key or value's bytes are shown (plan 164). `auto` tries a Schema Registry prefix, then
 * JSON, then UTF-8 text, then hex; `avro`, `protobuf` and `jsonSchema` need the `schemaRegistry`
 * service, and the numeric formats are big-endian, the layout of Java's serializers.
 */
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

/** The columns of a topic read, in order: what `TopicBrowser.read` returns and the tail ships. */
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

export interface TopicSummary {
  readonly name: string;
  /** A broker-managed topic, such as `__consumer_offsets`. */
  readonly internal: boolean;
  readonly partitions: number;
  /** Replicas of the first partition; null when the metadata does not say. */
  readonly replicationFactor: number | null;
  /** High watermarks minus low watermarks over every partition, as a decimal string: an estimate, since compaction and transaction markers leave gaps. Null when unknown. */
  readonly messages: string | null;
}

export interface PartitionInfo {
  readonly partition: number;
  /** Null while the partition has no leader. */
  readonly leader: number | null;
  readonly replicas: readonly number[];
  readonly isr: readonly number[];
  readonly offline: readonly number[];
  /** Decimal strings; null when unknown. */
  readonly low: string | null;
  readonly high: string | null;
  /** Bytes on the leader's log dir, when the broker lets this user describe log dirs. */
  readonly bytes: string | null;
}

export interface ConfigEntry {
  readonly name: string;
  /** Null for a sensitive value, which the broker never returns, or one that is unset. */
  readonly value: string | null;
  /** Where the value comes from, in the broker's words: `DYNAMIC_TOPIC_CONFIG`, `DEFAULT_CONFIG`, ... */
  readonly source: string;
  readonly isDefault: boolean;
  readonly sensitive: boolean;
  readonly readOnly: boolean;
  readonly documentation: string | null;
}

export interface TopicDescription {
  readonly name: string;
  readonly id: string | null;
  readonly internal: boolean;
  readonly partitions: readonly PartitionInfo[];
  readonly configs: readonly ConfigEntry[];
  /** As `TopicSummary.messages`. */
  readonly messages: string | null;
}

/** Where a read, a tail or a delete starts. Offsets are decimal strings; a timestamp is ISO 8601. */
export type TopicStart =
  | { readonly kind: "earliest" }
  | { readonly kind: "latest" }
  /** The newest `count` messages across the chosen partitions, not per partition. */
  | { readonly kind: "latestN"; readonly count: number }
  | { readonly kind: "offset"; readonly offset: string }
  | { readonly kind: "timestamp"; readonly timestamp: string }
  /** A consumer group's committed offsets, where it has them; earliest elsewhere. Needs `consumerGroups`. */
  | { readonly kind: "group"; readonly group: string };

export interface TopicReadRequest {
  readonly topic: string;
  /** Null for every partition. */
  readonly partitions: readonly number[] | null;
  readonly from: TopicStart;
  /** Rows kept, at most `TOPIC_READ_LIMIT`. */
  readonly limit: number;
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
  /** Text the key, value or a header must contain, or `/regex/flags`; null keeps every message. */
  readonly filter: string | null;
  /** Messages fetched before giving up on more matches; null for the datasource's own. */
  readonly maxScan: number | null;
  /** `TopicRead.resume` of the read to continue (Scan Further); null starts at `from`. */
  readonly resume: string | null;
}

export const TOPIC_READ_LIMIT = 50_000;

/**
 * Characters of a key, value or headers cell a read keeps in memory when the host gave it a
 * `MessageSpill`; a longer cell keeps its first `MESSAGE_PREVIEW_CHARS` followed by `…`, and its
 * whole message goes to the spill.
 */
export const MESSAGE_PREVIEW_CHARS = 1024;

/** The full cells of a message whose row shows a preview, as `TOPIC_MESSAGE_COLUMNS` holds them. */
export interface SpilledMessage {
  readonly key: WireValue;
  readonly value: WireValue;
  readonly headers: WireValue;
}

/**
 * Where a read puts the full cells of a large message, so memory keeps only its preview (decision
 * 172). The host reads them back by partition and offset when the user opens the message.
 */
export interface MessageSpill {
  /**
   * Rejects when the host cannot keep the message, such as when its temporary disk space is full;
   * the error's message says why, phrased to follow "The read stopped: ". The read then stops
   * where it is and stays resumable.
   */
  put(partition: number, offset: string, message: SpilledMessage): Promise<void>;
}

export interface TopicRead {
  /** Rows of `TOPIC_MESSAGE_COLUMNS`, ordered by timestamp, partition and offset. */
  readonly result: ExecuteResult;
  /** Messages fetched, matched or not, as a decimal string. */
  readonly scanned: string;
  readonly matched: string;
  /** Every chosen partition was read to its high watermark as it was when the read began. */
  readonly exhausted: boolean;
  /** Continues where this read stopped; null when `exhausted`. */
  readonly resume: string | null;
  /** Said once per read, such as a value that failed its format and is shown as hex. */
  readonly warnings: readonly string[];
}

export interface SchemaReference {
  readonly subject: string;
  /** Null for the latest version. */
  readonly version: number | null;
}

export interface MessageHeader {
  readonly name: string;
  readonly value: string | null;
}

export interface ProduceRecord {
  readonly topic: string;
  /** Null lets the producer's partitioner choose from the key. */
  readonly partition: number | null;
  /** The key and value as text in their format: JSON for the registry formats, hex for `hex`. Null sends a null. */
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: readonly MessageHeader[];
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
  /** The subject a registry format encodes with; null for `<topic>-key` or `<topic>-value` at the latest version. */
  readonly keySchema: SchemaReference | null;
  readonly valueSchema: SchemaReference | null;
}

export interface ProduceResult {
  readonly partition: number;
  /** Null when the broker did not acknowledge an offset. */
  readonly offset: string | null;
}

export interface TopicConfigValue {
  readonly name: string;
  readonly value: string;
}

export interface TopicCreate {
  readonly name: string;
  readonly partitions: number;
  /** Null for the broker's `default.replication.factor`. */
  readonly replicationFactor: number | null;
  readonly configs: readonly TopicConfigValue[];
}

export interface ConfigChange {
  readonly name: string;
  /** Null resets the entry to its default. */
  readonly value: string | null;
}

export interface AdminOptions {
  /** Ask the broker whether it would accept the change and change nothing. */
  readonly validateOnly: boolean;
}

/** Where a delete of records ends: every record before it goes. */
export type RecordsBefore =
  | { readonly kind: "offset"; readonly offset: string }
  | { readonly kind: "timestamp"; readonly timestamp: string }
  | { readonly kind: "latest" };

export interface DeleteRecordsPartition {
  readonly partition: number;
  readonly low: string;
  readonly newLow: string;
  readonly high: string;
  /** `newLow` minus `low`. */
  readonly removed: string;
}

export interface DeleteRecordsPreview {
  /** Applies exactly this preview with `deleteRecordsPrepared`; expires with the session. */
  readonly token: string;
  readonly topic: string;
  readonly partitions: readonly DeleteRecordsPartition[];
  readonly removed: string;
}

export interface TopicTailRequest {
  readonly topic: string;
  readonly partitions: readonly number[] | null;
  readonly from: TopicStart;
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
}

export interface TailMessage {
  readonly partition: number;
  readonly offset: string;
  /** ISO 8601; null when the record has no timestamp. */
  readonly timestamp: string | null;
  /** Decoded as the request's format says. */
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: readonly MessageHeader[];
  readonly size: number;
  readonly keySchema: string | null;
  readonly valueSchema: string | null;
}

export type TopicTailState = "live" | "reconnecting" | "stopped";

export interface TopicTailBatch {
  readonly messages: readonly TailMessage[];
  readonly state: TopicTailState;
  /** Why the tail stopped or reconnects; null while it is live. */
  readonly error: string | null;
}

/**
 * A live read of a topic that joins no group and commits nothing (decision 170). From `latest` it
 * starts at each partition's high watermark as it opens, so only messages produced after that
 * arrive.
 */
export interface TopicTail {
  /**
   * Resolves with what arrived, at most `count` messages and about `maxBytes`, or empty after
   * `timeoutMs`. After `close` it resolves at once, empty, with state `stopped`.
   */
  next(request: {
    readonly count: number;
    readonly maxBytes: number;
    readonly timeoutMs: number;
  }): Promise<TopicTailBatch>;
  close(): Promise<void>;
}

/**
 * The `topics` service (plan 164): a log of partitions addressed by offset. Reading never joins a
 * consumer group and never commits an offset (decision 170). Every write rejects with
 * `statementFailed` on a read-only session before anything is sent. A write that fails with
 * `statementFailed` was refused and changed nothing; one that may have reached the server first
 * (a timeout or a lost connection after sending) carries `outcome: "unknown"` on the error, which
 * the host reports as possibly applied.
 */
export interface TopicBrowser {
  readonly formats: readonly MessageFormat[];
  list(filter: { readonly glob: string | null; readonly internal: boolean }): Promise<readonly TopicSummary[]>;
  describe(topic: string): Promise<TopicDescription>;
  /**
   * With `spill`, a kept message whose key, value or headers cell is longer than
   * `MESSAGE_PREVIEW_CHARS` keeps a preview in its row and puts its full cells in `spill`.
   */
  read(request: TopicReadRequest, spill?: MessageSpill): Promise<TopicRead>;
  produce(record: ProduceRecord): Promise<ProduceResult>;
  create(request: TopicCreate, options: AdminOptions): Promise<void>;
  alterConfigs(topic: string, changes: readonly ConfigChange[], options: AdminOptions): Promise<void>;
  /** Raises the partition count to `total`; Kafka never lowers it. */
  addPartitions(topic: string, total: number, options: AdminOptions): Promise<void>;
  prepareDeleteRecords(
    topic: string,
    partitions: readonly number[] | null,
    before: RecordsBefore,
  ): Promise<DeleteRecordsPreview>;
  deleteRecordsPrepared(token: string): Promise<void>;
  remove(topic: string): Promise<void>;
  tail(request: TopicTailRequest): Promise<TopicTail>;
}
