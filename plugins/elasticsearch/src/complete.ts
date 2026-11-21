import type { CompletionItem, CompletionRequest, CompletionResult, Session } from "@table-craft/plugin-api";
import { HTTP_METHODS } from "./client.js";

/** Endpoints offered after a method, the ones a console session reaches for most. */
export const ENDPOINTS: readonly (readonly [string, string])[] = [
  ["_search", "Search documents"],
  ["_count", "Count documents"],
  ["_mapping", "Field mapping"],
  ["_settings", "Index settings"],
  ["_doc/", "One document by id"],
  ["_analyze", "Analyze text"],
  ["_cat/indices", "Indices, docs and size"],
  ["_cat/aliases", "Aliases"],
  ["_cat/nodes", "Nodes"],
  ["_cat/shards", "Shards"],
  ["_cat/health", "Cluster health, one line"],
  ["_cluster/health", "Cluster health"],
  ["_cluster/settings", "Cluster settings"],
  ["_nodes/stats", "Node statistics"],
  ["_aliases", "Change aliases"],
  ["_bulk", "Bulk index, update and delete"],
  ["_msearch", "Several searches"],
  ["_mget", "Several documents by id"],
  ["_update_by_query", "Update matching documents"],
  ["_delete_by_query", "Delete matching documents"],
  ["_reindex", "Copy documents to another index"],
  ["_refresh", "Make recent writes searchable"],
  ["_field_caps?fields=*", "Field capabilities"],
  ["_validate/query?explain", "Check a query"],
  ["_tasks", "Running tasks"],
];

/** Query DSL and search body keys offered inside a JSON body. */
export const BODY_KEYS: readonly string[] = [
  "query",
  "size",
  "from",
  "sort",
  "_source",
  "aggs",
  "track_total_hits",
  "search_after",
  "highlight",
  "bool",
  "must",
  "filter",
  "should",
  "must_not",
  "minimum_should_match",
  "match",
  "match_phrase",
  "multi_match",
  "term",
  "terms",
  "range",
  "exists",
  "prefix",
  "wildcard",
  "query_string",
  "simple_query_string",
  "nested",
  "match_all",
  "ids",
  "terms_set",
  "date_histogram",
  "histogram",
  "avg",
  "sum",
  "min",
  "max",
  "cardinality",
  "value_count",
  "top_hits",
  "fixed_interval",
  "field",
  "order",
  "gte",
  "lte",
  "gt",
  "lt",
];

const METHOD_BOOST = 2;
const INDEX_BOOST = 5;
const REQUEST_START = new RegExp(`^(${HTTP_METHODS.join("|")})\\s+(\\S*)$`, "i");
const WORD_BEFORE = /[\w.@-]*$/;
const KEY_BEFORE = /"([\w.@-]*)$/;
const PATH_PART = /[^/\s]*$/;

/** Index, alias and data stream names a session looks up for completion. */
export interface IndexSuggester {
  suggestIndices(prefix: string): Promise<readonly string[]>;
}

function suggesterOf(session: Session | null): IndexSuggester | null {
  if (session === null || !("suggestIndices" in session)) return null;
  return typeof session.suggestIndices === "function" ? (session as unknown as IndexSuggester) : null;
}

function item(label: string, detail: string | null, boost = 0, apply = label): CompletionItem {
  return { label, kind: "keyword", detail, apply, boost, info: null, caret: null };
}

/** What fits at the caret: a method, an endpoint or index in the path, or a key of the body. */
export async function complete(request: CompletionRequest, session: Session | null): Promise<CompletionResult> {
  const lineStart = request.text.lastIndexOf("\n", request.offset - 1) + 1;
  const line = request.text.slice(lineStart, request.offset);
  const pathMatch = REQUEST_START.exec(line);
  if (pathMatch !== null) {
    const path = pathMatch[2] ?? "";
    const part = PATH_PART.exec(path)?.[0] ?? "";
    const from = request.offset - part.length;
    const items: CompletionItem[] = [];
    const atRoot =
      !path
        .slice(0, path.length - part.length)
        .replace(/^\//, "")
        .includes("/") && !path.startsWith("_");
    if (part.startsWith("_") || !atRoot || part === "") {
      for (const [endpoint, detail] of ENDPOINTS) items.push(item(endpoint, detail));
    }
    if (atRoot && !part.startsWith("_")) {
      const suggester = suggesterOf(session);
      const names = suggester === null ? [] : await suggester.suggestIndices(part.replace(/^\//, "")).catch(() => []);
      for (const name of names) items.push(item(name, "index", INDEX_BOOST));
    }
    return { from, to: request.offset, items, validFor: "^[\\w.*-]*$" };
  }
  const word = WORD_BEFORE.exec(line)?.[0] ?? "";
  if (line.trim() === word) {
    return {
      from: request.offset - word.length,
      to: request.offset,
      items: HTTP_METHODS.map((method) => item(method, "request", METHOD_BOOST, `${method} `)),
      validFor: "^\\w*$",
    };
  }
  const key = KEY_BEFORE.exec(line);
  if (key !== null) {
    const typed = key[1] ?? "";
    return {
      from: request.offset - typed.length,
      to: request.offset,
      items: BODY_KEYS.map((name) => item(name, "body")),
      validFor: "^[\\w.@-]*$",
    };
  }
  return { from: request.offset, to: request.offset, items: [], validFor: null };
}
