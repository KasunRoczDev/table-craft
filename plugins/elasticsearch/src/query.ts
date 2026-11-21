import { PluginError, type SearchRequest } from "@table-craft/plugin-api";

/** The `query` object of a request built from the query bar and the time range. */
export function queryOf(request: Pick<SearchRequest, "language" | "query" | "time">): Record<string, unknown> {
  const text = request.query.trim();
  let main: Record<string, unknown> | null = null;
  if (text !== "") {
    main = request.language === "lucene" ? { query_string: { query: text, default_operator: "AND" } } : dslQuery(text);
  }
  const time = request.time;
  if (time === null || (time.from === null && time.to === null)) return main ?? { match_all: {} };
  const range: Record<string, string> = { format: "strict_date_optional_time" };
  if (time.from !== null) range.gte = time.from;
  if (time.to !== null) range.lte = time.to;
  return {
    bool: {
      ...(main === null ? {} : { must: [main] }),
      filter: [{ range: { [time.field]: range } }],
    },
  };
}

/** A Query DSL query as the bar holds it: the `query` object itself, or a body whose `query` it is. */
export function dslQuery(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new PluginError(
      "statementFailed",
      `The query is not JSON: ${cause instanceof Error ? cause.message : String(cause)}. Write a Query DSL object such as {"match": {"name": "coffee"}}, or switch to Lucene.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PluginError(
      "statementFailed",
      'Write the query as a JSON object, such as {"term": {"status": "active"}}.',
    );
  }
  const record = parsed as Record<string, unknown>;
  const inner = record.query;
  if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) return inner as Record<string, unknown>;
  return record;
}

/** The `sort` array; empty sorts by score. */
export function sortOf(request: Pick<SearchRequest, "sort">): Record<string, unknown>[] {
  return request.sort.map((sort) => ({ [sort.field]: { order: sort.order } }));
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Bucket widths a histogram rounds to, as `fixed_interval` writes them. */
const INTERVALS: readonly (readonly [number, string])[] = [
  [SECOND, "1s"],
  [5 * SECOND, "5s"],
  [10 * SECOND, "10s"],
  [30 * SECOND, "30s"],
  [MINUTE, "1m"],
  [5 * MINUTE, "5m"],
  [10 * MINUTE, "10m"],
  [30 * MINUTE, "30m"],
  [HOUR, "1h"],
  [3 * HOUR, "3h"],
  [12 * HOUR, "12h"],
  [DAY, "1d"],
  [7 * DAY, "7d"],
  [30 * DAY, "30d"],
];

/** The smallest round width that splits `spanMs` into at most `buckets` buckets. */
export function histogramInterval(spanMs: number, buckets: number): string {
  const wanted = spanMs / Math.max(1, buckets);
  for (const [width, text] of INTERVALS) if (width >= wanted) return text;
  return INTERVALS.at(-1)?.[1] ?? "30d";
}
