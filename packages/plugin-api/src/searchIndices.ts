import type { ExecuteResult } from "./plugin.js";

/** What a name in the index tree is (plan 165). */
export const SEARCH_TARGET_KINDS = ["index", "alias", "dataStream"] as const;

export type SearchTargetKind = (typeof SEARCH_TARGET_KINDS)[number];

/** One index, alias or data stream, as one listing of the cluster reports it. */
export interface SearchTarget {
  readonly name: string;
  readonly kind: SearchTargetKind;
  /** A system or hidden index, such as one whose name starts with a dot; the tree folds them away. */
  readonly hidden: boolean;
  /** The server's word for its health: `green`, `yellow`, `red`; null for an alias or when unknown. */
  readonly health: string | null;
  /** `open` or `close`; null when unknown. */
  readonly status: string | null;
  /** Documents, as a decimal string; null when unknown or not allowed. */
  readonly docs: string | null;
  /** Bytes on disk with replicas, as a decimal string; null when unknown. */
  readonly bytes: string | null;
  /** The indices an alias or data stream points at, the newest last; empty for an index. */
  readonly indices: readonly string[];
  /** The index an alias or data stream writes to; null when none is marked. */
  readonly writeIndex: string | null;
}

/** One field of a mapping, flattened to its dotted path. */
export interface SearchField {
  /** `customer.address.city`, `name.keyword` for a multi-field. */
  readonly path: string;
  /** The mapping type: `keyword`, `text`, `date`, `long`, `object`, `nested`… */
  readonly type: string;
  /** The path of the field this is a multi-field of; null for a field of its own. */
  readonly multiOf: string | null;
  /** The analyzer a `text` field indexes with; null for the default or another type. */
  readonly analyzer: string | null;
  /** The field can be sorted and aggregated on (`doc_values`, or a keyword). */
  readonly aggregatable: boolean;
}

export interface SearchTargetDescription {
  readonly name: string;
  readonly kind: SearchTargetKind;
  /** The concrete indices behind the name, the name itself for an index. */
  readonly indices: readonly string[];
  /** The 6.x mapping type the index keeps its fields under, such as `_doc`; null from 7.0. */
  readonly mappingType: string | null;
  readonly fields: readonly SearchField[];
  /** A `date` field the documents are best read by: `@timestamp` when it is a date; null without one. */
  readonly timeField: string | null;
  /** The mapping and settings as the server returns them, pretty-printed JSON; null when not allowed. */
  readonly mapping: string | null;
  readonly settings: string | null;
  /** Why the mapping or settings are missing, such as a refused privilege; empty when they are not. */
  readonly warnings: readonly string[];
}

/** How the query bar's text reads: a Lucene query string, or a Query DSL `query` object. */
export const SEARCH_QUERY_LANGUAGES = ["lucene", "dsl"] as const;

export type SearchQueryLanguage = (typeof SEARCH_QUERY_LANGUAGES)[number];

export interface SearchSort {
  readonly field: string;
  readonly order: "asc" | "desc";
}

/** An inclusive time window, ISO 8601 ends; a null end is open. */
export interface SearchTimeRange {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
}

export interface SearchRequest {
  readonly target: string;
  readonly language: SearchQueryLanguage;
  /** Empty matches every document. */
  readonly query: string;
  readonly sort: readonly SearchSort[];
  readonly time: SearchTimeRange | null;
  /** The fields that become columns, in order; null lets the plugin choose from the mapping. */
  readonly fields: readonly string[] | null;
  /** Documents per page the plugin fetches as the host pulls rows; at most `SEARCH_PAGE_LIMIT`. */
  readonly pageSize: number;
}

export const SEARCH_PAGE_LIMIT = 10_000;

/** The column a search result leads with, and the one it ends with holding the whole document. */
export const SEARCH_ID_COLUMN = "_id";
export const SEARCH_INDEX_COLUMN = "_index";
export const SEARCH_SOURCE_COLUMN = "_source";

export interface SearchTotal {
  /** Decimal string. */
  readonly value: string;
  /** `gte` when the server stopped counting, as `hits.total.relation` says. */
  readonly relation: "eq" | "gte";
}

export interface SearchShards {
  readonly total: number;
  readonly successful: number;
  /** Shards the server skipped without searching, as a time range lets it. */
  readonly skipped: number;
  readonly failed: number;
}

export interface SearchOutcome {
  /**
   * `_id`, `_index` when the target spans indices, `_score` when the query scores, one column per
   * shown field, and `_source`. Rows page lazily from the server as the host pulls them; a missing
   * field is NULL.
   */
  readonly result: ExecuteResult;
  readonly total: SearchTotal | null;
  readonly tookMs: number;
  readonly shards: SearchShards;
  /** The method, path and body of the first page, as a console runs it again. */
  readonly request: string;
  /** Shard failures and fields that were left out, said once. */
  readonly warnings: readonly string[];
}

export interface HistogramBucket {
  /** ISO 8601 start of the bucket. */
  readonly at: string;
  readonly count: number;
}

export interface SearchHistogram {
  readonly field: string;
  /** The bucket width as the server reads it: `30s`, `1m`, `1h`. */
  readonly interval: string;
  readonly buckets: readonly HistogramBucket[];
}

/** One token as an analyzer step leaves it. */
export interface AnalyzedToken {
  readonly token: string;
  readonly position: number;
}

export interface AnalyzeStep {
  /** `standard`, `lowercase`, `asciifolding`… */
  readonly name: string;
  readonly kind: "charFilter" | "tokenizer" | "tokenFilter" | "analyzer";
  readonly tokens: readonly AnalyzedToken[];
}

export interface AnalyzeRequest {
  readonly target: string;
  /** Analyze as this field's analyzer; null uses `analyzer` or the index default. */
  readonly field: string | null;
  readonly analyzer: string | null;
  readonly text: string;
}

/**
 * The `searchIndices` service (plan 165): indices, aliases and data streams of a search engine,
 * their mappings, and searches whose hits become a result. Every method rejects with
 * `statementFailed` saying what the server refused; a refused privilege is said as such and never
 * reads as a lost connection.
 */
export interface IndexBrowser {
  /** Every index, alias and data stream the datasource shows, hidden ones included and marked. */
  list(): Promise<readonly SearchTarget[]>;
  describe(target: string): Promise<SearchTargetDescription>;
  search(request: SearchRequest): Promise<SearchOutcome>;
  /** Documents matching the request's query and time range, counted exactly, as a decimal string. */
  count(request: SearchRequest): Promise<string>;
  /** Hits over time in about `buckets` buckets, for a request with a time range. */
  histogram(request: SearchRequest, buckets: number): Promise<SearchHistogram>;
  /** The steps `text` goes through on its way into the index. */
  analyze(request: AnalyzeRequest): Promise<readonly AnalyzeStep[]>;
}
