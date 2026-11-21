import type { SearchTarget } from "@table-craft/plugin-api";
import { isForbidden, type ElasticClient } from "./client.js";
import type { Dialect } from "./dialect.js";
import { nameMatcher } from "./glob.js";

interface CatIndex {
  readonly index?: unknown;
  readonly health?: unknown;
  readonly status?: unknown;
  readonly "docs.count"?: unknown;
  readonly "store.size"?: unknown;
}

interface CatAlias {
  readonly alias?: unknown;
  readonly index?: unknown;
  readonly is_write_index?: unknown;
}

interface DataStreamList {
  readonly data_streams?: readonly {
    readonly name?: unknown;
    readonly indices?: readonly { readonly index_name?: unknown }[];
    readonly hidden?: unknown;
    readonly status?: unknown;
  }[];
}

const SYSTEM_PREFIX = ".";
const CAT_INDICES = "/_cat/indices?format=json&bytes=b&h=index,health,status,docs.count,store.size";
const CAT_ALIASES = "/_cat/aliases?format=json&h=alias,index,is_write_index";
const ALL_WILDCARDS = "&expand_wildcards=all";
const DATA_STREAMS = "/_data_stream?expand_wildcards=all";

function text(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every index, alias and data stream, from three listings at most (plan 165): a cluster of
 * thousands of indices answers them in one round trip each, where a describe per index would not.
 * A listing the user may not read is left out, not failed.
 */
export async function listTargets(
  client: ElasticClient,
  dialect: Dialect,
  filter: string,
  signal?: AbortSignal,
): Promise<SearchTarget[]> {
  const wildcards = dialect.catExpandWildcards ? ALL_WILDCARDS : "";
  const [indices, aliases, streams] = await Promise.all([
    client.json<CatIndex[]>("GET", `${CAT_INDICES}${wildcards}`, { signal }),
    client.json<CatAlias[]>("GET", `${CAT_ALIASES}${wildcards}`, { signal }).catch((error: unknown) => {
      if (isForbidden(error)) return [];
      throw error;
    }),
    dialect.dataStreams
      ? client.json<DataStreamList>("GET", DATA_STREAMS, { signal }).catch(() => ({ data_streams: [] }))
      : Promise.resolve({ data_streams: [] }),
  ]);
  const matches = nameMatcher(filter);
  const targets: SearchTarget[] = [];
  for (const row of indices) {
    const name = text(row.index);
    if (name === null) continue;
    targets.push({
      name,
      kind: "index",
      hidden: name.startsWith(SYSTEM_PREFIX),
      health: text(row.health),
      status: text(row.status),
      docs: text(row["docs.count"]),
      bytes: text(row["store.size"]),
      indices: [],
      writeIndex: null,
    });
  }
  const byAlias = new Map<string, { indices: string[]; writeIndex: string | null }>();
  for (const row of aliases) {
    const alias = text(row.alias);
    const index = text(row.index);
    if (alias === null || index === null) continue;
    const entry = byAlias.get(alias) ?? { indices: [], writeIndex: null };
    entry.indices.push(index);
    if (row.is_write_index === "true") entry.writeIndex = index;
    byAlias.set(alias, entry);
  }
  for (const [name, entry] of byAlias) {
    const indicesSorted = [...entry.indices].sort(compareNames);
    targets.push({
      name,
      kind: "alias",
      hidden: name.startsWith(SYSTEM_PREFIX),
      health: null,
      status: null,
      docs: null,
      bytes: null,
      indices: indicesSorted,
      // One index behind an alias is where it writes, whether marked or not.
      writeIndex: entry.writeIndex ?? (indicesSorted.length === 1 ? (indicesSorted[0] ?? null) : null),
    });
  }
  for (const stream of streams.data_streams ?? []) {
    const name = text(stream.name);
    if (name === null) continue;
    const backing = (stream.indices ?? []).map((index) => text(index.index_name)).filter((index) => index !== null);
    targets.push({
      name,
      kind: "dataStream",
      hidden: stream.hidden === true || name.startsWith(SYSTEM_PREFIX),
      health: text(stream.status)?.toLowerCase() ?? null,
      status: null,
      docs: null,
      bytes: null,
      indices: backing,
      writeIndex: backing.at(-1) ?? null,
    });
  }
  return targets.filter((target) => matches(target.name)).sort((a, b) => compareNames(a.name, b.name));
}
