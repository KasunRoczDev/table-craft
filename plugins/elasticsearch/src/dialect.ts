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
}

const MIN_MAJOR = 6;
const VERSION = /^(\d+)\.(\d+)(?:\.(\d+))?/;

export function parseVersion(text: string): Version | null {
  const match = VERSION.exec(text.trim());
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) };
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
  };
}

/** How long a scroll is kept between two pages. */
export const SCROLL_KEEP_ALIVE = "5m";

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
