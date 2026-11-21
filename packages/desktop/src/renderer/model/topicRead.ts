import {
  TOPIC_READ_LIMIT,
  type FilterChip,
  type MessageFormat,
  type Row,
  type TopicReadRequest,
  type TopicStart,
  type WireValue,
} from "@table-craft/desktop/engine/protocol.js";

/** Plan 164 decision 6: a topic opens on its newest 500 messages, and a read keeps 500 rows. */
export const DEFAULT_READ_LIMIT = 500;
export const DEFAULT_LATEST_N = 500;

export const FROM_KINDS = ["latestN", "earliest", "offset", "timestamp", "group"] as const;
export type FromKind = (typeof FROM_KINDS)[number];

export const FROM_LABELS: Readonly<Record<FromKind, string>> = {
  latestN: "Latest N",
  earliest: "Earliest",
  offset: "Offset",
  timestamp: "Timestamp",
  group: "Group's Committed Offset",
};

export const MESSAGE_FORMAT_LABELS: Readonly<Record<MessageFormat, string>> = {
  auto: "Auto",
  string: "String",
  json: "JSON",
  avro: "Avro",
  protobuf: "Protobuf",
  jsonSchema: "JSON Schema",
  hex: "Hex",
  base64: "Base64",
  int32: "Int32",
  int64: "Int64",
  double: "Double",
};

/** The read bar's fields as typed (decision 6); a read turns them into a `TopicReadRequest`. */
export interface ReadDraft {
  /** Null reads every partition. */
  readonly partitions: readonly number[] | null;
  readonly from: FromKind;
  readonly latestN: string;
  readonly offset: string;
  /** `2026-11-21 09:15:00`, in local time, or any ISO 8601 instant. */
  readonly timestamp: string;
  readonly group: string;
  readonly limit: string;
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
  /** Text matched in key, value or headers, or `/regex/`; blank matches every message. */
  readonly filter: string;
}

export const DEFAULT_DRAFT: ReadDraft = {
  partitions: null,
  from: "latestN",
  latestN: String(DEFAULT_LATEST_N),
  offset: "",
  timestamp: "",
  group: "",
  limit: String(DEFAULT_READ_LIMIT),
  keyFormat: "auto",
  valueFormat: "auto",
  filter: "",
};

const WHOLE = /^\d+$/;

function countIn(text: string, what: string): number | string {
  const trimmed = text.replace(/[,_\s]/g, "");
  const value = WHOLE.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > TOPIC_READ_LIMIT)
    return `${what} is a whole number from 1 to ${TOPIC_READ_LIMIT.toLocaleString("en-US")}.`;
  return value;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MIDNIGHT = "T00:00";

/** `2026-11-21 09:15` as typed, read in local time unless it names its zone; null when unreadable. */
export function instantOf(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  // `Date.parse` reads a bare date as UTC midnight but a date with a time as local time.
  const time = Date.parse(DATE_ONLY.test(trimmed) ? `${trimmed}${LOCAL_MIDNIGHT}` : trimmed.replace(" ", "T"));
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function startOf(draft: ReadDraft): TopicStart | string {
  switch (draft.from) {
    case "latestN": {
      const count = countIn(draft.latestN, "Latest N");
      return typeof count === "string" ? count : { kind: "latestN", count };
    }
    case "earliest":
      return { kind: "earliest" };
    case "offset": {
      const offset = draft.offset.trim();
      return WHOLE.test(offset) ? { kind: "offset", offset } : "Offset is a whole number, such as 1204331.";
    }
    case "timestamp": {
      const timestamp = instantOf(draft.timestamp);
      return timestamp === null
        ? "Timestamp reads like 2026-11-21 09:15:00 (local time) or an ISO 8601 instant."
        : { kind: "timestamp", timestamp };
    }
    case "group": {
      const group = draft.group.trim();
      return group === "" ? "Name the consumer group whose committed offsets to read from." : { kind: "group", group };
    }
  }
}

/** The read the draft asks for, or what to fix first. */
export function readRequestOf(
  topic: string,
  draft: ReadDraft,
  resume: string | null = null,
): { readonly request: TopicReadRequest } | { readonly problem: string } {
  const from = startOf(draft);
  if (typeof from === "string") return { problem: from };
  const limit = countIn(draft.limit, "Limit");
  if (typeof limit === "string") return { problem: limit };
  const filter = draft.filter.trim();
  return {
    request: {
      topic,
      partitions: draft.partitions === null || draft.partitions.length === 0 ? null : [...draft.partitions],
      from,
      limit,
      keyFormat: draft.keyFormat,
      valueFormat: draft.valueFormat,
      filter: filter === "" ? null : filter,
      maxScan: null,
      resume,
    },
  };
}

function fromFlag(from: TopicStart): string {
  switch (from.kind) {
    case "earliest":
    case "latest":
      return from.kind;
    case "latestN":
      return `-${String(from.count)}`;
    case "offset":
      return `offset:${from.offset}`;
    case "timestamp":
      return `time:${from.timestamp}`;
    case "group":
      return `group:${from.group}`;
  }
}

function quoted(text: string): string {
  return /^[\w.:/-]+$/.test(text) ? text : JSON.stringify(text);
}

/**
 * The read as the console would type it (decision 9), `consume orders.v1 --from -500 --limit 500`:
 * what Services and the tab's footer name it by.
 */
export function readCommandText(request: TopicReadRequest): string {
  const parts = ["consume", quoted(request.topic)];
  if (request.partitions !== null) parts.push("-p", request.partitions.join(","));
  parts.push("--from", quoted(fromFlag(request.from)), "--limit", String(request.limit));
  if (request.keyFormat !== "auto") parts.push("--key-format", request.keyFormat);
  if (request.valueFormat !== "auto") parts.push("--value-format", request.valueFormat);
  if (request.filter !== null) parts.push("--grep", quoted(request.filter));
  return parts.join(" ");
}

/** Whether the footer offers Search Earlier: a filtered read that looked only at the newest messages (audit M4). */
export function searchesOnlyNewest(request: TopicReadRequest | null): number | null {
  if (request === null || request.filter === null || request.from.kind !== "latestN") return null;
  return request.from.count;
}

/** `null` reads every partition; one chosen alone toggles back to every one. */
export function toggledPartition(current: readonly number[] | null, partition: number): readonly number[] | null {
  return current !== null && current.length === 1 && current[0] === partition ? null : [partition];
}

/** `All`, `p7` or `p0, p3`, as the read bar's Partitions trigger reads. */
export function partitionsLabel(partitions: readonly number[] | null): string {
  return partitions === null || partitions.length === 0 ? "All" : partitions.map((p) => `p${String(p)}`).join(", ");
}

/** `0,3, 7` as typed into the Partitions field; null for all, a string for what is wrong. */
export function parsePartitions(text: string, count: number | null): readonly number[] | null | string {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "all") return null;
  const parts = trimmed.split(/[\s,]+/).map((part) => part.replace(/^p/i, ""));
  if (!parts.every((part) => WHOLE.test(part))) return "List partitions as numbers, such as 0, 3, 7.";
  const numbers = [...new Set(parts.map(Number))].sort((a, b) => a - b);
  const outside = count === null ? undefined : numbers.find((partition) => partition >= count);
  if (outside !== undefined) return `Partition ${String(outside)} does not exist; the topic has ${String(count)}.`;
  return numbers;
}

function numberOf(value: WireValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && WHOLE.test(value)) return Number(value);
  if (typeof value === "object" && value !== null && value.kind === "bigint") return Number(value.value);
  return null;
}

export interface PartitionCounts {
  /** Rows loaded per partition, by partition number. */
  readonly counts: readonly number[];
  /** Every row of the read is loaded, so the counts are the read's own. */
  readonly complete: boolean;
}

/** How many of the loaded rows each partition holds, for the strip above the messages. */
export function partitionCounts(
  columns: readonly { readonly name: string }[],
  windows: Readonly<Record<number, readonly Row[]>>,
  rowCount: number,
  partitions: number,
): PartitionCounts {
  const at = columns.findIndex((column) => column.name === "partition");
  const counts = Array.from({ length: partitions }, () => 0);
  let loaded = 0;
  for (const rows of Object.values(windows)) {
    loaded += rows.length;
    if (at < 0) continue;
    for (const row of rows) {
      const partition = numberOf(row[at]);
      if (partition !== null && partition >= 0 && partition < partitions)
        counts[partition] = (counts[partition] ?? 0) + 1;
    }
  }
  return { counts, complete: loaded >= rowCount };
}

/** The footer's read summary: `Scanned 90,411 · 191 matched`, or `· 500 rows` without a filter. */
export function scannedText(
  read: { readonly scanned: string; readonly matched: string },
  filtered: boolean,
  rows: number,
  /** The read's Latest N: a filter then searched only the newest N of each partition (audit M4). */
  latest: number | null = null,
): string {
  const scanned = BigInt(/^\d+$/.test(read.scanned) ? read.scanned : "0").toLocaleString("en-US");
  if (filtered) {
    const matched = BigInt(/^\d+$/.test(read.matched) ? read.matched : "0").toLocaleString("en-US");
    if (latest !== null)
      return `Scanned ${scanned} · ${matched} matched in the newest ${latest.toLocaleString("en-US")} of each partition`;
    return `Scanned ${scanned} · ${matched} matched`;
  }
  return `Scanned ${scanned} · ${rows.toLocaleString("en-US")} ${rows === 1 ? "row" : "rows"}`;
}

const DURATION_UNITS: readonly (readonly [string, number])[] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["min", 60_000],
  ["s", 1_000],
];
const RETENTION_CONFIG = "retention.ms";
const UNLIMITED = "-1";

/** `3 d`, `12 h`, `90 s`: a config's milliseconds in the largest unit that divides them; null when not a duration. */
export function durationText(milliseconds: string | null): string | null {
  if (milliseconds === UNLIMITED) return "unlimited";
  if (milliseconds === null || !WHOLE.test(milliseconds)) return null;
  const value = Number(milliseconds);
  const unit = DURATION_UNITS.find(([, size]) => value >= size && value % size === 0);
  return unit === undefined ? `${milliseconds} ms` : `${String(value / unit[1])} ${unit[0]}`;
}

export interface TopicFacts {
  readonly partitions: number;
  readonly replication: number | null;
  readonly messages: string | null;
  readonly retention: string | null;
  /** Partitions whose in-sync replicas are fewer than their replicas. */
  readonly underReplicated: readonly number[];
}

/** What the topic tab's header says of the topic. */
export function topicFacts(description: {
  readonly partitions: readonly {
    readonly partition: number;
    readonly replicas: readonly number[];
    readonly isr: readonly number[];
  }[];
  readonly configs: readonly { readonly name: string; readonly value: string | null }[];
  readonly messages: string | null;
}): TopicFacts {
  const replication = description.partitions.reduce<number | null>(
    (most, partition) => Math.max(most ?? 0, partition.replicas.length),
    null,
  );
  return {
    partitions: description.partitions.length,
    replication,
    messages: description.messages,
    retention: durationText(description.configs.find((config) => config.name === RETENTION_CONFIG)?.value ?? null),
    underReplicated: description.partitions
      .filter((partition) => partition.isr.length < partition.replicas.length)
      .map((partition) => partition.partition),
  };
}

const PARTITION_COLUMN = "partition";

/** The partition the loaded rows are filtered to, by a strip click's chip; null when none is. */
export function filteredPartition(
  columns: readonly { readonly name: string }[],
  filters: readonly FilterChip[],
): number | null {
  const at = columns.findIndex((column) => column.name === PARTITION_COLUMN);
  const chip = filters.find((filter) => filter.column === at && filter.op === "equals");
  return chip === undefined || !("text" in chip) || !WHOLE.test(chip.text) ? null : Number(chip.text);
}

/**
 * The filters after a strip click on `partition` (audit m3): the loaded rows narrow to it, and a
 * click on the partition already shown clears that again. Other chips stay.
 */
export function toggledPartitionFilter(
  columns: readonly { readonly name: string }[],
  filters: readonly FilterChip[],
  partition: number,
): readonly FilterChip[] {
  const at = columns.findIndex((column) => column.name === PARTITION_COLUMN);
  if (at < 0) return filters;
  const current = filteredPartition(columns, filters);
  const others = filters.filter((filter) => !(filter.column === at && filter.op === "equals"));
  return current === partition ? others : [...others, { column: at, op: "equals", text: String(partition) }];
}

/** Above this many partitions the strip folds to one line until expanded (audit m3). */
export const STRIP_FOLD_PARTITIONS = 24;

/** `Rows in 37 of 120 partitions`, the folded strip's line. */
export function stripSummary(counts: readonly number[]): string {
  const holding = counts.filter((count) => count > 0).length;
  return `Rows in ${holding.toLocaleString("en-US")} of ${counts.length.toLocaleString("en-US")} partitions`;
}
