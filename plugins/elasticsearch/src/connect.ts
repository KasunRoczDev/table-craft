import { isPluginError, PluginError, type ConnectOptions } from "@table-craft/plugin-api";
import { ElasticClient, isTimedOut, requestJson, statusOf, type ElasticTransport } from "./client.js";
import { authorization, baseUrl, type ElasticConfig } from "./config.js";
import {
  BRAND_ELASTICSEARCH,
  BRAND_OPENSEARCH,
  compareVersions,
  dialectOf,
  distributionOfVersion,
  parseVersion,
  rootVersion,
  type Dialect,
  type RootInfo,
  type Version,
} from "./dialect.js";
import { tlsFailure, tlsOptions } from "./tls.js";

const MS_PER_SECOND = 1000;
const MAX_CAUSE_DEPTH = 6;
const ROOT = "/";
const NODES_VERSION = "/_nodes/_local/version";
const CAT_NODES_VERSION = "/_cat/nodes?h=version&format=json";
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
/** What a least-privileged user or a gateway answers one probe with, while the next may still pass. */
const PROBE_FALLBACK_STATUSES: ReadonlySet<number> = new Set([HTTP_FORBIDDEN, HTTP_BAD_GATEWAY, HTTP_UNAVAILABLE]);

export interface Connection {
  readonly transport: ElasticTransport;
  readonly dialect: Dialect;
  readonly clusterName: string | null;
}

interface NodesVersion {
  readonly nodes?: Record<
    string,
    { readonly version?: unknown; readonly distribution?: unknown; readonly build_flavor?: unknown }
  >;
  readonly cluster_name?: unknown;
}

export interface Probed {
  readonly dialect: Dialect;
  readonly clusterName: string | null;
}

async function fromRoot(transport: ElasticTransport): Promise<Probed | null> {
  const root = await requestJson<RootInfo>(transport, "GET", ROOT);
  const found = rootVersion(root);
  if (found === null) return null;
  return {
    dialect: dialectOf(found.distribution, found.version),
    clusterName: typeof root.cluster_name === "string" ? root.cluster_name : null,
  };
}

async function fromLocalNode(transport: ElasticTransport): Promise<Probed | null> {
  const nodes = await requestJson<NodesVersion>(transport, "GET", NODES_VERSION);
  const node = Object.values(nodes.nodes ?? {})[0];
  if (typeof node?.version !== "string") return null;
  const distribution = node.distribution === BRAND_OPENSEARCH ? BRAND_OPENSEARCH : BRAND_ELASTICSEARCH;
  return {
    dialect: dialectOf(distribution, node.version),
    clusterName: typeof nodes.cluster_name === "string" ? nodes.cluster_name : null,
  };
}

/** `_cat/nodes` names no distribution, so the oldest node's version stands for it (`distributionOfVersion`). */
async function fromCatNodes(transport: ElasticTransport): Promise<Probed | null> {
  const rows = await requestJson<readonly { readonly version?: unknown }[]>(transport, "GET", CAT_NODES_VERSION);
  let oldest: { text: string; version: Version } | null = null;
  for (const row of rows) {
    if (typeof row.version !== "string") continue;
    const version = parseVersion(row.version);
    if (version !== null && (oldest === null || compareVersions(version, oldest.version) < 0)) {
      oldest = { text: row.version, version };
    }
  }
  if (oldest === null) return null;
  return { dialect: dialectOf(distributionOfVersion(oldest.version), oldest.text), clusterName: null };
}

const PROBES: readonly ((transport: ElasticTransport) => Promise<Probed | null>)[] = [
  fromRoot,
  fromLocalNode,
  fromCatNodes,
];

function fallsBack(error: unknown): boolean {
  return isTimedOut(error) || PROBE_FALLBACK_STATUSES.has(statusOf(error) ?? 0);
}

/**
 * The distribution and version: from `GET /`, then from the local node's info, then from
 * `_cat/nodes`. A least-privileged log reader may often read only its indices (plan 165), and a
 * gateway may refuse or time out on `GET /` while it passes the others. A probe moves on only after
 * a refusal, a gateway error or a timeout; when every probe fails, the first failure is the one said.
 */
export async function probe(transport: ElasticTransport): Promise<Probed> {
  let first: { error: unknown } | null = null;
  for (const step of PROBES) {
    try {
      const found = await step(transport);
      if (found !== null) return found;
    } catch (error) {
      if (!fallsBack(error)) throw error;
      first ??= { error };
    }
  }
  if (first !== null) throw first.error;
  throw new PluginError(
    "connectionFailed",
    "The server did not say its version. Is this an Elasticsearch or OpenSearch endpoint?",
  );
}

function causes(error: unknown, depth = 0): unknown[] {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== "object" || error === null) return [];
  return [error, ...causes((error as { cause?: unknown }).cause, depth + 1)];
}

/** Opens the client and reads what the server speaks; a failure is worded for the form. */
export async function openConnection(config: ElasticConfig, options: ConnectOptions): Promise<Connection> {
  const tls = await tlsOptions(config, options.serverName);
  const client = new ElasticClient({
    baseUrl: baseUrl(config),
    authorization: authorization(config),
    tls,
    requestTimeoutMs: config.requestTimeout * MS_PER_SECOND,
    connectTimeoutMs: config.connectTimeout * MS_PER_SECOND,
    ...(options.keepAliveInitialDelayMs === undefined
      ? {}
      : { keepAliveInitialDelayMs: options.keepAliveInitialDelayMs }),
  });
  try {
    const { dialect, clusterName } = await probe(client);
    return { transport: client, dialect, clusterName };
  } catch (cause) {
    client.close();
    for (const inner of causes(cause)) {
      const failure = tlsFailure(config, options.serverName ?? config.host, inner);
      if (failure !== null) throw failure;
    }
    if (isPluginError(cause)) {
      if (cause.code === "connectionLost") throw new PluginError("connectionFailed", cause.message, { cause });
      if (cause.code === "statementFailed") throw new PluginError("connectionFailed", cause.message, { cause });
      throw cause;
    }
    throw new PluginError("connectionFailed", cause instanceof Error ? cause.message : String(cause), { cause });
  }
}
