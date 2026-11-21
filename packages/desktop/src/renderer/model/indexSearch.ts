import {
  SEARCH_PAGE_LIMIT,
  type SearchField,
  type SearchQueryLanguage,
  type SearchRequest,
  type SearchTargetDescription,
  type SearchTotal,
} from "@table-craft/desktop/engine/protocol.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The time ranges a time-based target offers, newest window first; `all` sets no range. */
export const SEARCH_RANGES = [
  { key: "15m", label: "Last 15 minutes", ms: 15 * MINUTE_MS },
  { key: "1h", label: "Last hour", ms: HOUR_MS },
  { key: "24h", label: "Last 24 hours", ms: DAY_MS },
  { key: "7d", label: "Last 7 days", ms: 7 * DAY_MS },
  { key: "30d", label: "Last 30 days", ms: 30 * DAY_MS },
  { key: "all", label: "All time", ms: null },
] as const;
export type SearchRangeKey = (typeof SEARCH_RANGES)[number]["key"];
/** A time-based target opens on its last quarter hour, as Discover does. */
export const DEFAULT_RANGE: SearchRangeKey = "15m";
/** The histogram strip's bars per search. */
export const HISTOGRAM_BUCKETS = 60;

export type SortOrder = "asc" | "desc";

/** What the query bar holds; Run turns it into a `SearchRequest`. */
export interface SearchDraft {
  readonly language: SearchQueryLanguage;
  readonly query: string;
  /** Null orders by score, then by `_id` while paging. */
  readonly sortField: string | null;
  readonly sortOrder: SortOrder;
  readonly range: SearchRangeKey;
}

export const EMPTY_SEARCH_DRAFT: SearchDraft = {
  language: "lucene",
  query: "",
  sortField: null,
  sortOrder: "desc",
  range: "all",
};

/** The draft a target opens with: newest first over the last quarter hour when it has a time field. */
export function defaultDraft(description: Pick<SearchTargetDescription, "timeField"> | null): SearchDraft {
  const timeField = description?.timeField ?? null;
  return timeField === null
    ? EMPTY_SEARCH_DRAFT
    : { ...EMPTY_SEARCH_DRAFT, sortField: timeField, sortOrder: "desc", range: DEFAULT_RANGE };
}

export function rangeLabel(key: SearchRangeKey): string {
  return SEARCH_RANGES.find((range) => range.key === key)?.label ?? key;
}

/**
 * The request `draft` asks of `target`; the range counts back from `now` and applies only on a
 * target with a time field. `pageSize` is the grid's page, capped at what one search returns.
 */
export function searchRequestOf(
  target: string,
  draft: SearchDraft,
  timeField: string | null,
  pageSize: number,
  now: number,
): SearchRequest {
  const range = SEARCH_RANGES.find((candidate) => candidate.key === draft.range);
  const from = timeField === null || range?.ms == null ? null : new Date(now - range.ms).toISOString();
  return {
    target,
    language: draft.language,
    query: draft.query.trim(),
    sort: draft.sortField === null ? [] : [{ field: draft.sortField, order: draft.sortOrder }],
    time: from === null || timeField === null ? null : { field: timeField, from, to: null },
    fields: null,
    pageSize: Math.min(Math.max(1, Math.trunc(pageSize)), SEARCH_PAGE_LIMIT),
  };
}

/** The fields a search can sort by: those with doc values. */
export function sortableFields(fields: readonly SearchField[]): readonly SearchField[] {
  return fields.filter((field) => field.aggregatable);
}

const ANALYZED_TYPES: ReadonlySet<string> = new Set(["text", "match_only_text", "search_as_you_type"]);

/** The fields Analyze can run against: those an analyzer splits. */
export function analyzedFields(fields: readonly SearchField[]): readonly SearchField[] {
  return fields.filter((field) => ANALYZED_TYPES.has(field.type));
}

/** `1–100 of 2,431 hits`, `≥ 10,000` when the total is a lower bound. */
export function hitsText(shown: number, total: SearchTotal | null): string {
  const range = shown === 0 ? "0" : `1–${shown.toLocaleString("en-US")}`;
  if (total === null || (total.value === "0" && total.relation === "eq")) return `${range} hits`;
  const value = /^\d+$/.test(total.value) ? BigInt(total.value).toLocaleString("en-US") : total.value;
  const count = total.relation === "gte" ? `≥ ${value}` : value;
  return `${range} of ${count} ${total.value === "1" && total.relation === "eq" ? "hit" : "hits"}`;
}

/** Each step's tokens beside the tokens the step before it had and this one no longer has. */
export interface AnalyzedChainStep {
  readonly kept: readonly string[];
  readonly dropped: readonly string[];
}

interface ChainStep {
  readonly kind?: string;
  readonly tokens: readonly { readonly token: string; readonly position: number }[];
}

/**
 * What every analysis step kept and what it dropped of the step before. A token is matched by its
 * position, not its text: `lowercase` turning `Crème` into `crème` changes a token, it drops none.
 * A char filter's output is text, not tokens, so the step after it drops nothing.
 */
export function droppedTokens(steps: readonly ChainStep[]) {
  return steps.map((step, index): AnalyzedChainStep => {
    const kept = step.tokens.map((token) => token.token);
    const previous = index === 0 ? undefined : steps[index - 1];
    if (previous === undefined || previous.kind === "charFilter") return { kept, dropped: [] };
    const remaining = new Set(step.tokens.map((token) => token.position));
    return {
      kept,
      dropped: previous.tokens.filter((token) => !remaining.has(token.position)).map((token) => token.token),
    };
  });
}
