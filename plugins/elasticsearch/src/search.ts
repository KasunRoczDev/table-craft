import {
  PluginError,
  SEARCH_PAGE_LIMIT,
  type AnalyzeRequest,
  type AnalyzeStep,
  type AnalyzedToken,
  type ExecuteResult,
  type IndexBrowser,
  type Row,
  type SearchHistogram,
  type SearchOutcome,
  type SearchRequest,
  type SearchShards,
  type SearchTarget,
  type SearchTargetDescription,
  type SearchTotal,
} from "@table-craft/plugin-api";
import { isForbidden, requestJson, type ElasticTransport } from "./client.js";
import { SEARCH_KEPT_BYTES, rowBytes } from "./limits.js";
import type { Dialect } from "./dialect.js";
import { defaultFields, hitColumns, hitRow, type Hit, type HitColumns } from "./hits.js";
import { listTargets } from "./indices.js";
import { parseMapping, timeFieldOf } from "./mapping.js";
import { Cursors, hitKey, laterPages, shrinking, type Continuation, type TrackRequest } from "./paging.js";
import { histogramInterval, queryOf, sortOf } from "./query.js";

export type { TrackRequest } from "./paging.js";

interface SearchReply {
  readonly took?: unknown;
  readonly timed_out?: unknown;
  readonly _shards?: {
    readonly total?: unknown;
    readonly successful?: unknown;
    readonly skipped?: unknown;
    readonly failed?: unknown;
    readonly failures?: readonly { readonly index?: unknown; readonly reason?: { readonly reason?: unknown } }[];
  };
  readonly hits?: { readonly total?: unknown; readonly hits?: readonly Hit[] };
  readonly aggregations?: Record<string, unknown>;
}

const JSON_INDENT = 2;
const HISTOGRAM_AGG = "over_time";
const WILDCARD = /[*?,]/;
/** Indices of a large target whose mappings stand for all of them. */
const MAPPING_SAMPLE = 4;
/** The span a histogram covers when its range has no start. */
const OPEN_RANGE_MS = 24 * 60 * 60 * 1000;
/**
 * Page one reads one hit past the page, so the host's look-ahead row (it reads one past what it
 * shows, to know whether more follow) never opens a cursor for a user who stays on page one.
 */
const LOOKAHEAD_HITS = 1;
/** Hits page one counts exactly; past it the footer reads `≥ 10,000`, and Count still counts them all. */
export const TRACK_TOTAL_HITS_UP_TO = 10_000;
/** What a scored search sorts by, said outright so its hits carry the score `search_after` goes on from. */
const BY_SCORE = { _score: { order: "desc" } };

/**
 * Sent in the body of every search, count and histogram, so a search the user abandoned, or whose
 * reply a gateway dropped, stops on the shards instead of running on. A search past it answers
 * with what it found and `timed_out: true`.
 */
export const SEARCH_TIMEOUT = "30s";

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function totalOf(total: unknown): SearchTotal | null {
  if (typeof total === "number") return { value: String(total), relation: "eq" };
  if (typeof total === "object" && total !== null) {
    const { value, relation } = total as { value?: unknown; relation?: unknown };
    if (typeof value === "number") return { value: String(value), relation: relation === "gte" ? "gte" : "eq" };
  }
  return null;
}

export function shardsOf(reply: SearchReply): SearchShards {
  const shards = reply._shards;
  return {
    total: int(shards?.total),
    successful: int(shards?.successful),
    skipped: int(shards?.skipped),
    failed: int(shards?.failed),
  };
}

export function shardWarnings(reply: SearchReply): string[] {
  const warnings: string[] = [];
  const failed = int(reply._shards?.failed);
  if (failed > 0) {
    const reasons = [
      ...new Set(
        (reply._shards?.failures ?? [])
          .map((failure) => failure.reason?.reason)
          .filter((reason): reason is string => typeof reason === "string"),
      ),
    ];
    warnings.push(
      `${String(failed)} of ${String(int(reply._shards?.total))} shards failed, so the hits are incomplete${reasons.length === 0 ? "" : `: ${reasons.join("; ")}`}.`,
    );
  }
  if (reply.timed_out === true) warnings.push("The search timed out on the server; the hits are partial.");
  return warnings;
}

function sortValuesOf(hit: Hit | undefined): readonly unknown[] | null {
  return Array.isArray(hit?.sort) ? (hit.sort as unknown[]) : null;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, JSON_INDENT);
}

/** `GET target/_search` and the body, as Dev Tools and the console read it. */
export function requestText(target: string, body: unknown): string {
  return `GET ${target}/_search\n${pretty(body)}`;
}

function encoded(target: string): string {
  return target
    .split(",")
    .map((part) => encodeURIComponent(part.trim()).replace(/%2A/g, "*"))
    .join(",");
}

const UNTRACKED: TrackRequest = (work) => work(new AbortController().signal);

interface MappingOf {
  readonly reply: Record<string, unknown>;
  readonly fields: SearchTargetDescription["fields"];
  readonly mappingType: string | null;
  readonly indices: readonly string[];
  /** The path segment the mapping was read from: the target, or its sampled indices. */
  readonly read: string;
  readonly sampled: boolean;
}

/**
 * The `searchIndices` service over the REST client (plan 165). Page one is a plain search that
 * leaves nothing open on the server; only a reader past it opens a point in time, or a scroll on a
 * server without one (`laterPages`), released as soon as the rows run out or the host lets the
 * result go.
 */
export class ElasticIndices implements IndexBrowser {
  readonly #transport: ElasticTransport;
  readonly #dialect: Dialect;
  readonly #filter: string;
  readonly #track: TrackRequest;
  readonly #keptBytes: number;
  readonly #cursors: Cursors;

  constructor(
    transport: ElasticTransport,
    dialect: Dialect,
    filter: string,
    track: TrackRequest = UNTRACKED,
    keptBytes: number = SEARCH_KEPT_BYTES,
  ) {
    this.#transport = transport;
    this.#dialect = dialect;
    this.#filter = filter;
    this.#track = track;
    this.#keptBytes = keptBytes;
    this.#cursors = new Cursors(transport, dialect);
  }

  list(): Promise<readonly SearchTarget[]> {
    return this.#track((signal) => listTargets(this.#transport, this.#dialect, this.#filter, signal));
  }

  /** The indices behind a target, sorted, or null when `_cat` is not allowed. */
  async #indexNames(target: string, signal: AbortSignal): Promise<string[] | null> {
    try {
      const rows = await requestJson<readonly { index?: unknown }[]>(
        this.#transport,
        "GET",
        `/_cat/indices/${encoded(target)}?format=json&h=index`,
        { signal },
      );
      return rows
        .map((row) => row.index)
        .filter((name): name is string => typeof name === "string")
        .sort();
    } catch (error) {
      if (signal.aborted) throw error;
      return null;
    }
  }

  /**
   * The mapping of a target, read from its last `MAPPING_SAMPLE` indices by name when it has more:
   * a rollover family of hundreds shares one template, and their mappings together run to tens of
   * megabytes read again on every search.
   */
  async #mapping(target: string, signal: AbortSignal): Promise<MappingOf> {
    const names = await this.#indexNames(target, signal);
    const sampled = names !== null && names.length > MAPPING_SAMPLE ? names.slice(-MAPPING_SAMPLE) : null;
    const read = sampled === null ? encoded(target) : sampled.map((name) => encodeURIComponent(name)).join(",");
    const reply = await requestJson<Record<string, unknown>>(this.#transport, "GET", `/${read}/_mapping`, { signal });
    const { fields, mappingType } = parseMapping(reply, this.#dialect.mappingTypes);
    const indices = names !== null && names.length > 0 ? names : Object.keys(reply).sort();
    return { reply, fields, mappingType, indices, read, sampled: sampled !== null };
  }

  describe(target: string): Promise<SearchTargetDescription> {
    return this.#track(async (signal) => {
      const warnings: string[] = [];
      const { reply, fields, mappingType, indices, read, sampled } = await this.#mapping(target, signal);
      if (sampled) {
        warnings.push(
          `The mapping and settings shown are those of the last ${String(MAPPING_SAMPLE)} of ${indices.length.toLocaleString("en-US")} indices by name, the newest of a rollover family.`,
        );
      }
      const settingsReply = await requestJson<Record<string, unknown>>(this.#transport, "GET", `/${read}/_settings`, {
        signal,
      }).catch((error: unknown) => {
        if (!isForbidden(error)) throw error;
        warnings.push(`The settings are hidden: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      const kind = indices.length === 1 && indices[0] === target ? "index" : "alias";
      return {
        name: target,
        kind,
        indices,
        mappingType,
        fields,
        timeField: timeFieldOf(fields),
        mapping: pretty(reply),
        settings: settingsReply === null ? null : pretty(settingsReply),
        warnings,
      };
    });
  }

  search(request: SearchRequest): Promise<SearchOutcome> {
    return this.#track((signal) => this.#search(request, signal));
  }

  async #search(request: SearchRequest, signal: AbortSignal): Promise<SearchOutcome> {
    const pageSize = Math.min(Math.max(1, Math.trunc(request.pageSize)), SEARCH_PAGE_LIMIT);
    const mapping = await this.#mapping(request.target, signal);
    const timeField = timeFieldOf(mapping.fields);
    const fields = request.fields ?? defaultFields(mapping.fields, timeField);
    const withIndex = mapping.indices.length > 1 || WILDCARD.test(request.target);
    const sort = sortOf(request);
    const scored = sort.length === 0 && request.query.trim() !== "";
    const shape = hitColumns(fields, mapping.fields, withIndex, scored, timeField === null ? "first" : "last");
    const query = queryOf(request);
    const order = scored ? [BY_SCORE] : sort;
    const target = encoded(request.target);
    const bodyOf = (size: number): Record<string, unknown> => ({
      query,
      size,
      timeout: SEARCH_TIMEOUT,
      ...(this.#dialect.trackTotalHitsUpTo ? { track_total_hits: TRACK_TOTAL_HITS_UP_TO } : {}),
      ...(order.length === 0 ? {} : { sort: order }),
    });
    const { reply: first, size } = await shrinking(
      (work) => work(signal),
      (at, signal) =>
        requestJson<SearchReply>(this.#transport, "POST", `/${target}/_search`, { body: bodyOf(at), signal }),
      Math.min(pageSize + LOOKAHEAD_HITS, SEARCH_PAGE_LIMIT),
    );
    const hits = first.hits?.hits ?? [];
    const total = totalOf(first.hits?.total);
    const done = hits.length < size || (total?.relation === "eq" && Number(total.value) <= hits.length);
    const continuation: Continuation | null = done
      ? null
      : {
          target,
          query,
          sort: order,
          size,
          timeout: SEARCH_TIMEOUT,
          after: order.length === 0 ? null : sortValuesOf(hits[hits.length - 1]),
          seen: new Set(hits.map(hitKey)),
        };
    const warning = this.#cursors.takeWarning();
    return {
      result: {
        columns: shape.columns,
        rows: this.#pages(hits, continuation, shape),
        rowsAffected: null,
      } satisfies ExecuteResult,
      total,
      tookMs: int(first.took),
      shards: shardsOf(first),
      request: requestText(request.target, bodyOf(size)),
      warnings: warning === null ? shardWarnings(first) : [...shardWarnings(first), warning],
    };
  }

  async *#pages(first: readonly Hit[], continuation: Continuation | null, shape: HitColumns): AsyncIterable<Row> {
    let kept = 0;
    const keep = (hit: Hit): Row | null => {
      if (kept >= this.#keptBytes) return null;
      const row = hitRow(hit, shape);
      kept += rowBytes(row);
      return row;
    };
    for (const hit of first) {
      const row = keep(hit);
      if (row === null) return;
      yield row;
    }
    if (continuation === null) return;
    for await (const page of laterPages(this.#transport, this.#dialect, this.#cursors, this.#track, continuation)) {
      for (const hit of page) {
        const row = keep(hit);
        if (row === null) return;
        yield row;
      }
      if (kept >= this.#keptBytes) return;
    }
  }

  /** Cursors the session still holds, for a test that checks every one was released. */
  get openCursors(): number {
    return this.#cursors.open;
  }

  count(request: SearchRequest): Promise<string> {
    return this.#track(async (signal) => {
      const reply = await requestJson<SearchReply>(this.#transport, "POST", `/${encoded(request.target)}/_search`, {
        body: { size: 0, track_total_hits: true, timeout: SEARCH_TIMEOUT, query: queryOf(request) },
        signal,
      });
      if (reply.timed_out === true) {
        throw new PluginError(
          "statementFailed",
          `The count timed out on the server after ${SEARCH_TIMEOUT}; narrow the query or the time range.`,
        );
      }
      return totalOf(reply.hits?.total)?.value ?? "0";
    });
  }

  histogram(request: SearchRequest, buckets: number): Promise<SearchHistogram> {
    return this.#track((signal) => this.#histogram(request, buckets, signal));
  }

  async #histogram(request: SearchRequest, buckets: number, signal: AbortSignal): Promise<SearchHistogram> {
    const time = request.time;
    if (time === null) throw new PluginError("statementFailed", "A histogram needs a time field and a time range.");
    const to = time.to === null ? Date.now() : Date.parse(time.to);
    const from = time.from === null ? to - OPEN_RANGE_MS : Date.parse(time.from);
    const interval = histogramInterval(Math.max(1, to - from), buckets);
    const intervalKey = this.#dialect.fixedInterval ? "fixed_interval" : "interval";
    const body = {
      size: 0,
      timeout: SEARCH_TIMEOUT,
      query: queryOf(request),
      aggs: {
        [HISTOGRAM_AGG]: {
          date_histogram: {
            field: time.field,
            [intervalKey]: interval,
            min_doc_count: 0,
            extended_bounds: { min: from, max: to },
          },
        },
      },
    };
    const reply = await requestJson<SearchReply>(this.#transport, "POST", `/${encoded(request.target)}/_search`, {
      body,
      signal,
    });
    const agg = reply.aggregations?.[HISTOGRAM_AGG] as
      { buckets?: readonly { key?: unknown; doc_count?: unknown }[] } | undefined;
    return {
      field: time.field,
      interval,
      buckets: (agg?.buckets ?? []).map((bucket) => ({
        at: new Date(int(bucket.key)).toISOString(),
        count: int(bucket.doc_count),
      })),
    };
  }

  analyze(request: AnalyzeRequest): Promise<readonly AnalyzeStep[]> {
    const body: Record<string, unknown> = { text: request.text, explain: true };
    if (request.field !== null) body.field = request.field;
    else if (request.analyzer !== null) body.analyzer = request.analyzer;
    return this.#track(async (signal) => {
      const reply = await requestJson<{ detail?: AnalyzeDetail }>(
        this.#transport,
        "POST",
        `/${encoded(request.target)}/_analyze`,
        { body, signal },
      );
      return analyzeSteps(reply.detail);
    });
  }

  async close(): Promise<void> {
    await this.#cursors.releaseAll();
  }
}

interface AnalyzeTokens {
  readonly name?: unknown;
  readonly tokens?: readonly { readonly token?: unknown; readonly position?: unknown }[];
  readonly filtered_text?: unknown;
}

interface AnalyzeDetail {
  readonly analyzer?: AnalyzeTokens;
  readonly charfilters?: readonly AnalyzeTokens[];
  readonly tokenizer?: AnalyzeTokens;
  readonly tokenfilters?: readonly AnalyzeTokens[];
}

function tokensOf(step: AnalyzeTokens | undefined): AnalyzedToken[] {
  return (step?.tokens ?? []).map((token) => ({
    token: typeof token.token === "string" ? token.token : "",
    position: int(token.position),
  }));
}

function nameOf(step: AnalyzeTokens | undefined): string {
  return typeof step?.name === "string" ? step.name : "?";
}

/** The steps of an `explain: true` analysis: char filters, the tokenizer and each token filter, or the one analyzer. */
export function analyzeSteps(detail: AnalyzeDetail | undefined): AnalyzeStep[] {
  if (detail === undefined) return [];
  if (detail.tokenizer === undefined) {
    return detail.analyzer === undefined
      ? []
      : [{ name: nameOf(detail.analyzer), kind: "analyzer", tokens: tokensOf(detail.analyzer) }];
  }
  const steps: AnalyzeStep[] = [];
  for (const filter of detail.charfilters ?? []) {
    const filtered = Array.isArray(filter.filtered_text) ? (filter.filtered_text as unknown[]).join(" ") : "";
    steps.push({ name: nameOf(filter), kind: "charFilter", tokens: [{ token: filtered, position: 0 }] });
  }
  steps.push({ name: nameOf(detail.tokenizer), kind: "tokenizer", tokens: tokensOf(detail.tokenizer) });
  for (const filter of detail.tokenfilters ?? []) {
    steps.push({ name: nameOf(filter), kind: "tokenFilter", tokens: tokensOf(filter) });
  }
  return steps;
}
