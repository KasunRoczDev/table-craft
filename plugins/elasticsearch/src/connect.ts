import { isPluginError, PluginError, type ConnectOptions } from "@table-craft/plugin-api";
import { ElasticClient, isForbidden } from "./client.js";
import { authorization, baseUrl, type ElasticConfig } from "./config.js";
import {
  BRAND_ELASTICSEARCH,
  BRAND_OPENSEARCH,
  dialectOf,
  rootVersion,
  type Dialect,
  type RootInfo,
} from "./dialect.js";
import { tlsFailure, tlsOptions } from "./tls.js";

const MS_PER_SECOND = 1000;
const MAX_CAUSE_DEPTH = 6;

export interface Connection {
  readonly client: ElasticClient;
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

/**
 * The distribution and version, from `GET /` and, where a user may not read it, from the local
 * node's info: a least-privileged log reader often may read only its indices (plan 165).
 */
async function probe(client: ElasticClient): Promise<{ dialect: Dialect; clusterName: string | null }> {
  try {
    const root = await client.json<RootInfo>("GET", "/");
    const found = rootVersion(root);
    if (found !== null) {
      return {
        dialect: dialectOf(found.distribution, found.version),
        clusterName: typeof root.cluster_name === "string" ? root.cluster_name : null,
      };
    }
  } catch (error) {
    if (!isForbidden(error)) throw error;
  }
  const nodes = await client.json<NodesVersion>("GET", "/_nodes/_local/version");
  const node = Object.values(nodes.nodes ?? {})[0];
  if (typeof node?.version !== "string") {
    throw new PluginError(
      "connectionFailed",
      "The server did not say its version. Is this an Elasticsearch or OpenSearch endpoint?",
    );
  }
  const distribution = node.distribution === BRAND_OPENSEARCH ? BRAND_OPENSEARCH : BRAND_ELASTICSEARCH;
  return {
    dialect: dialectOf(distribution, node.version),
    clusterName: typeof nodes.cluster_name === "string" ? nodes.cluster_name : null,
  };
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
    return { client, dialect, clusterName };
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
