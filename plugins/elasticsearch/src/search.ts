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
import { isForbidden, type ElasticClient } from "./client.js";
import { PIT_KEEP_ALIVE, type Dialect } from "./dialect.js";
import { defaultFields, hitColumns, hitRow, type Hit, type HitColumns } from "./hits.js";
import { listTargets } from "./indices.js";
import { parseMapping, timeFieldOf } from "./mapping.js";
import { histogramInterval, queryOf, sortOf } from "./query.js";

interface SearchReply {
  readonly _scroll_id?: unknown;
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

/**
 * The `searchIndices` service over the REST client (plan 165). Pages past the first ride a scroll,
 * which every version and fork keeps alike; it is cleared as soon as the rows run out or the host
 * lets the result go.
 */
export class ElasticIndices implements IndexBrowser {
  readonly #client: ElasticClient;
  readonly #dialect: Dialect;
  readonly #filter: string;
  readonly #scrolls = new Set<string>();

  constructor(client: ElasticClient, dialect: Dialect, filter: string) {
    this.#client = client;
    this.#dialect = dialect;
    this.#filter = filter;
  }

  list(): Promise<readonly SearchTarget[]> {
    return listTargets(this.#client, this.#dialect, this.#filter);
  }

  async describe(target: string): Promise<SearchTargetDescription> {
    const path = `/${encoded(target)}`;
    const warnings: string[] = [];
    const mappingReply = await this.#client.json<Record<string, unknown>>("GET", `${path}/_mapping`);
    const settingsReply = await this.#client
      .json<Record<string, unknown>>("GET", `${path}/_settings`)
      .catch((error: unknown) => {
        if (!isForbidden(error)) throw error;
        warnings.push(`The settings are hidden: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
    const { fields, mappingType } = parseMapping(mappingReply, this.#dialect.mappingTypes);
    const indices = Object.keys(mappingReply).sort();
    const kind = indices.length === 1 && indices[0] === target ? "index" : "alias";
    return {
      name: target,
      kind,
      indices,
      mappingType,
      fields,
      timeField: timeFieldOf(fields),
      mapping: pretty(mappingReply),
      settings: settingsReply === null ? null : pretty(settingsReply),
      warnings,
    };
  }

  async search(request: SearchRequest): Promise<SearchOutcome> {
    const pageSize = Math.min(Math.max(1, Math.trunc(request.pageSize)), SEARCH_PAGE_LIMIT);
    const description = await this.describe(request.target);
    const fields = request.fields ?? defaultFields(description.fields, description.timeField);
    const withIndex = description.indices.length > 1 || WILDCARD.test(request.target);
    const sort = sortOf(request);
    const shape = hitColumns(fields, description.fields, withIndex, sort.length === 0);
    const body: Record<string, unknown> = {
      query: queryOf(request),
      size: pageSize,
      ...(sort.length === 0 ? {} : { sort }),
    };
    const first = await this.#client.json<SearchReply>(
      "POST",
      `/${encoded(request.target)}/_search?scroll=${PIT_KEEP_ALIVE}`,
      { body },
    );
    const scrollId = typeof first._scroll_id === "string" ? first._scroll_id : null;
    const hits = first.hits?.hits ?? [];
    const total = totalOf(first.hits?.total);
    const done = hits.length < pageSize || (total?.relation === "eq" && Number(total.value) <= hits.length);
    if (scrollId !== null && done) await this.#clearScroll(scrollId);
    else if (scrollId !== null) this.#scrolls.add(scrollId);
    return {
      result: {
        columns: shape.columns,
        rows: this.#pages(hits, done ? null : scrollId, shape),
        rowsAffected: null,
      } satisfies ExecuteResult,
      total,
      tookMs: int(first.took),
      shards: shardsOf(first),
      request: requestText(request.target, body),
      warnings: shardWarnings(first),
    };
  }

  async *#pages(first: readonly Hit[], scrollId: string | null, shape: HitColumns): AsyncIterable<Row> {
    let current = scrollId;
    try {
      for (const hit of first) yield hitRow(hit, shape);
      while (current !== null) {
        const reply: SearchReply = await this.#client.json<SearchReply>("POST", "/_search/scroll", {
          body: { scroll: PIT_KEEP_ALIVE, scroll_id: current },
        });
        const next = typeof reply._scroll_id === "string" ? reply._scroll_id : current;
        if (next !== current) {
          this.#scrolls.delete(current);
          this.#scrolls.add(next);
          current = next;
        }
        const page = reply.hits?.hits ?? [];
        for (const hit of page) yield hitRow(hit, shape);
        if (page.length === 0) break;
      }
    } finally {
      if (current !== null) await this.#clearScroll(current);
    }
  }

  async #clearScroll(id: string): Promise<void> {
    this.#scrolls.delete(id);
    await this.#client
      .request("DELETE", "/_search/scroll", { body: { scroll_id: [id] }, accept: [404] })
      .catch(() => undefined);
  }

  /** Scrolls the session still holds, for a test that checks every one was cleared. */
  get openScrolls(): number {
    return this.#scrolls.size;
  }

  async count(request: SearchRequest): Promise<string> {
    const reply = await this.#client.json<{ count?: unknown }>("POST", `/${encoded(request.target)}/_count`, {
      body: { query: queryOf(request) },
    });
    return String(int(reply.count));
  }

  async histogram(request: SearchRequest, buckets: number): Promise<SearchHistogram> {
    const time = request.time;
    if (time === null) throw new PluginError("statementFailed", "A histogram needs a time field and a time range.");
    const to = time.to === null ? Date.now() : Date.parse(time.to);
    const from = time.from === null ? to - 24 * 60 * 60 * 1000 : Date.parse(time.from);
    const interval = histogramInterval(Math.max(1, to - from), buckets);
    const intervalKey =
      this.#dialect.version.major < 7 && this.#dialect.distribution === "elasticsearch" ? "interval" : "fixed_interval";
    const body = {
      size: 0,
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
    const reply = await this.#client.json<SearchReply>("POST", `/${encoded(request.target)}/_search`, { body });
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

  async analyze(request: AnalyzeRequest): Promise<readonly AnalyzeStep[]> {
    const body: Record<string, unknown> = { text: request.text, explain: true };
    if (request.field !== null) body.field = request.field;
    else if (request.analyzer !== null) body.analyzer = request.analyzer;
    const reply = await this.#client.json<{ detail?: AnalyzeDetail }>("POST", `/${encoded(request.target)}/_analyze`, {
      body,
    });
    return analyzeSteps(reply.detail);
  }

  async close(): Promise<void> {
    const ids = [...this.#scrolls];
    this.#scrolls.clear();
    if (ids.length === 0) return;
    await this.#client
      .request("DELETE", "/_search/scroll", { body: { scroll_id: ids }, accept: [404] })
      .catch(() => undefined);
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
