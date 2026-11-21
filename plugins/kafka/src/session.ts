import { Consumer } from "@platformatic/kafka";
import {
  PluginError,
  type CancelReach,
  type ConnectOptions,
  type ExecuteOptions,
  type ExecuteResult,
  type MessageSpill,
  type ParameterValue,
  type PluginSession,
  type SchemaRegistry,
  type TopicRead,
  type TopicReadRequest,
  type TopicTail,
  type TopicTailRequest,
} from "@table-craft/plugin-api";
import { KafkaAdmin } from "./admin.js";
import { brokerInfo, brokerNodes } from "./brokers.js";
import type { KafkaConfig } from "./config.js";
import { nameFilter } from "./glob.js";
import { openConnection, type Connection } from "./connect.js";
import { runCommand } from "./console.js";
import { errorText, isNetworkError } from "./failures.js";
import { UNJOINED_GROUP_ID } from "./fetch.js";
import { KafkaGroups } from "./groups.js";
import { PreparedStore } from "./prepared.js";
import { KafkaProduce } from "./produce.js";
import { readTopic } from "./read.js";
import type { SchemaCache } from "./schemaCache.js";
import { RegistryClient } from "./registryClient.js";
import { KafkaSchemaRegistry, UnavailableRegistry } from "./registry.js";
import { openTail } from "./tail.js";
import { tlsOptions } from "./tls.js";
import { TopicAdmin } from "./topicAdmin.js";
import { KafkaTopics } from "./topics.js";

const BUSY_MESSAGE = "Another command is still running in this session.";
const CLOSED_MESSAGE = "The connection to Kafka is closed.";
const MS_PER_SECOND = 1000;
const SUGGESTION_LIMIT = 50;
const HTTPS = /^https:/i;
const CANCEL_REACH: CancelReach = { method: "stops fetching between Fetch requests", reaches: "statement" };

export const CAPABILITIES = [
  "commands",
  "topics",
  "consumerGroups",
  "schemaRegistry",
  "nodes",
  "serverInfo",
  "cancel",
  "keepAlive",
] as const;

export type KafkaCapability = (typeof CAPABILITIES)[number];

async function registryOf(config: KafkaConfig, readOnly: boolean): Promise<SchemaRegistry> {
  const url = config.registryUrl.trim();
  if (url === "") return new UnavailableRegistry();
  const client = new RegistryClient({
    url,
    basicAuth:
      config.registryAuth === "basic" ? { user: config.registryUser, password: config.registryPassword } : null,
    tls: HTTPS.test(url) ? await tlsOptions(config) : null,
    timeoutMs: config.requestTimeout * MS_PER_SECOND,
  });
  return new KafkaSchemaRegistry(client, readOnly, nameFilter(config.nameFilter));
}

/** One datasource connection: a reading admin client, and the services built on it (plan 164). */
export class KafkaSession implements PluginSession<KafkaCapability> {
  readonly serverVersion: string;
  readonly tls = null;
  readonly services: PluginSession<KafkaCapability>["services"];
  readonly #connection: Connection;
  readonly #admin: KafkaAdmin;
  readonly #config: KafkaConfig;
  readonly #prepared = new PreparedStore();
  readonly #produce: KafkaProduce;
  readonly #registry: SchemaRegistry;
  readonly #cache: SchemaCache | null;
  readonly #topics: KafkaTopics;
  readonly #topicAdmin: TopicAdmin;
  readonly #groups: KafkaGroups;
  readonly #readOnly: boolean;
  readonly #tails = new Set<TopicTail>();
  readonly #running = new Set<AbortController>();
  /**
   * Fetchers no read is using. Each running read holds its own, because two reads sharing one
   * clash on its fetch session epoch; one is kept idle so a read does not open a connection.
   */
  #idleFetchers: Consumer[] = [];
  readonly #busyFetchers = new Set<Consumer>();
  #busy = false;
  #closed = false;

  private constructor(connection: Connection, config: KafkaConfig, options: ConnectOptions, registry: SchemaRegistry) {
    this.#connection = connection;
    this.#config = config;
    this.#readOnly = options.readOnly;
    this.serverVersion = connection.serverVersion;
    this.#admin = new KafkaAdmin(connection);
    this.#registry = registry;
    this.#cache = registry instanceof KafkaSchemaRegistry ? registry.cache : null;
    this.#produce = new KafkaProduce(
      connection.options,
      this.#cache,
      options.readOnly,
      async (topic) => (await this.#admin.topic(topic)).partitionsCount,
    );
    this.#topicAdmin = new TopicAdmin(
      this.#admin,
      this.#prepared,
      options.readOnly,
      config.requestTimeout * MS_PER_SECOND,
    );
    this.#groups = new KafkaGroups(this.#admin, this.#prepared, options.readOnly, nameFilter(config.nameFilter));
    const topicAdmin = this.#topicAdmin;
    this.#topics = new KafkaTopics(
      this.#admin,
      {
        read: (request, spill) => this.#read(request, null, spill),
        produce: (record) => this.#produce.produce(record),
        create: (request, adminOptions) => topicAdmin.create(request, adminOptions),
        alterConfigs: (topic, changes, adminOptions) => topicAdmin.alterConfigs(topic, changes, adminOptions),
        addPartitions: (topic, total, adminOptions) => topicAdmin.addPartitions(topic, total, adminOptions),
        prepareDeleteRecords: (topic, partitions, before) => topicAdmin.prepareDeleteRecords(topic, partitions, before),
        deleteRecordsPrepared: (token) => topicAdmin.deleteRecordsPrepared(token),
        remove: (topic) => topicAdmin.remove(topic),
        tail: (request) => this.#tail(request),
      },
      this.#cache !== null,
      nameFilter(config.nameFilter),
    );
    this.services = {
      topics: this.#topics,
      consumerGroups: this.#groups,
      schemaRegistry: this.#registry,
      nodes: { list: () => brokerNodes(this.#checked()) },
      serverInfo: {
        info: (node) =>
          brokerInfo(
            this.#checked(),
            {
              clusterId: connection.clusterId,
              mode: connection.mode,
              serverVersion: connection.serverVersion,
              apis: connection.apis,
            },
            node,
          ),
        // Kafka keeps no slow log a client can read; request metrics live in JMX.
        slowLog: () => Promise.resolve([]),
      },
      keepAlive: { ping: () => this.#ping() },
      cancel: { cancel: () => this.#cancel(), reach: CANCEL_REACH },
    };
  }

  static async open(config: KafkaConfig, options: ConnectOptions): Promise<KafkaSession> {
    const connection = await openConnection(config, options);
    try {
      return new KafkaSession(connection, config, options, await registryOf(config, options.readOnly));
    } catch (error) {
      await connection.admin.close().catch(() => undefined);
      throw error;
    }
  }

  /** The cluster's mode and broker count, for the status bar: `KRaft`, 3. */
  get cluster(): { readonly mode: string; readonly brokers: number } {
    return { mode: this.#connection.mode, brokers: this.#connection.brokerCount };
  }

  async execute(sql: string, _params?: readonly ParameterValue[], options?: ExecuteOptions): Promise<ExecuteResult> {
    this.#checked();
    if (this.#busy) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    this.#busy = true;
    const fullBytes = options?.fullBytes === true;
    try {
      return await runCommand(
        {
          readOnly: this.#readOnly,
          admin: this.#admin,
          topics: this.#topics,
          topicAdmin: this.#topicAdmin,
          groups: this.#groups,
          registry: this.#registry,
          follow: (request, followMs) => this.#read(request, followMs, undefined, fullBytes),
        },
        sql.trim(),
      );
    } finally {
      this.#busy = false;
    }
  }

  async #read(
    request: TopicReadRequest,
    followMs: number | null = null,
    spill?: MessageSpill,
    fullBytes = false,
  ): Promise<TopicRead> {
    const admin = this.#checked();
    const controller = new AbortController();
    this.#running.add(controller);
    const fetcher = this.#takeFetcher();
    try {
      return await readTopic(
        {
          admin,
          fetcher: () => fetcher,
          registry: this.#cache,
          maxScan: this.#config.maxScan,
          fullBytes,
          signal: controller.signal,
          committed: (group, topic, partitions) => admin.committed(group, topic, partitions),
        },
        request,
        followMs,
        spill,
      );
    } finally {
      this.#running.delete(controller);
      await this.#returnFetcher(fetcher);
    }
  }

  async #tail(request: TopicTailRequest): Promise<TopicTail> {
    const admin = this.#checked();
    const tail = await openTail(this.#connection.options, admin, this.#cache, request);
    if (this.#closed) {
      await tail.close();
      throw new PluginError("connectionLost", CLOSED_MESSAGE);
    }
    this.#tails.add(tail);
    return {
      next: (batch) => tail.next(batch),
      close: async () => {
        this.#tails.delete(tail);
        await tail.close();
      },
    };
  }

  #takeFetcher(): Consumer {
    const fetcher =
      this.#idleFetchers.pop() ?? new Consumer({ ...this.#connection.options, groupId: UNJOINED_GROUP_ID });
    this.#busyFetchers.add(fetcher);
    return fetcher;
  }

  async #returnFetcher(fetcher: Consumer): Promise<void> {
    this.#busyFetchers.delete(fetcher);
    if (this.#closed || this.#idleFetchers.length > 0) await fetcher.close().catch(() => undefined);
    else this.#idleFetchers.push(fetcher);
  }

  /** Fetchers open now, idle or reading; a test sees reads that overlap use their own. */
  get fetcherCount(): number {
    return this.#idleFetchers.length + this.#busyFetchers.size;
  }

  #cancel(): Promise<void> {
    for (const controller of this.#running) controller.abort();
    return Promise.resolve();
  }

  async #ping(): Promise<void> {
    const admin = this.#checked();
    try {
      await admin.reader.metadata({ topics: [], forceUpdate: true });
    } catch (cause) {
      throw new PluginError(isNetworkError(cause) ? "connectionLost" : "statementFailed", errorText(cause), { cause });
    }
  }

  /** Topic, group or subject names starting with `prefix`, at most 50, for completing an argument. */
  async suggestNames(kind: "topic" | "group" | "subject", prefix: string): Promise<readonly string[]> {
    const admin = this.#checked();
    let names: readonly string[];
    if (kind === "topic") names = await admin.topicNames(true);
    else if (kind === "group") names = [...(await admin.reader.listGroups()).keys()];
    else names = this.#registry instanceof KafkaSchemaRegistry ? await this.#registry.subjectNames() : [];
    return names
      .filter((name) => name.startsWith(prefix))
      .sort()
      .slice(0, SUGGESTION_LIMIT);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#cancel();
    this.#prepared.clear();
    await Promise.all([...this.#tails].map((tail) => tail.close().catch(() => undefined)));
    this.#tails.clear();
    const fetchers = [...this.#idleFetchers, ...this.#busyFetchers];
    this.#idleFetchers = [];
    await Promise.all([
      this.#admin.close(),
      this.#produce.close(),
      ...fetchers.map((fetcher) => fetcher.close().catch(() => undefined)),
    ]);
  }

  #checked(): KafkaAdmin {
    if (this.#closed || this.#connection.admin.closed) throw new PluginError("connectionLost", CLOSED_MESSAGE);
    return this.#admin;
  }
}
