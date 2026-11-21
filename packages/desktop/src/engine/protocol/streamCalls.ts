import type { ResultPaging, StatementLimit } from "./wire.js";
import type {
  ConfigChange,
  DeleteRecordsPreview,
  OpenedTopic,
  ProduceRecord,
  ProduceResult,
  RecordsBefore,
  SpilledMessage,
  TailMessage,
  TopicCreate,
  TopicDescription,
  TopicReadRequest,
  TopicSummary,
  TopicTailRequest,
  TopicTailSummary,
  TopicTailWindow,
} from "./topics.js";
import type { GroupDescription, GroupSummary, ResetPreview, ResetScope, ResetTarget } from "./groups.js";
import type {
  CompatibilityCheck,
  RegisteredSchema,
  SchemaRegistryStatus,
  SchemaType,
  SchemaVersion,
  SubjectSummary,
} from "./schemas.js";

/** Kafka's own limit on a topic name. */
export const TOPIC_NAME_MAX_LENGTH = 249;
/** A group id, subject, config name or glob longer than this is refused before it reaches the plugin. */
export const STREAM_NAME_MAX_LENGTH = 1_024;
/** A produced key or value, or a header value, as text; Kafka's default `message.max.bytes` is 1 MiB. */
export const PRODUCE_TEXT_MAX_LENGTH = 4_194_304;
export const PRODUCE_MAX_HEADERS = 256;
/** A schema's text for `schemas.check` and `schemas.register`. */
export const SCHEMA_TEXT_MAX_LENGTH = 1_048_576;

/**
 * The calls of a datasource that declares `topics`, `consumerGroups` or `schemaRegistry` (plan 164).
 * Reads run on the engine's helper session; writes, and the prepares their tokens bind to, run one
 * at a time on the engine's admin session, refused on a read-only datasource before the plugin
 * hears of them, and never retried (decision 139). Offsets and counts are decimal strings.
 */
export interface StreamCalls {
  /** Topics whose name matches `glob` (null: every one); broker-internal ones only with `internal`. Needs `topics`. */
  "topics.list": {
    params: { readonly glob: string | null; readonly internal: boolean };
    result: readonly TopicSummary[];
  };
  /** Partitions, watermarks and configs of `topic`. Needs `topics`. */
  "topics.describe": { params: { readonly topic: string }; result: TopicDescription };
  /**
   * Reads messages on the topic tab's session without joining a group or committing (decision 4);
   * the rows go to the result store like a statement's, the counters come back. Needs `topics`.
   */
  "topics.open": {
    params: {
      readonly sessionId: string;
      readonly request: TopicReadRequest;
      /** Keeps a preview of each large message in the rows and the full one on disk (decision 172); default true. */
      readonly spill?: boolean;
    } & ResultPaging &
      StatementLimit;
    result: OpenedTopic;
  };
  /**
   * The full key, value and headers of one message a `topics.open` result shows, read back from its
   * spill; null when the result does not hold it.
   */
  "topics.message": {
    params: { readonly handle: string; readonly partition: number; readonly offset: string };
    result: SpilledMessage | null;
  };
  /** Sends one record. A write. Needs `topics`. */
  "topics.produce": { params: { readonly record: ProduceRecord }; result: ProduceResult };
  /** Creates a topic, or with `validateOnly` asks the broker whether it would. A write. Needs `topics`. */
  "topics.create": { params: { readonly request: TopicCreate; readonly validateOnly: boolean }; result: null };
  /** Incrementally alters `topic`'s configs; a null value resets one. A write. Needs `topics`. */
  "topics.alterConfigs": {
    params: { readonly topic: string; readonly changes: readonly ConfigChange[]; readonly validateOnly: boolean };
    result: null;
  };
  /** Raises `topic`'s partition count to `total`. A write. Needs `topics`. */
  "topics.addPartitions": {
    params: { readonly topic: string; readonly total: number; readonly validateOnly: boolean };
    result: null;
  };
  /** How each partition's low watermark would move, and the token `topics.deleteRecords` applies. Needs `topics`. */
  "topics.prepareDeleteRecords": {
    params: { readonly topic: string; readonly partitions: readonly number[] | null; readonly before: RecordsBefore };
    result: DeleteRecordsPreview;
  };
  /** Deletes exactly what `topics.prepareDeleteRecords` previewed. A write. Needs `topics`. */
  "topics.deleteRecords": { params: { readonly token: string }; result: null };
  /** Deletes the topic. A write. Needs `topics`. */
  "topics.delete": { params: { readonly topic: string }; result: null };
  /**
   * Starts a live tail on a dedicated session; the engine pulls it into a ring of at most
   * `maxMessages` and `maxBytes`, dropping the oldest past either. Needs `topics`.
   */
  "topics.tailStart": {
    params: TopicTailRequest & {
      readonly maxMessages: number;
      readonly maxBytes: number;
      /** Holds large messages as previews and the full ones on disk, the oldest dropped first; default true. */
      readonly spill?: boolean;
    };
    result: TopicTailSummary;
  };
  /** The full message of sequence `sequence`; null once the ring or its file dropped it. */
  "topics.tailMessage": {
    params: { readonly tailId: string; readonly sequence: string };
    result: TailMessage | null;
  };
  /** The held messages after sequence `after` (null: from the oldest held), and the gap before them. */
  "topics.tailWindow": {
    params: {
      readonly tailId: string;
      readonly after: string | null;
      readonly count: number;
      readonly maxBytes: number;
    };
    result: TopicTailWindow;
  };
  /** Stops the tail and closes its session; its ring stays readable until the port closes. */
  "topics.tailStop": { params: { readonly tailId: string }; result: null };
  /** Empties the tail's ring; a cleared message never counts as skipped. */
  "topics.tailClear": { params: { readonly tailId: string }; result: null };
  /** Every tail of this port, running or stopped, for a renderer that reloaded. */
  "topics.tailList": { params: Record<never, never>; result: readonly TopicTailSummary[] };
  /** Every consumer group. Needs `consumerGroups`. */
  "groups.list": { params: Record<never, never>; result: readonly GroupSummary[] };
  /** Members, committed offsets and lag of `group`. Needs `consumerGroups`. */
  "groups.describe": { params: { readonly group: string }; result: GroupDescription };
  /** The groups with committed offsets on `topic`, with their lag there. Needs `consumerGroups`. */
  "groups.consumersOf": { params: { readonly topic: string }; result: readonly GroupSummary[] };
  /** Per partition `current → next` and the lag change, and the token `groups.applyReset` applies. Needs `consumerGroups`. */
  "groups.prepareReset": {
    params: { readonly group: string; readonly scope: ResetScope; readonly target: ResetTarget };
    result: ResetPreview;
  };
  /** Commits exactly the previewed offsets. A write. Needs `consumerGroups`. */
  "groups.applyReset": { params: { readonly token: string }; result: null };
  /** Deletes `group`'s committed offsets on `topic`. A write. Needs `consumerGroups`. */
  "groups.deleteOffsets": { params: { readonly group: string; readonly topic: string }; result: null };
  /** Deletes the group; the broker refuses while it has members. A write. Needs `consumerGroups`. */
  "groups.delete": { params: { readonly group: string }; result: null };
  /** Whether the registry can be used; the other `schemas.*` calls fail while it cannot. Needs `schemaRegistry`. */
  "schemas.status": { params: Record<never, never>; result: SchemaRegistryStatus };
  /** Subjects matching `glob` (null: every one). Needs `schemaRegistry`. */
  "schemas.subjects": { params: { readonly glob: string | null }; result: readonly SubjectSummary[] };
  /** `subject`'s versions, oldest first. Needs `schemaRegistry`. */
  "schemas.versions": { params: { readonly subject: string }; result: readonly number[] };
  /** One version of `subject`, or the latest for null. Needs `schemaRegistry`. */
  "schemas.get": { params: { readonly subject: string; readonly version: number | null }; result: SchemaVersion };
  /** Whether `schema` could be registered as `subject`'s next version. Needs `schemaRegistry`. */
  "schemas.check": {
    params: { readonly subject: string; readonly schemaType: SchemaType; readonly schema: string };
    result: CompatibilityCheck;
  };
  /** Registers `schema` under `subject`. A write. Needs `schemaRegistry`. */
  "schemas.register": {
    params: { readonly subject: string; readonly schemaType: SchemaType; readonly schema: string };
    result: RegisteredSchema;
  };
  /**
   * The compatibility level of `subject`, or the global one for null; with a `level`, sets it first,
   * which is a write. Needs `schemaRegistry`.
   */
  "schemas.compatibility": {
    params: { readonly subject: string | null; readonly level: string | null };
    result: string;
  };
  /**
   * Soft-deletes a version, or the subject for null; `permanent` hard-deletes what is already
   * soft-deleted. Answers the versions deleted. A write. Needs `schemaRegistry`.
   */
  "schemas.delete": {
    params: { readonly subject: string; readonly version: number | null; readonly permanent: boolean };
    result: readonly number[];
  };
}
