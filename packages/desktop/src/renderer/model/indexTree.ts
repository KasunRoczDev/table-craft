import type { EngineError, SearchTarget } from "@table-craft/desktop/engine/protocol.js";
import type { ErrorNode, ExplorerNode, LoadingNode } from "@table-craft/desktop/renderer/model/explorerTree.js";

/** Indices fold into folders at their first dot, as `audit.http` sits under `audit.`. */
export const INDEX_DELIMITER = ".";
/** A family lists its newest members and folds the rest under one `N older` row. */
export const FAMILY_SHOWN = 2;
/** Longer names shorten in the middle, so both the base and the rollover suffix stay readable. */
export const INDEX_LABEL_MAX = 48;
const ELLIPSIS = "…";

/**
 * A rollover (`-000412`) or date (`-2026.11.21`, `-2026.11`, `-2026-11-21`, `-2026-11`) suffix,
 * optionally followed by a generation (`-2026.11.21-000001`, `-2026-11-0001`). Indices sharing
 * what is left are one family.
 */
const FAMILY_SUFFIX = /^(.+?)-(?:\d{6}|\d{4}\.\d{2}\.\d{2}|\d{4}\.\d{2}|\d{4}-\d{2}-\d{2}|\d{4}-\d{2})(?:-\d+)?$/;
/** Past this many indices, aliases and data streams the tree shows its filter field (plan 166). */
export const INDEX_FILTER_THRESHOLD = 200;
const FILTER_WILDCARD = "*";
const REGEX_SPECIAL = /[.+?^${}()|[\]\\]/g;

/** What the renderer holds of one search datasource (decision 174); it dies with the engine. */
export interface DatasourceIndices {
  /** Every index, alias and data stream, hidden ones included; null until listed. */
  readonly targets: readonly SearchTarget[] | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  /** What the tree's filter field holds; empty shows every target. */
  readonly filter: string;
}

export const EMPTY_INDICES: DatasourceIndices = { targets: null, loading: false, error: null, filter: "" };

export const INDEX_SECTIONS = ["indices", "dataStreams", "aliases", "hidden"] as const;
export type IndexSection = (typeof INDEX_SECTIONS)[number];

/** The sections a datasource opens with; Hidden stays folded until asked. */
export const OPEN_INDEX_SECTIONS: readonly IndexSection[] = ["indices", "dataStreams", "aliases"];

export const INDEX_SECTION_LABELS: Readonly<Record<IndexSection, string>> = {
  indices: "Indices",
  dataStreams: "Data streams",
  aliases: "Aliases",
  hidden: "Hidden",
};

interface IndexNodeBase {
  readonly datasourceId: string;
  /** Always empty: a search datasource has no namespaces, but every catalog row carries a path. */
  readonly path: readonly string[];
}

export interface IndexFilterNode extends IndexNodeBase {
  readonly kind: "indexFilter";
  readonly filter: string;
  /** Targets the filter keeps, and all of them, for its `N of M`. */
  readonly matched: number;
  readonly total: number;
}

export interface IndexSectionNode extends IndexNodeBase {
  readonly kind: "indexSection";
  readonly section: IndexSection;
  readonly count: number;
}

export interface IndexFolderNode extends IndexNodeBase {
  readonly kind: "indexFolder";
  /** The folder's name with the dot after it, as `audit.`. */
  readonly prefix: string;
  readonly count: number;
}

export interface IndexFamilyNode extends IndexNodeBase {
  readonly kind: "indexFamily";
  /** The name the members share once their suffix is gone, as `logs-checkout`. */
  readonly base: string;
  /** Newest first. */
  readonly members: readonly SearchTarget[];
  /** The alias whose write index is one of the members, which is what clients write to. */
  readonly writeAlias: string | null;
}

export interface IndexOlderNode extends IndexNodeBase {
  readonly kind: "indexOlder";
  readonly base: string;
  readonly count: number;
}

export interface SearchTargetNode extends IndexNodeBase {
  readonly kind: "searchTarget";
  readonly target: SearchTarget;
}

export type IndexTreeNode =
  IndexFilterNode | IndexSectionNode | IndexFolderNode | IndexFamilyNode | IndexOlderNode | SearchTargetNode;

export const INDEX_TREE_KINDS: ReadonlySet<string> = new Set([
  "indexFilter",
  "indexSection",
  "indexFolder",
  "indexFamily",
  "indexOlder",
  "searchTarget",
]);

/**
 * Where the index tree's rows go; `explorerTree` owns the row list and the key scheme. `open` shows
 * an expandable row expanded whatever its saved state, as a filter reveals its matches.
 */
export interface IndexRowSink {
  readonly push: (
    node: ExplorerNode,
    depth: number,
    key: string,
    label: string,
    expandable: boolean,
    open?: boolean,
  ) => boolean;
  readonly keyOf: (...parts: readonly unknown[]) => string;
}

export function indexSectionKey(sink: Pick<IndexRowSink, "keyOf">, section: IndexSection): string {
  return sink.keyOf("indexSection", section);
}

export function indexFilterKey(sink: Pick<IndexRowSink, "keyOf">): string {
  return sink.keyOf("indexFilter");
}

/**
 * Whether a target's name matches the tree's filter: a case-blind substring, where `*` stands for
 * any run of characters, as index patterns read; a blank filter matches everything.
 */
export function indexFilterMatcher(filter: string): (name: string) => boolean {
  const trimmed = filter.trim();
  if (trimmed === "") return () => true;
  const pattern = trimmed
    .split(FILTER_WILDCARD)
    .map((part) => part.replace(REGEX_SPECIAL, "\\$&"))
    .join(".*");
  const expression = new RegExp(pattern, "i");
  return (name) => expression.test(name);
}

/** `12 of 8,760`: the targets a filter keeps out of all of them. */
export function indexFilterCount(node: Pick<IndexFilterNode, "matched" | "total">): string {
  return `${node.matched.toLocaleString("en-US")} of ${node.total.toLocaleString("en-US")}`;
}

/** Keeps the targets Manage Shown Indices picked (decision 117); null keeps them all. */
export type ShownTargetFilter = ((target: SearchTarget) => boolean) | null;

/**
 * Whether the tree shows its filter field: on a large listing, or while a filter applies. `listed`
 * is how many targets Manage Shown Indices leaves, every one when it picks none.
 */
export function showsIndexFilter(indices: DatasourceIndices, listed: number = indices.targets?.length ?? 0): boolean {
  return indices.filter.trim() !== "" || listed > INDEX_FILTER_THRESHOLD;
}

export function searchTargetRowKey(sink: Pick<IndexRowSink, "keyOf">, name: string): string {
  return sink.keyOf("searchTarget", name);
}

const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function bigOf(text: string | null): bigint | null {
  if (text === null || !/^\d+$/.test(text)) return null;
  return BigInt(text);
}

/** `2,431`: a decimal count grouped by thousands; null when unknown. */
export function groupedCount(text: string | null): string | null {
  return bigOf(text)?.toLocaleString("en-US") ?? null;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const KIBI = 1024;

/** `1.2 MB`: a store size in binary units with one decimal; null when unknown. */
export function humanBytes(text: string | null): string | null {
  const value = bigOf(text);
  if (value === null) return null;
  let size = Number(value);
  let unit = 0;
  while (size >= KIBI && unit < BYTE_UNITS.length - 1) {
    size /= KIBI;
    unit += 1;
  }
  return unit === 0 ? `${String(size)} B` : `${size.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** `logs-checkout…-000412`: the start and end of a long name, with the middle cut. */
export function middleTruncate(text: string, max: number = INDEX_LABEL_MAX): string {
  if (text.length <= max) return text;
  const keep = max - ELLIPSIS.length;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${ELLIPSIS}${text.slice(text.length - (keep - head))}`;
}

function plural(count: number, singular: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : many}`;
}

function sumOf(values: readonly (string | null)[]): string | null {
  let total = 0n;
  for (const value of values) {
    const number = bigOf(value);
    if (number === null) return null;
    total += number;
  }
  return total.toString();
}

function sizeParts(docs: string | null, bytes: string | null): string[] {
  const count = bigOf(docs);
  const parts: string[] = [];
  if (count !== null) parts.push(`${count.toLocaleString("en-US")} ${count === 1n ? "doc" : "docs"}`);
  const size = humanBytes(bytes);
  if (size !== null) parts.push(size);
  return parts;
}

/** How a row reads beside its name: `2,431 docs · 1.2 MB`, `→ orders-v2`, `3 backing indices`. */
export function searchTargetDetail(target: SearchTarget): string {
  switch (target.kind) {
    case "alias": {
      const [only] = target.indices;
      return target.indices.length === 1 && only !== undefined
        ? `→ ${only}`
        : `→ ${plural(target.indices.length, "index", "indices")}`;
    }
    case "dataStream":
      return plural(target.indices.length, "backing index", "backing indices");
    default:
      return sizeParts(target.docs, target.bytes).join(" · ");
  }
}

/** `3 indices · 7,290 docs · 3.6 MB`, as a family row reads. */
export function familyDetail(members: readonly SearchTarget[]): string {
  const docs = sumOf(members.map((member) => member.docs));
  const bytes = sumOf(members.map((member) => member.bytes));
  return [plural(members.length, "index", "indices"), ...sizeParts(docs, bytes)].join(" · ");
}

/** An index tab's facts, `2,431 docs · 1.2 MB · 1 index`: the listing's sizes, the description's indices. */
export function searchTargetFacts(target: SearchTarget | null, indices: readonly string[]): string {
  const sizes = target === null ? [] : sizeParts(target.docs, target.bytes);
  return [...sizes, plural(indices.length, "index", "indices")].join(" · ");
}

export type HealthTone = "warning" | "danger";

/** A green index says nothing; yellow and red are worth a mark. */
export function healthTone(health: string | null): HealthTone | null {
  if (health === "yellow") return "warning";
  if (health === "red") return "danger";
  return null;
}

/** The family an index belongs to, `logs-checkout` for `logs-checkout-000412`; null when it has no suffix. */
export function familyBaseOf(name: string): string | null {
  return FAMILY_SUFFIX.exec(name)?.[1] ?? null;
}

export function indexFolderOf(name: string): string | null {
  const at = name.indexOf(INDEX_DELIMITER);
  return at <= 0 || at === name.length - 1 ? null : name.slice(0, at + INDEX_DELIMITER.length);
}

/** Appends in place: a family of thousands rebuilt on every keystroke of the filter must not copy itself per member. */
function appendTo(groups: Map<string, SearchTarget[]>, key: string, target: SearchTarget): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [target]);
  else group.push(target);
}

export interface IndexFamily {
  readonly base: string;
  readonly members: readonly SearchTarget[];
  readonly writeAlias: string | null;
}

export interface IndexGroups {
  readonly families: readonly IndexFamily[];
  readonly folders: readonly { readonly prefix: string; readonly indices: readonly SearchTarget[] }[];
  readonly loose: readonly SearchTarget[];
}

/**
 * The indices as families (two or more sharing a base once a rollover or date suffix is gone),
 * then one level of folders split at the first dot of the rest. A prefix folds only when at least
 * two indices share it and not every one does, as topics do.
 */
export function indexGroups(indices: readonly SearchTarget[], aliases: readonly SearchTarget[] = []): IndexGroups {
  const byBase = new Map<string, SearchTarget[]>();
  const rest: SearchTarget[] = [];
  for (const index of indices) {
    const base = familyBaseOf(index.name);
    if (base === null) rest.push(index);
    else appendTo(byBase, base, index);
  }
  const families: IndexFamily[] = [];
  for (const [base, members] of byBase) {
    if (members.length < 2) {
      rest.push(...members);
      continue;
    }
    const names = new Set(members.map((member) => member.name));
    const writer = aliases.find((alias) => alias.writeIndex !== null && names.has(alias.writeIndex));
    families.push({
      base,
      members: [...members].sort((a, b) => byName(b.name, a.name)),
      writeAlias: writer?.name ?? null,
    });
  }
  const byPrefix = new Map<string, SearchTarget[]>();
  const loose: SearchTarget[] = [];
  for (const index of rest) {
    const folder = indexFolderOf(index.name);
    if (folder === null) loose.push(index);
    else appendTo(byPrefix, folder, index);
  }
  const folders: { prefix: string; indices: SearchTarget[] }[] = [];
  for (const [prefix, members] of byPrefix) {
    if (members.length >= 2 && members.length < rest.length) folders.push({ prefix, indices: members });
    else loose.push(...members);
  }
  const sorted = (list: readonly SearchTarget[]) => [...list].sort((a, b) => byName(a.name, b.name));
  return {
    families: families.sort((a, b) => byName(a.base, b.base)),
    folders: folders
      .sort((a, b) => byName(a.prefix, b.prefix))
      .map((folder) => ({ prefix: folder.prefix, indices: sorted(folder.indices) })),
    loose: sorted(loose),
  };
}

function targetRow(sink: IndexRowSink, base: IndexNodeBase, target: SearchTarget, depth: number) {
  const node: SearchTargetNode = { ...base, kind: "searchTarget", target };
  sink.push(node, depth, searchTargetRowKey(sink, target.name), target.name, false);
}

function section(
  sink: IndexRowSink,
  base: IndexNodeBase,
  name: IndexSection,
  count: number,
  depth: number,
  open: boolean,
) {
  const node: IndexSectionNode = { ...base, kind: "indexSection", section: name, count };
  return sink.push(node, depth, indexSectionKey(sink, name), INDEX_SECTION_LABELS[name], true, open);
}

function familyRows(sink: IndexRowSink, base: IndexNodeBase, family: IndexFamily, depth: number, open: boolean) {
  const node: IndexFamilyNode = { ...base, kind: "indexFamily", ...family };
  if (!sink.push(node, depth, sink.keyOf("indexFamily", family.base), family.base, true, open)) return;
  const newest = family.members.slice(0, FAMILY_SHOWN);
  const older = family.members.slice(FAMILY_SHOWN);
  for (const member of newest) targetRow(sink, base, member, depth + 1);
  if (older.length === 0) return;
  const olderNode: IndexOlderNode = { ...base, kind: "indexOlder", base: family.base, count: older.length };
  const label = `${String(older.length)} older`;
  if (!sink.push(olderNode, depth + 1, sink.keyOf("indexOlder", family.base), label, true, open)) return;
  for (const member of older) targetRow(sink, base, member, depth + 2);
}

const sortedByName = (targets: readonly SearchTarget[]) => [...targets].sort((a, b) => byName(a.name, b.name));

/**
 * A search datasource's rows under its node (decision 174): Indices in families and folders, Data
 * streams, Aliases, and the hidden system indices in a section of their own, never mixed in. A
 * large listing leads with a filter field (plan 166); while it holds text, only the matching
 * targets stay, in the families and folders they belong to, every row on the way to them opened.
 * `shown` trims the listing first, so the filter, its count and its threshold see only what is left.
 */
export function indexRows(
  sink: IndexRowSink,
  datasourceId: string,
  indices: DatasourceIndices,
  depth: number,
  shown: ShownTargetFilter = null,
): void {
  if (indices.targets === null) {
    if (indices.error !== null) {
      const error: ErrorNode = { kind: "error", datasourceId, error: indices.error };
      sink.push(error, depth, sink.keyOf("indexError"), indices.error.message, false);
    } else {
      const loading: LoadingNode = { kind: "loading", datasourceId };
      sink.push(loading, depth, sink.keyOf("indexLoading"), "", false);
    }
    return;
  }
  const base: IndexNodeBase = { datasourceId, path: [] };
  const matches = indexFilterMatcher(indices.filter);
  const listed = shown === null ? indices.targets : indices.targets.filter(shown);
  const kept = listed.filter((target) => matches(target.name));
  const open = indices.filter.trim() !== "";
  if (showsIndexFilter(indices, listed.length)) {
    const filter: IndexFilterNode = {
      ...base,
      kind: "indexFilter",
      filter: indices.filter,
      matched: kept.length,
      total: listed.length,
    };
    sink.push(filter, depth, indexFilterKey(sink), "", false);
  }
  const visible = kept.filter((target) => !target.hidden);
  const of = (kind: SearchTarget["kind"]) => visible.filter((target) => target.kind === kind);
  const aliases = of("alias");
  const plain = of("index");
  if (section(sink, base, "indices", plain.length, depth, open)) {
    const { families, folders, loose } = indexGroups(plain, aliases);
    for (const folder of folders) {
      const node: IndexFolderNode = {
        ...base,
        kind: "indexFolder",
        prefix: folder.prefix,
        count: folder.indices.length,
      };
      if (!sink.push(node, depth + 1, sink.keyOf("indexFolder", folder.prefix), folder.prefix, true, open)) continue;
      for (const index of folder.indices) targetRow(sink, base, index, depth + 2);
    }
    const entries = [
      ...families.map((family) => ({ name: family.base, family, index: null })),
      ...loose.map((index) => ({ name: index.name, family: null, index })),
    ].sort((a, b) => byName(a.name, b.name));
    for (const entry of entries) {
      if (entry.family !== null) familyRows(sink, base, entry.family, depth + 1, open);
      else if (entry.index !== null) targetRow(sink, base, entry.index, depth + 1);
    }
  }
  const streams = of("dataStream");
  if (streams.length > 0 && section(sink, base, "dataStreams", streams.length, depth, open)) {
    for (const stream of sortedByName(streams)) targetRow(sink, base, stream, depth + 1);
  }
  if (aliases.length > 0 && section(sink, base, "aliases", aliases.length, depth, open)) {
    for (const alias of sortedByName(aliases)) targetRow(sink, base, alias, depth + 1);
  }
  const hidden = kept.filter((target) => target.hidden);
  if (hidden.length > 0 && section(sink, base, "hidden", hidden.length, depth, open)) {
    for (const target of sortedByName(hidden)) targetRow(sink, base, target, depth + 1);
  }
}

/** The status bar's index part: `12 indices`; null before anything is listed. */
export function indexStatusText(
  indices: DatasourceIndices | undefined,
  shown: ShownTargetFilter = null,
): string | null {
  if (indices?.targets == null) return null;
  const count = indices.targets.filter(
    (target) => target.kind === "index" && !target.hidden && (shown === null || shown(target)),
  ).length;
  return plural(count, "index", "indices");
}
