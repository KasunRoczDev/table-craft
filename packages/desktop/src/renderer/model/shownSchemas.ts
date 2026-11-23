import type { Namespace } from "@table-craft/desktop/engine/protocol.js";

interface Named {
  readonly name: string;
  /** Other names the item answers to, as a family's write alias finds the family's row. */
  readonly searchAlso?: readonly string[] | undefined;
}

/** The items whose name, or one of their other names, holds `query`, ignoring case; all of them for a blank query. */
export function matchingNamespaces<T extends Named>(namespaces: readonly T[], query: string): readonly T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return namespaces;
  const holds = (name: string) => name.toLowerCase().includes(needle);
  return namespaces.filter((namespace) => holds(namespace.name) || namespace.searchAlso?.some(holds) === true);
}

/** Where `name` holds `query`, ignoring case, as the indexes speed search marks; none for a blank query or no match. */
export function matchPositions(name: string, query: string): readonly number[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const at = name.toLowerCase().indexOf(needle);
  if (at === -1) return [];
  return Array.from({ length: needle.length }, (_, offset) => at + offset);
}

/** What the namespaces are called: "databases" when every one is a database, else "schemas". */
export function namespaceNoun(namespaces: readonly Namespace[]): "databases" | "schemas" {
  return namespaces.length > 0 && namespaces.every((namespace) => namespace.kind === "database")
    ? "databases"
    : "schemas";
}

/** `selected` with every one of `names` added (`on`) or removed; names it holds that are not listed stay. */
export function withNames(selected: ReadonlySet<string>, names: readonly string[], on: boolean): ReadonlySet<string> {
  const next = new Set(selected);
  for (const name of names) {
    if (on) next.add(name);
    else next.delete(name);
  }
  return next;
}

/** How many of the listed items `selected` keeps; null keeps them all. */
export function selectedCount(namespaces: readonly Named[], selected: ReadonlySet<string> | null): number {
  if (selected === null) return namespaces.length;
  return namespaces.filter((namespace) => selected.has(namespace.name)).length;
}
