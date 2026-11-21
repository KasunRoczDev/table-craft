import type { ExecutedStatement } from "./sessions.js";
import type { ResultPaging, StatementLimit } from "./wire.js";

/** Mirrors `SEARCH_TARGET_KINDS` in plugin-api (plan 165). */
export const SEARCH_TARGET_KINDS = ["index", "alias", "dataStream"] as const;
export type SearchTargetKind = (typeof SEARCH_TARGET_KINDS)[number];

/** Mirrors `SEARCH_QUERY_LANGUAGES` in plugin-api. */
export const SEARCH_QUERY_LANGUAGES = ["lucene", "dsl"] as const;
export type SearchQueryLanguage = (typeof SEARCH_QUERY_LANGUAGES)[number];

/** Mirrors `SEARCH_PAGE_LIMIT` in plugin-api: the largest page one search request asks for. */
export const SEARCH_PAGE_LIMIT = 10_000;
/** Mirrors `SEARCH_ID_COLUMN`, `SEARCH_INDEX_COLUMN` and `SEARCH_SOURCE_COLUMN` in plugin-api. */
export const SEARCH_ID_COLUMN = "_id";
export const SEARCH_INDEX_COLUMN = "_index";
export const SEARCH_SOURCE_COLUMN = "_source";
/** An index, alias, data stream or field name longer than this is refused before it reaches the plugin. */
export const SEARCH_NAME_MAX_LENGTH = 4_096;
/** A query bar's text, Lucene or DSL. */
export const SEARCH_QUERY_MAX_LENGTH = 1_048_576;
/** The most fields one search shows as columns, and the most sort keys. */
export const SEARCH_FIELDS_MAX = 1_000;
export const SEARCH_SORT_MAX = 16;
/** The most bars one histogram asks for. */
export const SEARCH_HISTOGRAM_MAX_BUCKETS = 500;

/** Mirrors `SearchTarget` in plugin-api. Counts and sizes are decimal strings; null is unknown. */
export interface SearchTarget {
  readonly name: string;
  readonly kind: SearchTargetKind;
  readonly hidden: boolean;
  readonly health: string | null;
  readonly status: string | null;
  readonly docs: string | null;
  readonly bytes: string | null;
  readonly indices: readonly string[];
  readonly writeIndex: string | null;
}

/** Mirrors `SearchField` in plugin-api. */
export interface SearchField {
  readonly path: string;
  readonly type: string;
  readonly multiOf: string | null;
  readonly analyzer: string | null;
  readonly aggregatable: boolean;
}

/** Mirrors `SearchTargetDescription` in plugin-api. */
export interface SearchTargetDescription {
  readonly name: string;
  readonly kind: SearchTargetKind;
  readonly indices: readonly string[];
  readonly mappingType: string | null;
  readonly fields: readonly SearchField[];
  readonly timeField: string | null;
  readonly mapping: string | null;
  readonly settings: string | null;
  readonly warnings: readonly string[];
}

/** Mirrors `SearchSort` in plugin-api. */
export interface SearchSort {
  readonly field: string;
  readonly order: "asc" | "desc";
}

/** Mirrors `SearchTimeRange` in plugin-api; `from` and `to` are ISO 8601, null for open. */
export interface SearchTimeRange {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
}

/** Mirrors `SearchRequest` in plugin-api. */
export interface SearchRequest {
  readonly target: string;
  readonly language: SearchQueryLanguage;
  readonly query: string;
  readonly sort: readonly SearchSort[];
  readonly time: SearchTimeRange | null;
  readonly fields: readonly string[] | null;
  readonly pageSize: number;
}

/** Mirrors `SearchTotal` in plugin-api. */
export interface SearchTotal {
  readonly value: string;
  readonly relation: "eq" | "gte";
}

/** Mirrors `SearchShards` in plugin-api. */
export interface SearchShards {
  readonly total: number;
  readonly successful: number;
  readonly skipped: number;
  readonly failed: number;
}

/** What a search said besides its rows, which go to the result store. */
export interface SearchInfo {
  readonly total: SearchTotal | null;
  readonly tookMs: number;
  readonly shards: SearchShards;
  readonly request: string;
  readonly warnings: readonly string[];
}

/** Answers `indices.open`. */
export interface OpenedSearch {
  readonly search: SearchInfo;
  readonly statement: ExecutedStatement;
}

/** Mirrors `HistogramBucket` in plugin-api. */
export interface HistogramBucket {
  readonly at: string;
  readonly count: number;
}

/** Mirrors `SearchHistogram` in plugin-api. */
export interface SearchHistogram {
  readonly field: string;
  readonly interval: string;
  readonly buckets: readonly HistogramBucket[];
}

/** Mirrors `AnalyzedToken` in plugin-api. */
export interface AnalyzedToken {
  readonly token: string;
  readonly position: number;
}

/** Mirrors `AnalyzeStep` in plugin-api. */
export interface AnalyzeStep {
  readonly name: string;
  readonly kind: "charFilter" | "tokenizer" | "tokenFilter" | "analyzer";
  readonly tokens: readonly AnalyzedToken[];
}

/** Mirrors `AnalyzeRequest` in plugin-api. */
export interface AnalyzeRequest {
  readonly target: string;
  readonly field: string | null;
  readonly analyzer: string | null;
  readonly text: string;
}

/**
 * The calls of a datasource that declares `searchIndices` (plan 165). Listings, descriptions,
 * counts, histograms and analyses run on the engine's helper session; a search runs on the index
 * tab's session so its rows page from the result store like a statement's.
 */
export interface IndexCalls {
  /** Every index, alias and data stream the datasource lists. */
  "indices.list": { params: Record<never, never>; result: readonly SearchTarget[] };
  /** The mapping, settings and time field of one target. */
  "indices.describe": { params: { readonly target: string }; result: SearchTargetDescription };
  /** Runs a search on `sessionId`; the rows go to the result store, the counters come back. */
  "indices.open": {
    params: { readonly sessionId: string; readonly request: SearchRequest } & ResultPaging & StatementLimit;
    result: OpenedSearch;
  };
  /** How many documents match, exactly, as a decimal string. */
  "indices.count": { params: { readonly request: SearchRequest }; result: string };
  /** Documents per interval over the request's time range, in about `buckets` bars. */
  "indices.histogram": {
    params: { readonly request: SearchRequest; readonly buckets: number };
    result: SearchHistogram;
  };
  /** The steps an analyzer takes over a text. */
  "indices.analyze": { params: { readonly request: AnalyzeRequest }; result: readonly AnalyzeStep[] };
}
