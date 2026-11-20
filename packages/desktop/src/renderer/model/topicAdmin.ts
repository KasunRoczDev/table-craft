import {
  TOPIC_NAME_MAX_LENGTH,
  type ConfigChange,
  type ConfigEntry,
  type RecordsBefore,
  type TopicConfigValue,
  type TopicCreate,
} from "@table-craft/desktop/engine/protocol.js";
import { instantOf } from "@table-craft/desktop/renderer/model/topicRead.js";

/** Kafka's own rule for a topic name: ASCII letters, digits, `.`, `_` and `-`. */
const TOPIC_NAME = /^[A-Za-z0-9._-]+$/;
const WHOLE = /^\d+$/;
const RESERVED_NAMES: ReadonlySet<string> = new Set([".", ".."]);

/** Why `name` cannot be a topic's, or null. */
export function topicNameProblem(name: string): string | null {
  if (name === "") return "Name the topic.";
  if (name.length > TOPIC_NAME_MAX_LENGTH)
    return `A topic name is at most ${String(TOPIC_NAME_MAX_LENGTH)} characters.`;
  if (RESERVED_NAMES.has(name)) return `"${name}" is reserved.`;
  if (!TOPIC_NAME.test(name)) return "A topic name holds only letters, digits, '.', '_' and '-'.";
  return null;
}

/** The topic configs Create Topic offers by name (audit m8); any other is typed under Other…. */
export const COMMON_TOPIC_CONFIGS = [
  "cleanup.policy",
  "retention.ms",
  "retention.bytes",
  "segment.ms",
  "segment.bytes",
  "min.insync.replicas",
  "max.message.bytes",
  "compression.type",
  "message.timestamp.type",
  "delete.retention.ms",
  "min.compaction.lag.ms",
] as const;

/** One config row of Create Topic: a name, from the list or typed, and its value. */
export interface ConfigRow {
  readonly name: string;
  readonly value: string;
}

/** The rows that name a config, as the request carries them; a named row without a value is refused. */
export function configRowsOf(rows: readonly ConfigRow[]): readonly TopicConfigValue[] | string {
  const configs: TopicConfigValue[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "") continue;
    if (row.value.trim() === "") return `Give ${name} a value, or remove its row.`;
    if (configs.some((config) => config.name === name)) return `${name} is set twice.`;
    configs.push({ name, value: row.value.trim() });
  }
  return configs;
}

/**
 * Kafka's metrics replace `.` with `_`, so `orders.v1` and `orders_v1` collide (audit m8): the
 * existing topic `name` would collide with, or null.
 */
export function collidingTopic(name: string, existing: readonly string[]): string | null {
  const folded = name.replaceAll(".", "_");
  return existing.find((topic) => topic !== name && topic.replaceAll(".", "_") === folded) ?? null;
}

/** The Create Topic dialog's fields as a request, or what to fix first. */
export function topicCreateOf(fields: {
  readonly name: string;
  readonly partitions: string;
  readonly replication: string;
  readonly configs: readonly ConfigRow[];
}): TopicCreate | string {
  const name = fields.name.trim();
  const problem = topicNameProblem(name);
  if (problem !== null) return problem;
  const partitions = fields.partitions.trim();
  if (!WHOLE.test(partitions) || Number(partitions) < 1) return "Partitions is a whole number of at least 1.";
  const replication = fields.replication.trim();
  if (replication !== "" && (!WHOLE.test(replication) || Number(replication) < 1))
    return "Replication is a whole number of at least 1, or blank for the broker's default.";
  const configs = configRowsOf(fields.configs);
  if (typeof configs === "string") return configs;
  return {
    name,
    partitions: Number(partitions),
    replicationFactor: replication === "" ? null : Number(replication),
    configs,
  };
}

/** What the config editor holds per entry: the text typed, or a pending reset to the default. */
export type ConfigEdit = { readonly kind: "set"; readonly value: string } | { readonly kind: "reset" };

/** The edits that change something, as incremental alters; a reset sends null (decision 12). */
export function configChangesOf(
  configs: readonly ConfigEntry[],
  edits: Readonly<Record<string, ConfigEdit>>,
): readonly ConfigChange[] {
  return configs.flatMap((entry): ConfigChange[] => {
    const edit = edits[entry.name];
    if (edit === undefined || entry.readOnly) return [];
    if (edit.kind === "reset") return entry.isDefault ? [] : [{ name: entry.name, value: null }];
    return edit.value === (entry.value ?? "") ? [] : [{ name: entry.name, value: edit.value }];
  });
}

/** The new total Add Partitions asks for, or what to fix first. */
export function partitionTotalOf(text: string, current: number): number | string {
  const total = text.trim();
  if (!WHOLE.test(total)) return "The new total is a whole number.";
  if (Number(total) <= current)
    return `The new total must be above ${String(current)}; Kafka cannot remove partitions.`;
  return Number(total);
}

export const RECORDS_BEFORE_KINDS = ["offset", "timestamp", "latest"] as const;
export type RecordsBeforeKind = (typeof RECORDS_BEFORE_KINDS)[number];

export const RECORDS_BEFORE_LABELS: Readonly<Record<RecordsBeforeKind, string>> = {
  offset: "Offset",
  timestamp: "Timestamp",
  latest: "All Records",
};

/** Delete Records' boundary, or what to fix first. */
export function recordsBeforeOf(kind: RecordsBeforeKind, text: string): RecordsBefore | string {
  if (kind === "latest") return { kind: "latest" };
  if (kind === "offset")
    return WHOLE.test(text.trim()) ? { kind: "offset", offset: text.trim() } : "Offset is a whole number.";
  const timestamp = instantOf(text);
  return timestamp === null
    ? "Timestamp reads like 2026-11-21 09:00:00 (local time) or an ISO 8601 instant."
    : { kind: "timestamp", timestamp };
}

/** Whether `typed` names `name`, as a typed-name confirmation asks: exactly, ignoring outer spaces. */
export function typedMatches(typed: string, name: string): boolean {
  return typed.trim() === name;
}

/** Delete Records asks for the topic's name once its preview would delete anything (audit B2). */
export function deleteRecordsNeedsName(removed: string | null): boolean {
  return removed !== null && /^\d+$/.test(removed) && BigInt(removed) > 0n;
}
