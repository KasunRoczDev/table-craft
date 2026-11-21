import { PluginError, type Column, type ExecuteResult, type Row, type WireValue } from "@table-craft/plugin-api";
import type { ElasticClient, Reply } from "./client.js";
import type { Dialect } from "./dialect.js";
import { cellOf, type Hit } from "./hits.js";
import { classify, parseRequest, pathSegments } from "./language.js";
import { shardWarnings } from "./search.js";

const JSON_INDENT = 2;
/** A console search shows at most this many source fields as columns, the rest stay in `_source`. */
const CONSOLE_FIELD_LIMIT = 200;
const READ_ONLY_ADVICE =
  "this data source is read-only, so TableCraft sends only requests that read. Turn read-only off in its settings to change data.";
const NDJSON_ENDPOINTS = new Set(["_bulk", "_msearch", "_msearch_template"]);

async function* yieldRows(rows: readonly Row[]): AsyncIterable<Row> {
  for (const row of rows) yield row;
  return Promise.resolve();
}

export function tableResult(columns: readonly Column[], rows: readonly Row[], sent?: string): ExecuteResult {
  return { columns, rows: yieldRows(rows), rowsAffected: null, ...(sent === undefined ? {} : { sent }) };
}

function replyResult(value: WireValue, text: string, read: boolean): ExecuteResult {
  return { columns: [], rows: yieldRows([]), rowsAffected: null, reply: { value, text, ...(read ? { read } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The dotted leaves of a source, in first-seen order: what a console search shows as columns. */
function leafPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (!isRecord(value)) {
    if (prefix !== "") out.add(prefix);
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isRecord(inner)) leafPaths(inner, path, out);
    else out.add(path);
  }
}

function leafValue(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

/** A search reply's hits as rows: `_id`, `_index`, `_score`, each source leaf, `_source`. */
export function hitsResult(hits: readonly Hit[]): ExecuteResult {
  const paths = new Set<string>();
  for (const hit of hits) leafPaths(hit._source, "", paths);
  const fields = [...paths].slice(0, CONSOLE_FIELD_LIMIT);
  const columns: Column[] = [
    { name: "_id", type: "keyword", typeClass: "text" },
    { name: "_index", type: "keyword", typeClass: "text" },
    { name: "_score", type: "float", typeClass: "float" },
    ...fields.map((name) => ({ name, type: null })),
    { name: "_source", type: "json", typeClass: "json" },
  ];
  const rows = hits.map((hit): Row => [
    cellOf(hit._id),
    cellOf(hit._index),
    typeof hit._score === "number" ? hit._score : null,
    ...fields.map((path) => cellOf(leafValue(hit._source, path))),
    hit._source === undefined ? null : { kind: "json", text: JSON.stringify(hit._source) },
  ]);
  return tableResult(columns, rows);
}

interface Bucket {
  readonly key?: unknown;
  readonly key_as_string?: unknown;
  readonly doc_count?: unknown;
  readonly [sub: string]: unknown;
}

/** The first aggregation's buckets as rows: `key`, `doc_count`, and each sub-aggregation's `value`. */
export function bucketsResult(name: string, aggregation: unknown): ExecuteResult | null {
  if (!isRecord(aggregation)) return null;
  const buckets = aggregation.buckets;
  if (!Array.isArray(buckets)) {
    const value = aggregation.value;
    if (value === undefined) return null;
    return tableResult([{ name, type: null }], [[cellOf(value)]]);
  }
  const subs = new Set<string>();
  for (const bucket of buckets as Bucket[]) {
    for (const [key, inner] of Object.entries(bucket)) {
      if (isRecord(inner) && "value" in inner) subs.add(key);
    }
  }
  const columns: Column[] = [
    { name: "key", type: null },
    { name: "doc_count", type: "long", typeClass: "integer" },
    ...[...subs].map((sub) => ({ name: sub, type: null })),
  ];
  const rows = (buckets as Bucket[]).map((bucket): Row => [
    cellOf(bucket.key_as_string ?? bucket.key),
    typeof bucket.doc_count === "number" ? bucket.doc_count : null,
    ...[...subs].map((sub) => cellOf((bucket[sub] as { value?: unknown } | undefined)?.value)),
  ]);
  return tableResult(columns, rows);
}

/** Rows of objects, such as a `_cat` reply in JSON, with one column per key. */
export function objectsResult(objects: readonly unknown[]): ExecuteResult {
  const keys = new Set<string>();
  for (const object of objects) if (isRecord(object)) for (const key of Object.keys(object)) keys.add(key);
  const names = [...keys];
  return tableResult(
    names.map((name) => ({ name, type: null })),
    objects.map((object): Row => names.map((name) => (isRecord(object) ? cellOf(object[name]) : null))),
  );
}

interface SqlColumn {
  readonly name?: unknown;
  readonly type?: unknown;
}

/** An Elasticsearch SQL reply (`columns`, `rows`) or an OpenSearch one (`schema`, `datarows`). */
export function sqlResult(body: unknown): ExecuteResult {
  if (!isRecord(body)) return replyResult(null, String(body), false);
  const columns = (
    Array.isArray(body.columns) ? body.columns : Array.isArray(body.schema) ? body.schema : []
  ) as SqlColumn[];
  const rows = (
    Array.isArray(body.rows) ? body.rows : Array.isArray(body.datarows) ? body.datarows : []
  ) as unknown[][];
  return tableResult(
    columns.map((column) => ({
      name: typeof column.name === "string" ? column.name : "?",
      type: typeof column.type === "string" ? column.type : null,
    })),
    rows.map((row): Row => row.map(cellOf)),
  );
}

function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, JSON_INDENT);
}

/** The body a REST request sends: JSON parsed now, so a typo is said before anything is sent. */
function bodyOf(path: string, text: string): { body: unknown; ndjson: boolean } {
  if (text === "") return { body: undefined, ndjson: false };
  const ndjson = pathSegments(path).some((segment) => NDJSON_ENDPOINTS.has(segment));
  if (ndjson) {
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch (cause) {
        throw new PluginError(
          "statementFailed",
          `Each line of a ${path} body is one JSON object; this one is not: ${line.slice(0, 80)} (${cause instanceof Error ? cause.message : String(cause)})`,
        );
      }
    }
    return { body: `${lines.join("\n")}\n`, ndjson: true };
  }
  try {
    return { body: JSON.parse(text) as unknown, ndjson: false };
  } catch (cause) {
    throw new PluginError(
      "statementFailed",
      `The request body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}.`,
    );
  }
}

function withJsonFormat(path: string): string {
  if (/[?&]format=/.test(path)) return path;
  return `${path}${path.includes("?") ? "&" : "?"}format=json`;
}

export interface ConsoleContext {
  readonly client: ElasticClient;
  readonly dialect: Dialect;
  readonly readOnly: boolean;
  readonly signal: AbortSignal;
}

function restResult(method: string, segments: readonly string[], reply: Reply): ExecuteResult {
  const body = reply.body;
  if (method === "HEAD")
    return replyResult(reply.status, `${String(reply.status)} - ${reply.status < 300 ? "OK" : "Not Found"}`, false);
  if (Array.isArray(body)) return objectsResult(body);
  if (isRecord(body)) {
    const hits = isRecord(body.hits) && Array.isArray(body.hits.hits) ? (body.hits.hits as Hit[]) : null;
    if (segments.some((segment) => segment === "_search" || segment === "scroll")) {
      const aggregations = isRecord(body.aggregations) ? Object.entries(body.aggregations) : [];
      const [first] = aggregations;
      if ((hits === null || hits.length === 0) && first !== undefined) {
        const buckets = bucketsResult(first[0], first[1]);
        if (buckets !== null) return buckets;
      }
      if (hits !== null) {
        const result = hitsResult(hits);
        const warnings = shardWarnings(body);
        return warnings.length === 0
          ? result
          : { ...result, reply: { value: warnings.join(" "), text: warnings.join(" ") } };
      }
    }
  }
  return replyResult(
    { kind: "json", text: JSON.stringify(body) },
    pretty(body),
    method === "GET" && body !== null && typeof body === "object",
  );
}

/** Runs one console request (plan 165), refused on a read-only session unless it only reads. */
export async function runRequest(context: ConsoleContext, command: string): Promise<ExecuteResult> {
  const request = parseRequest(command);
  if (request === null) {
    throw new PluginError(
      "statementFailed",
      "Start a request with a method and a path, such as GET products/_search, or write a SQL query starting with SELECT.",
    );
  }
  if (context.readOnly && classify(command).kind !== "read") {
    const named = request.kind === "rest" ? `${request.method} ${request.path}` : "This request";
    throw new PluginError("statementFailed", `${named} was not sent: ${READ_ONLY_ADVICE}`);
  }
  const { client, dialect, signal } = context;
  if (request.kind === "sql") {
    if (dialect.sqlPath === null) throw new PluginError("statementFailed", "This server has no SQL endpoint.");
    const reply = await client.json<unknown>("POST", dialect.sqlPath, {
      body: { query: request.query },
      signal,
    });
    return { ...sqlResult(reply), sent: `POST ${dialect.sqlPath}\n${pretty({ query: request.query })}` };
  }
  if (request.kind === "ppl") {
    if (dialect.pplPath === null) {
      throw new PluginError(
        "statementFailed",
        "PPL is an OpenSearch language; this server does not speak it. Write SQL or a REST request.",
      );
    }
    const reply = await client.json<unknown>("POST", dialect.pplPath, { body: { query: request.query }, signal });
    return { ...sqlResult(reply), sent: `POST ${dialect.pplPath}\n${pretty({ query: request.query })}` };
  }
  const segments = pathSegments(request.path);
  const path = segments[0] === "_cat" && request.method === "GET" ? withJsonFormat(request.path) : request.path;
  const { body, ndjson } = bodyOf(request.path, request.body);
  const reply = await client.request(request.method, path, {
    body,
    ndjson,
    signal,
    accept: request.method === "HEAD" ? [404] : [],
  });
  return restResult(request.method, segments, reply);
}
