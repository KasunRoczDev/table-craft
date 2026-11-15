import type { NamespaceCatalog, RelationKind } from "@table-craft/plugin-api";

export const CATALOG_SEARCH_SCOPES = ["tables", "columns", "all"] as const;
export type CatalogSearchScope = (typeof CATALOG_SEARCH_SCOPES)[number];

export const CATALOG_MATCHES = ["exact", "prefix", "word", "contains", "comment"] as const;
/** How a hit's name met the query, best first; `comment` only when the name did not. */
export type CatalogMatch = (typeof CATALOG_MATCHES)[number];

/** A table, view or column whose name or comment holds the query (plan 159). */
export interface CatalogSearchHit {
  readonly path: readonly string[];
  readonly relation: string;
  readonly kind: RelationKind;
  /** Absent for a table or view hit. */
  readonly column?: { readonly name: string; readonly type: string };
  readonly match: CatalogMatch;
}

const MATCH_RANKS: Readonly<Record<CatalogMatch, number>> = { exact: 0, prefix: 1, word: 2, contains: 3, comment: 4 };
// The palette's separators (renderer/model/fuzzy.ts), which core cannot import.
const WORD_SEPARATOR = /[\s._\-/:()[\]]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;

function startsWord(name: string, index: number): boolean {
  const previous = name.charAt(index - 1);
  if (WORD_SEPARATOR.test(previous)) return true;
  return LOWER.test(previous) && UPPER.test(name.charAt(index));
}

function nameMatch(name: string, needle: string): CatalogMatch | null {
  const haystack = name.toLowerCase();
  if (haystack === needle) return "exact";
  if (haystack.startsWith(needle)) return "prefix";
  let found: CatalogMatch | null = null;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + 1)) {
    if (startsWord(name, index)) return "word";
    found = "contains";
  }
  return found;
}

function matchOf(name: string, comment: string | null, needle: string): CatalogMatch | null {
  const byName = nameMatch(name, needle);
  if (byName !== null) return byName;
  return comment !== null && comment.toLowerCase().includes(needle) ? "comment" : null;
}

/**
 * Hits of `query` in `catalogs`, case-insensitive, best match first. Within a match tables and views
 * come before columns, and otherwise the order of `catalogs` and of what the plugin returned holds.
 */
export function searchCatalog(
  catalogs: readonly NamespaceCatalog[],
  query: string,
  scope: CatalogSearchScope,
): CatalogSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const hits: CatalogSearchHit[] = [];
  for (const catalog of catalogs) {
    for (const relation of catalog.relations) {
      const base = { path: catalog.path, relation: relation.name, kind: relation.kind };
      if (scope !== "columns") {
        const match = matchOf(relation.name, relation.comment, needle);
        if (match !== null) hits.push({ ...base, match });
      }
      if (scope === "tables") continue;
      for (const column of relation.columns) {
        const match = matchOf(column.name, column.comment, needle);
        if (match !== null) hits.push({ ...base, column: { name: column.name, type: column.type }, match });
      }
    }
  }
  const order = (hit: CatalogSearchHit) => MATCH_RANKS[hit.match] * 2 + (hit.column === undefined ? 0 : 1);
  return hits.sort((left, right) => order(left) - order(right));
}
