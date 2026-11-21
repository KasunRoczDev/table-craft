import type { StatementClass, StatementSpan } from "@table-craft/plugin-api";
import { HTTP_METHODS, type HttpMethod } from "./client.js";

/** A line that starts a REST request, as Kibana Dev Tools reads one: `GET index/_search`. */
const REQUEST_LINE = new RegExp(`^(${HTTP_METHODS.join("|")})\\s+(\\S+)\\s*$`, "i");
/** A line that starts a SQL query or a PPL one, sent to the server's SQL or PPL endpoint. */
const SQL_LINE = /^(select|show|describe|desc|explain)\b/i;
const PPL_LINE = /^(source|search)\s*=/i;
const COMMENT_LINE = /^\s*(#|\/\/)/;

export type ConsoleRequest =
  | { readonly kind: "rest"; readonly method: HttpMethod; readonly path: string; readonly body: string }
  | { readonly kind: "sql"; readonly query: string }
  | { readonly kind: "ppl"; readonly query: string };

function isBlankOrComment(line: string): boolean {
  return line.trim() === "" || COMMENT_LINE.test(line);
}

function startsCommand(line: string): boolean {
  const trimmed = line.trim();
  return REQUEST_LINE.test(trimmed) || SQL_LINE.test(trimmed) || PPL_LINE.test(trimmed);
}

interface Line {
  readonly from: number;
  readonly text: string;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  for (const text_ of text.split("\n")) {
    lines.push({ from, text: text_ });
    from += text_.length + 1;
  }
  return lines;
}

/** How deep `line` leaves the braces and brackets it opens, outside strings. */
function depthAfter(line: string, depth: number, inString: { value: boolean }): number {
  let next = depth;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString.value) {
      if (char === "\\") index += 1;
      else if (char === '"') inString.value = false;
    } else if (char === '"') inString.value = true;
    else if (char === "{" || char === "[") next += 1;
    else if (char === "}" || char === "]") next = Math.max(0, next - 1);
  }
  return next;
}

/**
 * Every request of `text` (plan 165): a `METHOD path` line and the JSON body under it, a SQL query
 * up to its `;` or a blank line, or a PPL line. A body ends where a new request line starts outside
 * any brace, so NDJSON for `_bulk` and `_msearch` spans as many lines as it holds.
 */
export function split(text: string): StatementSpan[] {
  const lines = linesOf(text);
  const spans: StatementSpan[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (isBlankOrComment(line.text)) {
      index += 1;
      continue;
    }
    const indent = line.text.length - line.text.trimStart().length;
    const from = line.from + indent;
    let last = index;
    const trimmed = line.text.trim();
    if (REQUEST_LINE.test(trimmed)) {
      let depth = 0;
      const inString = { value: false };
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next];
        if (candidate === undefined) break;
        if (depth === 0 && !inString.value && startsCommand(candidate.text)) break;
        depth = depthAfter(candidate.text, depth, inString);
        if (!isBlankOrComment(candidate.text) || depth > 0) last = next;
      }
    } else {
      for (let next = index; next < lines.length; next += 1) {
        const candidate = lines[next];
        if (candidate === undefined || candidate.text.trim() === "") break;
        const following = candidate.text.trim();
        if (next > index && (REQUEST_LINE.test(following) || PPL_LINE.test(following))) break;
        last = next;
        if (candidate.text.trimEnd().endsWith(";")) break;
      }
    }
    const end = lines[last];
    let to = end === undefined ? text.length : end.from + end.text.trimEnd().length;
    let sql = text.slice(from, to);
    if (!REQUEST_LINE.test(trimmed) && sql.endsWith(";")) {
      to -= 1;
      sql = sql.slice(0, -1);
    }
    spans.push({ from, to, sql });
    index = last + 1;
  }
  return spans;
}

/** The request one span holds, or null when its first line is none of the three forms. */
export function parseRequest(command: string): ConsoleRequest | null {
  const text = command.trim();
  const newline = text.indexOf("\n");
  const first = (newline === -1 ? text : text.slice(0, newline)).trim();
  const match = REQUEST_LINE.exec(first);
  if (match !== null) {
    const method = (match[1] ?? "GET").toUpperCase() as HttpMethod;
    const raw = match[2] ?? "/";
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    return { kind: "rest", method, path, body: newline === -1 ? "" : text.slice(newline + 1).trim() };
  }
  if (PPL_LINE.test(first)) return { kind: "ppl", query: text.replace(/;\s*$/, "") };
  if (SQL_LINE.test(first)) return { kind: "sql", query: text.replace(/;\s*$/, "") };
  return null;
}

/** The path's segments without its query string, decoded. */
export function pathSegments(path: string): string[] {
  const bare = path.split("?")[0] ?? "";
  return bare
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Endpoints a POST only reads through. */
const READ_ENDPOINTS = new Set([
  "_search",
  "_count",
  "_msearch",
  "_mget",
  "_analyze",
  "_validate",
  "_explain",
  "_field_caps",
  "_sql",
  "_ppl",
  "_termvectors",
  "_mtermvectors",
  "_render",
  "_terms_enum",
  "_eql",
  "_async_search",
  "_knn_search",
]);
/** Endpoints that change an index's shape rather than its documents. */
const DDL_ENDPOINTS = new Set([
  "_mapping",
  "_mappings",
  "_settings",
  "_alias",
  "_aliases",
  "_close",
  "_open",
  "_rollover",
  "_shrink",
  "_split",
  "_clone",
  "_template",
  "_index_template",
  "_component_template",
  "_data_stream",
  "_ilm",
  "_ism",
  "_forcemerge",
  "_refresh",
  "_flush",
]);

/** Endpoints whose DELETE drops indices wholesale: a data stream's backing indices, or templates new indices take. */
const DROPPING_ENDPOINTS = new Set(["_data_stream", "_index_template", "_template", "_component_template"]);
/** Prefixes plugins put their endpoints under, such as `_plugins/_sql`. */
const NAMESPACES = new Set(["_plugins", "_opendistro", "_xpack"]);
/** `_all` names every index. */
const ALL_INDICES = "_all";
const BULK_DELETE = /"delete"\s*:/;

function isIndexName(segment: string | undefined): segment is string {
  return segment !== undefined && segment !== "" && !segment.startsWith("_");
}

/**
 * A request's target and endpoint by position: `/<target>/<endpoint>/…` or `/<endpoint>/…`, a
 * plugin namespace skipped, and on 6.x a type between them. Matching by position rather than
 * anywhere in the path keeps an index named `scroll` or `_search` in a document id from reading
 * as an endpoint.
 */
function routeOf(segments: readonly string[]): {
  readonly target: string | null;
  readonly endpoint: string | null;
  readonly rest: readonly string[];
} {
  const target = isIndexName(segments[0]) ? segments[0] : segments[0] === ALL_INDICES ? ALL_INDICES : null;
  let at = target === null ? 0 : 1;
  if (NAMESPACES.has(segments[at] ?? "")) at += 1;
  if (target !== null && isIndexName(segments[at]) && segments[at + 1]?.startsWith("_") === true) at += 1;
  const candidate = segments[at];
  const endpoint = candidate?.startsWith("_") === true ? candidate : null;
  return { target, endpoint, rest: endpoint === null ? [] : segments.slice(at + 1) };
}

function isCursorRequest(target: string | null, endpoint: string | null, rest: readonly string[]): boolean {
  if (endpoint === "_pit") return true;
  if (endpoint !== "_search") return false;
  const sub = rest[0];
  return (target === null && sub === "scroll") || sub === "point_in_time";
}

/** What a request does (plan 165): reads, writes, index changes, and which need confirming. */
export function classify(command: string): StatementClass {
  const request = parseRequest(command);
  if (request === null) return { kind: "other", destructive: null };
  if (request.kind !== "rest") return { kind: "read", destructive: null };
  const segments = pathSegments(request.path);
  if (segments.some((segment) => segment === "." || segment === "..")) return { kind: "write", destructive: null };
  const { target, endpoint, rest } = routeOf(segments);
  const endpoints = endpoint === null ? [] : [endpoint];
  if (request.method === "GET" || request.method === "HEAD") return { kind: "read", destructive: null };
  if (isCursorRequest(target, endpoint, rest)) return { kind: "read", destructive: null };
  if (request.method === "POST" && endpoint !== null && READ_ENDPOINTS.has(endpoint)) {
    return { kind: "read", destructive: null };
  }
  if (request.method === "POST" && segments[0] === "_xpack" && segments[1] === "sql") {
    return { kind: "read", destructive: null };
  }
  if (request.method === "DELETE") {
    if (target !== null && endpoint === null && segments.length === 1) {
      return {
        kind: "ddl",
        destructive:
          target === ALL_INDICES
            ? "DELETE _all deletes every index and every document in them"
            : `DELETE ${target} deletes the index and every document in it`,
        confirmByName: true,
      };
    }
    if (endpoint !== null && DROPPING_ENDPOINTS.has(endpoint)) {
      return { kind: "ddl", destructive: `${request.method} ${request.path} deletes it for good`, confirmByName: true };
    }
    if (endpoint === "_doc" || endpoint === "_alias" || endpoint === "_aliases") {
      return { kind: endpoint === "_doc" ? "write" : "ddl", destructive: null };
    }
    if (endpoint !== null && DDL_ENDPOINTS.has(endpoint)) {
      return { kind: "ddl", destructive: `${request.method} ${request.path} deletes it for good` };
    }
    return { kind: "write", destructive: `${request.method} ${request.path} deletes it for good` };
  }
  if (endpoint === "_bulk" && BULK_DELETE.test(request.body)) {
    return { kind: "write", destructive: "_bulk with delete actions deletes those documents for good" };
  }
  if (endpoints.includes("_delete_by_query")) {
    const matchAll = request.body.trim() === "" || /"match_all"/.test(request.body);
    return {
      kind: "write",
      destructive: `_delete_by_query deletes every document of ${target ?? "the target"} the query matches`,
      ...(matchAll
        ? { costly: "_delete_by_query with match_all deletes the whole index, one document at a time" }
        : {}),
      confirmByName: matchAll,
    };
  }
  if (endpoints.includes("_update_by_query")) {
    return { kind: "write", destructive: null, costly: "_update_by_query rewrites every matching document" };
  }
  if (target !== null && segments.length === 1 && request.method === "PUT") return { kind: "ddl", destructive: null };
  if (endpoints.some((endpoint) => DDL_ENDPOINTS.has(endpoint))) return { kind: "ddl", destructive: null };
  return { kind: "write", destructive: null };
}
