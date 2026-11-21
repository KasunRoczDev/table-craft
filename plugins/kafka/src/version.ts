/** One API a broker answers in ApiVersions, as the driver lists it. */
export interface BrokerApi {
  readonly apiKey: number;
  readonly name: string;
  readonly minVersion: number;
  readonly maxVersion: number;
}

/** The APIs browsing needs; a broker missing one cannot be used at all. */
export const REQUIRED_APIS = ["Metadata", "ApiVersions", "Fetch", "ListOffsets", "Produce"] as const;

/**
 * The first Kafka release to answer each marker, oldest first, from Kafka's own request schemas
 * (`clients/src/main/resources/common/message/*.json`): Fetch v11 came in 2.3, v12 in 2.7, v13 in
 * 3.1, v15 in 3.5, v16 in 3.7, v17 in 3.9 and v18 in 4.1; DescribeCluster in 2.8; and
 * ConsumerGroupHeartbeat v1 when KIP-848 went GA in 4.0. Measured against 2.8, 3.7 and 4.1.
 */
const RELEASE_MARKERS: readonly { readonly release: string; readonly api: string; readonly maxAtLeast: number }[] = [
  { release: "2.3", api: "Fetch", maxAtLeast: 11 },
  { release: "2.7", api: "Fetch", maxAtLeast: 12 },
  { release: "2.8", api: "DescribeCluster", maxAtLeast: 0 },
  { release: "3.1", api: "Fetch", maxAtLeast: 13 },
  { release: "3.5", api: "Fetch", maxAtLeast: 15 },
  { release: "3.7", api: "Fetch", maxAtLeast: 16 },
  { release: "3.9", api: "Fetch", maxAtLeast: 17 },
  { release: "4.0", api: "ConsumerGroupHeartbeat", maxAtLeast: 1 },
  { release: "4.1", api: "Fetch", maxAtLeast: 18 },
];

/** ZooKeeper-mode brokers list the controller-to-broker requests; KRaft brokers do not (KIP-500). */
const ZOOKEEPER_ONLY_API = "LeaderAndIsr";
/** Redpanda prefixes its cluster id with its own name. */
const REDPANDA_CLUSTER_PREFIX = "redpanda.";

export type ClusterMode = "KRaft" | "ZooKeeper" | "Redpanda";

function maxOf(apis: readonly BrokerApi[], name: string): number | null {
  return apis.find((api) => api.name === name)?.maxVersion ?? null;
}

/** The APIs of `REQUIRED_APIS` the broker does not answer. */
export function missingApis(apis: readonly BrokerApi[]): string[] {
  return REQUIRED_APIS.filter((name) => maxOf(apis, name) === null);
}

/**
 * The newest release whose markers the broker and every older marker match, such as `3.7`; null
 * below the oldest. Kafka reports no version string, so this is an estimate (decision 15).
 */
export function estimateRelease(apis: readonly BrokerApi[]): string | null {
  let release: string | null = null;
  for (const marker of RELEASE_MARKERS) {
    const max = maxOf(apis, marker.api);
    if (max === null || max < marker.maxAtLeast) break;
    release = marker.release;
  }
  return release;
}

/** `≥ 3.7`, or `version unknown` below the oldest marker; the host puts the product name in front. */
export function serverVersionOf(apis: readonly BrokerApi[]): string {
  const release = estimateRelease(apis);
  return release === null ? "version unknown" : `≥ ${release}`;
}

export function clusterModeOf(apis: readonly BrokerApi[], clusterId: string): ClusterMode {
  if (clusterId.startsWith(REDPANDA_CLUSTER_PREFIX)) return "Redpanda";
  return maxOf(apis, ZOOKEEPER_ONLY_API) === null ? "KRaft" : "ZooKeeper";
}
