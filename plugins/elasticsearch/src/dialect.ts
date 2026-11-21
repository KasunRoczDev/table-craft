import { PluginError } from "@table-craft/plugin-api";

export const BRAND_ELASTICSEARCH = "elasticsearch";
export const BRAND_OPENSEARCH = "opensearch";

export type Distribution = typeof BRAND_ELASTICSEARCH | typeof BRAND_OPENSEARCH;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * What one server speaks, from the version it reports (decision 173). Every request a feature
 * needs is chosen here, so the rest of the plugin never compares versions itself.
 */
export interface Dialect {
  readonly distribution: Distribution;
  readonly version: Version;
  readonly versionText: string;
  /** 6.x keeps one mapping type per index under `mappings.<type>`. */
  readonly mappingTypes: boolean;
  /** `date_histogram` takes `fixed_interval` (Elasticsearch 7.2+, OpenSearch); before it, `interval`. */
  readonly fixedInterval: boolean;
  /** Data streams are listed (Elasticsearch 7.9+, OpenSearch 1.0+). */
  readonly dataStreams: boolean;
  /**
   * The SQL endpoint with the query string that makes it answer columns and rows, or null when
   * this server has none we know. OpenSearch answers `format=json` with a raw search response, so
   * it keeps its default, `jdbc`.
   */
  readonly sqlPath: string | null;
  /** PPL (`source=…`), OpenSearch only. */
  readonly pplPath: string | null;
  /** `expand_wildcards` on `_cat/indices` and `_cat/aliases` (Elasticsearch 7.7+), which 6.x rejects. */
  readonly catExpandWildcards: boolean;
  /** `track_total_hits` takes a number (Elasticsearch 7.0+, OpenSearch); 6.x counts every hit anyway. */
  readonly trackTotalHitsUpTo: boolean;
  /** How pages past the first are read in one point in time; null pages by scroll. */
  readonly pointInTime: PointInTime | null;
}

/** One sort field after the user's, and a value that sorts before any it holds. */
export interface Tiebreaker {
  readonly field: string;
  readonly first: string | number;
}

/** Point in time paging: Elasticsearch 7.10+ and OpenSearch 2.4+ name it differently. */
export interface PointInTime {
  /** What follows `/<target>/` to open one. */
  readonly open: string;
  /** The path that frees them. */
  readonly close: string;
  /** OpenSearch frees a list under `pit_id`; Elasticsearch one `id` per request. */
  readonly closesMany: boolean;
  /** Sort fields that order every hit exactly once, so `search_after` neither repeats nor skips one. */
  readonly tiebreakers: readonly Tiebreaker[];
}

/** Elasticsearch 7.12+: `_shard_doc`, which every hit of a point in time has and which costs nothing. */
const SHARD_DOC: readonly Tiebreaker[] = [{ field: "_shard_doc", first: -1 }];
/**
 * Without `_shard_doc` (OpenSearch, Elasticsearch 7.10 and 7.11) only `_index` and `_id` tell every
 * hit apart: `_doc` repeats across shards, so paging by it skips hits.
 */
const INDEX_AND_ID: readonly Tiebreaker[] = [
  { field: "_index", first: "" },
  { field: "_id", first: "" },
];

function pointInTimeOf(opensearch: boolean, version: Version): PointInTime | null {
  if (opensearch) {
    if (!atLeast(version, 2, 4)) return null;
    return {
      open: "_search/point_in_time",
      close: "/_search/point_in_time",
      closesMany: true,
      tiebreakers: INDEX_AND_ID,
    };
  }
  if (!atLeast(version, 7, 10)) return null;
  return {
    open: "_pit",
    close: "/_pit",
    closesMany: false,
    tiebreakers: atLeast(version, 7, 12) ? SHARD_DOC : INDEX_AND_ID,
  };
}

const MIN_MAJOR = 6;
const VERSION = /^(\d+)\.(\d+)(?:\.(\d+))?/;

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * The distribution a bare version number stands for, when the server says no more: OpenSearch
 * counts from 1.0 and Elasticsearch below 6.0 is refused anyway, so the two never share a major
 * TableCraft speaks.
 */
export function distributionOfVersion(version: Version): Distribution {
  return version.major < MIN_MAJOR ? BRAND_OPENSEARCH : BRAND_ELASTICSEARCH;
}

function atLeast(version: Version, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor);
}

/** The dialect of `versionText` on `distribution`; rejects a server older than 6.0. */
export function dialectOf(distribution: Distribution, versionText: string): Dialect {
  const version = parseVersion(versionText);
  if (version === null) {
    throw new PluginError(
      "connectionFailed",
      `The server reported version "${versionText}", which TableCraft cannot read.`,
    );
  }
  const opensearch = distribution === BRAND_OPENSEARCH;
  if (!opensearch && version.major < MIN_MAJOR) {
    throw new PluginError(
      "connectionFailed",
      `Elasticsearch ${versionText} is older than 6.0, the oldest version TableCraft speaks.`,
    );
  }
  return {
    distribution,
    version,
    versionText,
    mappingTypes: !opensearch && version.major < 7,
    fixedInterval: opensearch || atLeast(version, 7, 2),
    dataStreams: opensearch || atLeast(version, 7, 9),
    sqlPath: opensearch ? "/_plugins/_sql" : version.major >= 7 ? "/_sql?format=json" : "/_xpack/sql?format=json",
    pplPath: opensearch ? "/_plugins/_ppl" : null,
    catExpandWildcards: opensearch || atLeast(version, 7, 7),
    trackTotalHitsUpTo: opensearch || version.major >= 7,
    pointInTime: pointInTimeOf(opensearch, version),
  };
}

/** How long a point in time or a scroll is kept between two pages. */
export const CURSOR_KEEP_ALIVE = "5m";

/** What `GET /` answers. */
export interface RootInfo {
  readonly name?: unknown;
  readonly cluster_name?: unknown;
  readonly version?: { readonly number?: unknown; readonly distribution?: unknown; readonly build_flavor?: unknown };
  readonly tagline?: unknown;
}

/** The distribution and version `GET /` reports. */
export function rootVersion(root: RootInfo): { distribution: Distribution; version: string } | null {
  const number = root.version?.number;
  if (typeof number !== "string") return null;
  const distribution = root.version?.distribution === BRAND_OPENSEARCH ? BRAND_OPENSEARCH : BRAND_ELASTICSEARCH;
  return { distribution, version: number };
}

/** The product name a status bar shows: `Elasticsearch` or `OpenSearch`. */
export function productName(distribution: Distribution): string {
  return distribution === BRAND_OPENSEARCH ? "OpenSearch" : "Elasticsearch";
}
