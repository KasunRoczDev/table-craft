import {
  Admin,
  ConfigResourceTypes,
  ConfigSources,
  kGetApi,
  kGetBootstrapConnection,
  kGetConnection,
  ListOffsetTimestamps,
  type API,
  type Broker,
  type ClusterMetadata,
  type ClusterTopicMetadata,
  type ConfigDescription,
  type Connection as BrokerConnection,
} from "@platformatic/kafka";
import type { ConfigEntry } from "@table-craft/plugin-api";
import type { Connection } from "./connect.js";
import { failures, kafkaErrorId, refused, statementFailure } from "./failures.js";

type DescribeConfigsResponseConfig = ConfigDescription["configs"][number];

/** Kafka's own prefix for the topics it manages, such as `__consumer_offsets`. */
const INTERNAL_PREFIX = "__";
const SOURCE_NAMES = new Map<number, string>(
  Object.entries(ConfigSources)
    .filter(([name]) => name !== "TOPIC_CONFIG")
    .map(([name, code]) => [code, name]),
);
const DEFAULT_SOURCE = ConfigSources.DEFAULT_CONFIG;
const STATIC_SOURCE = ConfigSources.STATIC_BROKER_CONFIG;

const UNKNOWN_TOPIC = "UNKNOWN_TOPIC_OR_PARTITION";
/** ListOffsets fields a client sends: not a replica, uncommitted reads, no known leader epoch. */
const NO_REPLICA = -1;
const READ_UNCOMMITTED = 0;
const NO_LEADER_EPOCH = -1;

interface RawListOffsets {
  readonly topics: readonly {
    readonly name: string;
    readonly partitions: readonly { readonly partitionIndex: number; readonly offset: bigint }[];
  }[];
}

/** Fetch v13 (Kafka 3.1) named topics by id; older versions by name. */
const FETCH_BY_ID_VERSION = 13;

interface RawMetadataTopic {
  readonly errorCode: number;
  readonly name: string | null | undefined;
  readonly topicId: string;
  readonly partitions: readonly {
    readonly partitionIndex: number;
    readonly leaderId: number;
    readonly leaderEpoch: number;
    readonly replicaNodes: number[];
    readonly isrNodes: number[];
    readonly offlineReplicas: number[];
  }[];
}

function noTopic(name: string): Error {
  return refused(`There is no topic ${name}; refresh the topic list to see what the cluster holds.`);
}

export type ConfigResource = "topic" | "broker";

export interface Watermarks {
  readonly low: bigint;
  readonly high: bigint;
}

export function isInternalTopic(name: string): boolean {
  return name.startsWith(INTERNAL_PREFIX);
}

function configEntry(config: DescribeConfigsResponseConfig): ConfigEntry {
  return {
    name: config.name,
    value: config.isSensitive ? null : (config.value ?? null),
    source: SOURCE_NAMES.get(config.configSource) ?? "UNKNOWN",
    isDefault: config.configSource === DEFAULT_SOURCE || config.configSource === STATIC_SOURCE,
    sensitive: config.isSensitive,
    readOnly: config.readOnly,
    documentation: config.documentation ?? null,
  };
}

function promised<T>(start: (callback: (error: Error | null, value?: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    start((error, value) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve(value as T);
    });
  });
}

/**
 * The session's admin requests. Reads go through the connection's client, which retries a moved
 * leader; writes go through a second client without retries, since a write that timed out may
 * have happened (decision 139).
 */
export class KafkaAdmin {
  readonly #connection: Connection;
  #writer: Admin | null = null;

  constructor(connection: Connection) {
    this.#connection = connection;
  }

  get reader(): Admin {
    return this.#connection.admin;
  }

  get writer(): Admin {
    this.#writer ??= new Admin({ ...this.#connection.options, retries: 0 });
    return this.#writer;
  }

  metadata(topics: readonly string[]): Promise<ClusterMetadata> {
    return failures(() => this.reader.metadata({ topics: [...topics], forceUpdate: true }));
  }

  async topic(name: string): Promise<ClusterTopicMetadata> {
    let metadata: ClusterMetadata;
    try {
      metadata = await this.reader.metadata({ topics: [name], forceUpdate: true });
    } catch (cause) {
      if (kafkaErrorId(cause) === UNKNOWN_TOPIC) throw noTopic(name);
      throw statementFailure(cause);
    }
    const topic = metadata.topics.get(name) ?? (await this.#rawTopic(name));
    if (topic === undefined) throw noTopic(name);
    return topic;
  }

  /**
   * A topic's metadata asked of a broker by hand: the driver's metadata cache drops internal
   * topics such as `__consumer_offsets`, which Show System still lists and opens.
   */
  async #rawTopic(name: string): Promise<ClusterTopicMetadata | undefined> {
    const reader = this.reader;
    const answer = await failures(async () => {
      const connection = await promised<BrokerConnection>((callback) => {
        reader[kGetBootstrapConnection](callback);
      });
      const api = await promised<API<unknown[], { topics: RawMetadataTopic[] }>>((callback) => {
        reader[kGetApi]("Metadata", callback);
      });
      return api.async(connection, [name], false, false);
    });
    const topic = answer.topics.find((candidate) => candidate.name === name && candidate.errorCode === 0);
    if (topic === undefined) return undefined;
    const partitions = [...topic.partitions]
      .sort((a, b) => a.partitionIndex - b.partitionIndex)
      .map((partition) => ({
        leader: partition.leaderId,
        leaderEpoch: partition.leaderEpoch,
        replicas: partition.replicaNodes,
        isr: partition.isrNodes,
        offlineReplicas: partition.offlineReplicas,
      }));
    return { id: topic.topicId, partitions, partitionsCount: partitions.length, lastUpdate: Date.now() };
  }

  /**
   * What a Fetch names `topic` by when the fetching consumer does not know it (an internal topic):
   * the consumer passes an unknown id through, so brokers before Fetch v13 get the name.
   */
  async fetchTopic(name: string): Promise<{ readonly id: string; readonly topic: ClusterTopicMetadata }> {
    const topic = await this.topic(name);
    const fetch = this.#connection.apis.find((api) => api.name === "Fetch");
    const byId = fetch !== undefined && fetch.maxVersion >= FETCH_BY_ID_VERSION;
    return { id: byId ? topic.id : name, topic };
  }

  topicNames(internal: boolean): Promise<string[]> {
    return failures(() => this.reader.listTopics({ includeInternals: internal }));
  }

  /** The offset of each partition at `timestamp` (or `ListOffsetTimestamps`); -1 where none is at or after it. */
  async offsetsAt(
    requests: ReadonlyMap<string, readonly number[]>,
    timestamp: bigint,
  ): Promise<Map<string, Map<number, bigint>>> {
    const result = new Map<string, Map<number, bigint>>();
    if (requests.size === 0) return result;
    const wanted = [...requests.entries()].filter(([, partitions]) => partitions.length > 0);
    const internal = wanted.filter(([name]) => isInternalTopic(name));
    const topics = wanted
      .filter(([name]) => !isInternalTopic(name))
      .map(([name, partitions]) => ({
        name,
        partitions: partitions.map((partitionIndex) => ({ partitionIndex, timestamp })),
      }));
    const [listed, raw] = await Promise.all([
      topics.length === 0 ? Promise.resolve([]) : failures(() => this.reader.listOffsets({ topics })),
      Promise.all(
        internal.map(
          async ([name, partitions]) => [name, await this.#rawOffsets(name, partitions, timestamp)] as const,
        ),
      ),
    ]);
    for (const topic of listed) {
      const partitions = result.get(topic.name) ?? new Map<number, bigint>();
      for (const partition of topic.partitions) partitions.set(partition.partitionIndex, partition.offset);
      result.set(topic.name, partitions);
    }
    for (const [name, partitions] of raw) result.set(name, partitions);
    return result;
  }

  /**
   * ListOffsets sent to each leader by hand: the driver's `listOffsets` looks the topic up in its
   * metadata cache, which drops internal topics, and then throws outside its promise.
   */
  async #rawOffsets(name: string, partitions: readonly number[], timestamp: bigint): Promise<Map<number, bigint>> {
    const [topic, metadata] = await Promise.all([this.topic(name), this.metadata([])]);
    const byLeader = new Map<number, number[]>();
    for (const partition of partitions) {
      const leader = topic.partitions[partition]?.leader;
      if (leader === undefined || leader < 0) continue;
      byLeader.set(leader, [...(byLeader.get(leader) ?? []), partition]);
    }
    const reader = this.reader;
    const result = new Map<number, bigint>();
    await failures(() =>
      Promise.all(
        [...byLeader.entries()].map(async ([leader, indexes]) => {
          const broker = metadata.brokers.get(leader);
          if (broker === undefined) return;
          const connection = await promised<BrokerConnection>((callback) => {
            reader[kGetConnection](broker, callback);
          });
          const api = await promised<API<unknown[], RawListOffsets>>((callback) => {
            reader[kGetApi]("ListOffsets", callback);
          });
          const answer = await api.async(connection, NO_REPLICA, READ_UNCOMMITTED, [
            {
              name,
              partitions: indexes.map((partitionIndex) => ({
                partitionIndex,
                currentLeaderEpoch: NO_LEADER_EPOCH,
                timestamp,
              })),
            },
          ]);
          for (const entry of answer.topics) {
            for (const partition of entry.partitions) result.set(partition.partitionIndex, partition.offset);
          }
        }),
      ),
    );
    return result;
  }

  /** Low and high watermarks of each partition of each topic. */
  async watermarks(requests: ReadonlyMap<string, readonly number[]>): Promise<Map<string, Map<number, Watermarks>>> {
    const [low, high] = await Promise.all([
      this.offsetsAt(requests, ListOffsetTimestamps.EARLIEST),
      this.offsetsAt(requests, ListOffsetTimestamps.LATEST),
    ]);
    const result = new Map<string, Map<number, Watermarks>>();
    for (const [topic, partitions] of requests) {
      const marks = new Map<number, Watermarks>();
      for (const partition of partitions) {
        const lowOffset = low.get(topic)?.get(partition);
        const highOffset = high.get(topic)?.get(partition);
        if (lowOffset !== undefined && highOffset !== undefined)
          marks.set(partition, { low: lowOffset, high: highOffset });
      }
      result.set(topic, marks);
    }
    return result;
  }

  async topicWatermarks(topic: string, partitions: readonly number[]): Promise<Map<number, Watermarks>> {
    return (await this.watermarks(new Map([[topic, partitions]]))).get(topic) ?? new Map();
  }

  /** A group's committed offset per partition of `topic`; -1 where it has none. Reads only. */
  async committed(group: string, topic: string, partitions: readonly number[]): Promise<Map<number, bigint>> {
    const listed = await failures(() =>
      this.reader.listConsumerGroupOffsets({
        groups: [{ groupId: group, topics: [{ name: topic, partitionIndexes: [...partitions] }] }],
      }),
    );
    const result = new Map<number, bigint>();
    for (const entry of listed[0]?.topics ?? []) {
      if (entry.name !== topic) continue;
      for (const partition of entry.partitions) result.set(partition.partitionIndex, partition.committedOffset);
    }
    return result;
  }

  async configs(resource: ConfigResource, name: string): Promise<ConfigEntry[]> {
    const resourceType = resource === "topic" ? ConfigResourceTypes.TOPIC : ConfigResourceTypes.BROKER;
    const described = await failures(() =>
      this.reader.describeConfigs({
        resources: [{ resourceType, resourceName: name }],
        includeDocumentation: true,
      }),
    );
    return (described[0]?.configs ?? []).map(configEntry).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Bytes per partition on its leader's log dir; empty when this user may not describe log dirs. */
  async partitionSizes(topic: string, partitions: readonly number[]): Promise<Map<number, bigint>> {
    const sizes = new Map<number, bigint>();
    try {
      const described = await this.reader.describeLogDirs({ topics: [{ name: topic, partitions: [...partitions] }] });
      for (const broker of described) {
        for (const result of broker.results) {
          for (const entry of result.topics) {
            if (entry.name !== topic) continue;
            for (const partition of entry.partitions) {
              if (partition.isFutureKey) continue;
              const known = sizes.get(partition.partitionIndex) ?? 0n;
              if (partition.partitionSize > known) sizes.set(partition.partitionIndex, partition.partitionSize);
            }
          }
        }
      }
    } catch {
      // DescribeLogDirs needs cluster Describe; without it the Partitions view shows no size.
    }
    return sizes;
  }

  /**
   * Calls a controller request on the writing client by hand, at the highest version both sides
   * speak: the driver's own wrappers hide `validateOnly` on CreateTopics, and route through a
   * retry loop that this session must not use for writes.
   */
  async controllerCall<R>(apiName: string, ...args: unknown[]): Promise<R> {
    const metadata = await this.metadata([]);
    const controller: Broker | undefined = metadata.brokers.get(metadata.controllerId);
    if (controller === undefined) throw refused("The cluster names no controller right now; try again in a moment.");
    const writer = this.writer;
    const connection = await promised<BrokerConnection>((callback) => {
      writer[kGetConnection](controller, callback);
    });
    const api = await promised<API<unknown[], R>>((callback) => {
      writer[kGetApi](apiName, callback);
    });
    return api.async(connection, ...args);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.#connection.admin.close().catch(() => undefined),
      this.#writer?.close().catch(() => undefined),
    ]);
  }
}
