import type { SearchTarget } from "@table-craft/desktop/engine/protocol.js";
import { familyBaseOf } from "@table-craft/desktop/renderer/model/indexTree.js";

/** A family entry is its base with this suffix, `orders-*`, as an index pattern reads. */
export const FAMILY_ENTRY_SUFFIX = "-*";

interface ShownIndicesSource {
  readonly shownIndices?: readonly string[] | undefined;
}

/** `orders-*`: what Manage Shown Indices saves for the family whose base is `orders`. */
export function familyEntry(base: string): string {
  return `${base}${FAMILY_ENTRY_SUFFIX}`;
}

function inFamily(entries: ReadonlySet<string>, name: string | null): boolean {
  if (name === null) return false;
  const base = familyBaseOf(name);
  return base !== null && entries.has(familyEntry(base));
}

/**
 * Whether Manage Shown Indices keeps a target (decision 117); null when it keeps them all. A target
 * stays when its name is listed, when it is a visible index of a listed family, so tomorrow's
 * rollover stays shown, or when it is a visible alias writing into a listed family, so the alias
 * clients write to follows its family. A listed alias never brings back its indices.
 */
export function shownIndexFilter(datasource: ShownIndicesSource): ((target: SearchTarget) => boolean) | null {
  if (datasource.shownIndices === undefined) return null;
  const entries: ReadonlySet<string> = new Set(datasource.shownIndices);
  return (target) => {
    if (entries.has(target.name)) return true;
    if (target.hidden) return false;
    if (target.kind === "index") return inFamily(entries, target.name);
    if (target.kind === "alias") return inFamily(entries, target.writeIndex);
    return false;
  };
}

/** One row of Manage Shown Indices: a family, or one index, alias or data stream. */
export interface ShownIndexEntry {
  /** What the list saves: `orders-*` for a family, the name for any other target. */
  readonly name: string;
  readonly kind: SearchTarget["kind"] | "family";
  /** How many indices a family holds; 0 for any other entry. */
  readonly members: number;
  readonly hidden: boolean;
  /** The aliases writing into a family, shown with it and not listed on their own. */
  readonly writeAliases: readonly string[];
}

const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/**
 * What Manage Shown Indices lists: a family for every visible suffixed index, even one alone, so
 * picking it keeps its next rollover, then every other target by name. An alias writing into a
 * family folds into the family's row.
 */
export function shownIndexEntries(targets: readonly SearchTarget[]): readonly ShownIndexEntry[] {
  const families = new Map<string, Set<string>>();
  for (const target of targets) {
    if (target.kind !== "index" || target.hidden) continue;
    const base = familyBaseOf(target.name);
    if (base === null) continue;
    const members = families.get(base);
    if (members === undefined) families.set(base, new Set([target.name]));
    else members.add(target.name);
  }
  const writers = new Map<string, string[]>();
  const rest: ShownIndexEntry[] = [];
  for (const target of targets) {
    if (target.kind === "index" && !target.hidden && familyBaseOf(target.name) !== null) continue;
    const base = target.kind === "alias" && !target.hidden ? familyOf(families, target.writeIndex) : null;
    if (base !== null) {
      const aliases = writers.get(base);
      if (aliases === undefined) writers.set(base, [target.name]);
      else aliases.push(target.name);
      continue;
    }
    rest.push({ name: target.name, kind: target.kind, members: 0, hidden: target.hidden, writeAliases: [] });
  }
  const familyEntries = [...families.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([base, members]): ShownIndexEntry => ({
      name: familyEntry(base),
      kind: "family",
      members: members.size,
      hidden: false,
      writeAliases: [...(writers.get(base) ?? [])].sort(byName),
    }));
  return [...familyEntries, ...rest.sort((a, b) => byName(a.name, b.name))];
}

function familyOf(families: ReadonlyMap<string, ReadonlySet<string>>, writeIndex: string | null): string | null {
  if (writeIndex === null) return null;
  const base = familyBaseOf(writeIndex);
  return base !== null && families.get(base)?.has(writeIndex) === true ? base : null;
}

/**
 * How many of the dialog's entries Manage Shown Indices keeps, for the datasource row's "N of M";
 * null when it keeps them all or nothing is listed yet. A family counts once with its write aliases,
 * and hidden targets count on neither side, as the tree's sections leave them folded.
 */
export function shownIndexCount(
  datasource: ShownIndicesSource,
  targets: readonly SearchTarget[] | null,
): { readonly shown: number; readonly total: number } | null {
  if (datasource.shownIndices === undefined || targets === null) return null;
  const saved = new Set(datasource.shownIndices);
  const entries = shownIndexEntries(targets).filter((entry) => !entry.hidden);
  return { shown: entries.filter((entry) => saved.has(entry.name)).length, total: entries.length };
}
