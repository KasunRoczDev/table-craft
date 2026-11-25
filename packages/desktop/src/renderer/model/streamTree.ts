import type {
  EngineError,
  GroupSummary,
  SchemaRegistryStatus,
  ServerNode,
  SubjectSummary,
  TopicSummary,
} from "@table-craft/desktop/engine/protocol.js";
import type { ConfigValue } from "@table-craft/desktop/preload/bridge.js";
import type { ErrorNode, ExplorerNode, LoadingNode } from "@table-craft/desktop/renderer/model/explorerTree.js";

/** Plan 164 decision 3: a group's total lag above this reads as a warning, unless the datasource sets its own. */
export const DEFAULT_LAG_WARNING = 10_000;
/** The connection field that overrides `DEFAULT_LAG_WARNING`. */
export const LAG_WARNING_FIELD = "lagWarning";
/** Topics fold into folders at their first dot, as `orders.v1` sits under `orders.`. */
export const TOPIC_DELIMITER = ".";

/** What the renderer holds of one stream datasource (decision 169); it dies with the engine. */
export interface DatasourceStreams {
  /** Every topic, internal ones included; null until listed. */
  readonly topics: readonly TopicSummary[] | null;
  /** Null until listed, and always without `consumerGroups`. */
  readonly groups: readonly GroupSummary[] | null;
  readonly registry: SchemaRegistryStatus | null;
  readonly subjects: readonly SubjectSummary[] | null;
  readonly brokers: readonly ServerNode[];
  readonly loading: boolean;
  readonly error: EngineError | null;
}

export const EMPTY_STREAMS: DatasourceStreams = {
  topics: null,
  groups: null,
  registry: null,
  subjects: null,
  brokers: [],
  loading: false,
  error: null,
};

export const STREAM_SECTIONS = ["topics", "groups", "brokers", "subjects"] as const;
export type StreamSection = (typeof STREAM_SECTIONS)[number];

export const STREAM_SECTION_LABELS: Readonly<Record<StreamSection, string>> = {
  topics: "Topics",
  groups: "Consumer groups",
  brokers: "Brokers",
  subjects: "Subjects",
};

interface StreamNodeBase {
  readonly datasourceId: string;
  /** Always empty: a stream datasource has no namespaces, but every catalog row carries a path. */
  readonly path: readonly string[];
}

export interface StreamSectionNode extends StreamNodeBase {
  readonly kind: "streamSection";
  readonly section: StreamSection;
  readonly count: number;
}

export interface TopicFolderNode extends StreamNodeBase {
  readonly kind: "topicFolder";
  /** The folder's name with the dot after it, as `orders.`. */
  readonly prefix: string;
  readonly count: number;
}

export interface TopicNode extends StreamNodeBase {
  readonly kind: "topic";
  readonly topic: TopicSummary;
}

export interface ConsumerGroupNode extends StreamNodeBase {
  readonly kind: "consumerGroup";
  readonly group: GroupSummary;
  /** The group's total lag is above the datasource's lag warning. */
  readonly lagging: boolean;
}

export interface BrokerNode extends StreamNodeBase {
  readonly kind: "broker";
  readonly broker: ServerNode;
}

export interface SubjectNode extends StreamNodeBase {
  readonly kind: "subject";
  readonly subject: SubjectSummary;
}

export type StreamTreeNode =
  StreamSectionNode | TopicFolderNode | TopicNode | ConsumerGroupNode | BrokerNode | SubjectNode;

export const STREAM_TREE_KINDS: ReadonlySet<string> = new Set([
  "streamSection",
  "topicFolder",
  "topic",
  "consumerGroup",
  "broker",
  "subject",
]);

/** Where the stream tree's rows go; `explorerTree` owns the row list and the key scheme. */
export interface StreamRowSink {
  readonly push: (node: ExplorerNode, depth: number, key: string, label: string, expandable: boolean) => boolean;
  readonly keyOf: (...parts: readonly unknown[]) => string;
}

export interface StreamTreeOptions {
  /** Broker-internal topics such as `__consumer_offsets` show (Show System Schemas). */
  readonly showInternal: boolean;
  readonly lagWarning: number;
  /** The topics Manage Shown Topics keeps; null or absent keeps them all. */
  readonly shown?: ReadonlySet<string> | null;
}

export function streamSectionKey(sink: Pick<StreamRowSink, "keyOf">, section: StreamSection): string {
  return sink.keyOf("streamSection", section);
}

export function topicRowKey(sink: Pick<StreamRowSink, "keyOf">, topic: string): string {
  return sink.keyOf("topic", topic);
}

export function groupRowKey(sink: Pick<StreamRowSink, "keyOf">, group: string): string {
  return sink.keyOf("consumerGroup", group);
}

/** A decimal count or offset as a bigint; null when unknown or not a whole number. */
export function bigOf(text: string | null | undefined): bigint | null {
  if (text == null || !/^-?\d+$/.test(text)) return null;
  return BigInt(text);
}

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/** `14`, `~84 k`, `~3.4 M`: a message count the tree labels as an estimate. */
export function approxCount(count: string | null): string | null {
  const value = bigOf(count);
  if (value === null) return null;
  const number = Number(value);
  if (number < THOUSAND) return value.toString();
  if (number < MILLION) return `~${Math.round(number / THOUSAND).toLocaleString("en-US")} k`;
  if (number < BILLION) return `~${(number / MILLION).toFixed(1)} M`;
  return `~${(number / BILLION).toFixed(1)} B`;
}

/** `partition` beside a count that reads `1`, `partitions` beside any other. */
export function nounFor(count: string | number, singular: string): string {
  return String(count) === "1" ? singular : `${singular}s`;
}

/** `12 partitions · ~3.4 M messages`, as a topic row reads. */
export function topicDetail(topic: Pick<TopicSummary, "partitions" | "messages">): string {
  const partitions = `${String(topic.partitions)} ${nounFor(topic.partitions, "partition")}`;
  const messages = approxCount(topic.messages);
  return messages === null ? partitions : `${partitions} · ${messages} ${nounFor(messages, "message")}`;
}

export type GroupStateTone = "neutral" | "success" | "warning" | "danger";

const REBALANCING_STATES: ReadonlySet<string> = new Set(["PreparingRebalance", "CompletingRebalance"]);

/** How a group's state badge reads (audit m5): Empty is calm unless it lags, a rebalance warns, Dead is an error. */
export function groupStateTone(state: string, lagging: boolean): GroupStateTone {
  if (state === "Dead") return "danger";
  if (REBALANCING_STATES.has(state)) return "warning";
  if (state === "Stable") return lagging ? "warning" : "success";
  return lagging ? "warning" : "neutral";
}

/** The lag warning a datasource sets in its Advanced fields, or the default. */
export function lagWarningOf(config: Readonly<Record<string, ConfigValue>>): number {
  const value = Number(config[LAG_WARNING_FIELD]);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LAG_WARNING;
}

export function lagExceeds(lag: string | null, threshold: number): boolean {
  const value = bigOf(lag);
  return value !== null && value > BigInt(Math.floor(threshold));
}

/** The folder a topic sits in, `orders.` for `orders.v1`; null at the top. */
export function topicFolderOf(name: string): string | null {
  const at = name.indexOf(TOPIC_DELIMITER);
  return at <= 0 || at === name.length - 1 ? null : name.slice(0, at + TOPIC_DELIMITER.length);
}

export interface TopicFolders {
  readonly folders: readonly { readonly prefix: string; readonly topics: readonly TopicSummary[] }[];
  readonly loose: readonly TopicSummary[];
}

const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * The topics as one level of folders split at their first dot, folders first and each sorted. A
 * prefix folds only when at least two topics share it and not every topic does (audit m1): a lone
 * `audit.log` or a cluster whose topics all start `prod.` gains nothing from a folder.
 */
export function topicFolders(topics: readonly TopicSummary[]): TopicFolders {
  const byPrefix = new Map<string, TopicSummary[]>();
  const loose: TopicSummary[] = [];
  for (const topic of topics) {
    const folder = topicFolderOf(topic.name);
    if (folder === null) loose.push(topic);
    else byPrefix.set(folder, [...(byPrefix.get(folder) ?? []), topic]);
  }
  const folders = new Map<string, TopicSummary[]>();
  for (const [prefix, members] of byPrefix) {
    if (members.length >= 2 && members.length < topics.length) folders.set(prefix, members);
    else loose.push(...members);
  }
  const sorted = (list: readonly TopicSummary[]) => [...list].sort((a, b) => byName(a.name, b.name));
  return {
    folders: [...folders.entries()]
      .sort(([a], [b]) => byName(a, b))
      .map(([prefix, members]) => ({ prefix, topics: sorted(members) })),
    loose: sorted(loose),
  };
}

/** The topics the tree lists: internal ones only when asked, and only those `shown` keeps. */
export function shownTopics(
  topics: readonly TopicSummary[],
  showInternal: boolean,
  shown: ReadonlySet<string> | null = null,
): readonly TopicSummary[] {
  return topics.filter((topic) => (showInternal || !topic.internal) && (shown === null || shown.has(topic.name)));
}

/** The topics Manage Shown Topics keeps (decision 117); null when it keeps them all. */
export function shownTopicFilter(datasource: {
  readonly shownTopics?: readonly string[] | undefined;
}): ReadonlySet<string> | null {
  return datasource.shownTopics === undefined ? null : new Set(datasource.shownTopics);
}

/**
 * How many listed topics Manage Shown Topics keeps, for the datasource row's "N of M"; null when it
 * keeps them all or nothing is listed yet. Hidden internal topics count on neither side.
 */
export function shownTopicCount(
  datasource: { readonly shownTopics?: readonly string[] | undefined },
  topics: readonly TopicSummary[] | null,
  showInternal: boolean,
): { readonly shown: number; readonly total: number } | null {
  const filter = shownTopicFilter(datasource);
  if (filter === null || topics === null) return null;
  const listed = shownTopics(topics, showInternal);
  return { shown: shownTopics(listed, true, filter).length, total: listed.length };
}

/** A topic row keeps its full name under its folder, so the name read is the name typed (audit m1). */
function topicRow(sink: StreamRowSink, base: StreamNodeBase, topic: TopicSummary, depth: number) {
  const node: TopicNode = { ...base, kind: "topic", topic };
  sink.push(node, depth, topicRowKey(sink, topic.name), topic.name, false);
}

function section(sink: StreamRowSink, base: StreamNodeBase, name: StreamSection, count: number, depth: number) {
  const node: StreamSectionNode = { ...base, kind: "streamSection", section: name, count };
  return sink.push(node, depth, streamSectionKey(sink, name), STREAM_SECTION_LABELS[name], true);
}

/**
 * A stream datasource's rows under its node (decision 169): Topics folded at their first dot,
 * Consumer groups with their state and lag, Brokers, and Subjects while the registry answers.
 */
export function streamRows(
  sink: StreamRowSink,
  datasourceId: string,
  streams: DatasourceStreams,
  options: StreamTreeOptions,
  depth: number,
): void {
  if (streams.topics === null) {
    if (streams.error !== null) {
      const error: ErrorNode = { kind: "error", datasourceId, error: streams.error };
      sink.push(error, depth, sink.keyOf("streamError"), streams.error.message, false);
    } else {
      const loading: LoadingNode = { kind: "loading", datasourceId };
      sink.push(loading, depth, sink.keyOf("streamLoading"), "", false);
    }
    return;
  }
  const base: StreamNodeBase = { datasourceId, path: [] };
  const topics = shownTopics(streams.topics, options.showInternal, options.shown ?? null);
  if (section(sink, base, "topics", topics.length, depth)) {
    const { folders, loose } = topicFolders(topics);
    for (const folder of folders) {
      const node: TopicFolderNode = {
        ...base,
        kind: "topicFolder",
        prefix: folder.prefix,
        count: folder.topics.length,
      };
      if (!sink.push(node, depth + 1, sink.keyOf("topicFolder", folder.prefix), folder.prefix, true)) continue;
      for (const topic of folder.topics) topicRow(sink, base, topic, depth + 2);
    }
    for (const topic of loose) topicRow(sink, base, topic, depth + 1);
  }
  if (streams.groups !== null && section(sink, base, "groups", streams.groups.length, depth)) {
    for (const group of [...streams.groups].sort((a, b) => byName(a.id, b.id))) {
      const node: ConsumerGroupNode = {
        ...base,
        kind: "consumerGroup",
        group,
        lagging: lagExceeds(group.lag, options.lagWarning),
      };
      sink.push(node, depth + 1, groupRowKey(sink, group.id), group.id, false);
    }
  }
  if (streams.brokers.length > 0 && section(sink, base, "brokers", streams.brokers.length, depth)) {
    for (const broker of streams.brokers) {
      const node: BrokerNode = { ...base, kind: "broker", broker };
      sink.push(node, depth + 1, sink.keyOf("broker", broker.id), broker.id, false);
    }
  }
  if (streams.registry?.available === true && streams.subjects !== null) {
    if (!section(sink, base, "subjects", streams.subjects.length, depth)) return;
    for (const subject of [...streams.subjects].sort((a, b) => byName(a.subject, b.subject))) {
      const node: SubjectNode = { ...base, kind: "subject", subject };
      sink.push(node, depth + 1, sink.keyOf("subject", subject.subject), subject.subject, false);
    }
  }
}

/** States every broker reports, which its row leaves out. */
const ROUTINE_BROKER_STATES: ReadonlySet<string> = new Set(["online", ""]);

/** `kafka-1:9093 · controller`, as a broker row reads. */
export function brokerDetail(broker: Pick<ServerNode, "address" | "state">): string {
  const notes = broker.state
    .split(",")
    .map((part) => part.trim())
    .filter((part) => !ROUTINE_BROKER_STATES.has(part));
  return [broker.address, ...notes].join(" · ");
}

const SCHEMA_TYPE_LABELS = { AVRO: "Avro", PROTOBUF: "Protobuf", JSON: "JSON" } as const;

/** `v2 · Avro`, as a subject row reads. */
export function subjectDetail(subject: SubjectSummary): string {
  const version = subject.latestVersion === null ? null : `v${String(subject.latestVersion)}`;
  const type = subject.type === null ? null : SCHEMA_TYPE_LABELS[subject.type];
  return [version, type].filter((part) => part !== null).join(" · ");
}

/** A group's lag as its row shows it, grouped; empty when nothing is committed. */
export function lagText(lag: string | null): string {
  const value = bigOf(lag);
  return value === null ? "" : value.toLocaleString("en-US");
}

/** The status bar's stream part: `3 brokers · Schema Registry`; null before anything is listed. */
export function streamStatusText(streams: DatasourceStreams | undefined): string | null {
  if (streams?.topics == null) return null;
  const parts: string[] = [];
  const brokers = streams.brokers.length;
  if (brokers > 0) parts.push(`${String(brokers)} ${brokers === 1 ? "broker" : "brokers"}`);
  if (streams.registry?.available === true) {
    const subjects = streams.subjects?.length;
    parts.push(
      subjects === undefined
        ? "Schema Registry"
        : `Schema Registry · ${String(subjects)} ${subjects === 1 ? "subject" : "subjects"}`,
    );
  }
  if (parts.length === 0) {
    const topics = streams.topics.filter((topic) => !topic.internal).length;
    parts.push(`${String(topics)} ${topics === 1 ? "topic" : "topics"}`);
  }
  return parts.join(" · ");
}
