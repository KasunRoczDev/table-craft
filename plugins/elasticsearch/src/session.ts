import {
  PluginError,
  type CancelReach,
  type ConnectOptions,
  type ExecuteOptions,
  type ExecuteResult,
  type ParameterValue,
  type PluginSession,
} from "@table-craft/plugin-api";
import { isNetworkError, type ElasticTransport } from "./client.js";
import type { ElasticConfig } from "./config.js";
import { openConnection, type Connection } from "./connect.js";
import { runRequest } from "./console.js";
import { ElasticIndices } from "./search.js";
import { nodeList, serverInfo } from "./server.js";

const BUSY_MESSAGE = "Another request is still running in this session.";
const CLOSED_MESSAGE = "The connection to the cluster is closed.";
const SUGGESTION_LIMIT = 50;
const CANCEL_REACH: CancelReach = { method: "aborts the HTTP request", reaches: "statement" };

export const CAPABILITIES = ["commands", "searchIndices", "nodes", "serverInfo", "cancel", "keepAlive"] as const;

export type ElasticCapability = (typeof CAPABILITIES)[number];

/** One datasource connection: a REST client and the index browser built on it (plan 165). */
export class ElasticSession implements PluginSession<ElasticCapability> {
  readonly serverVersion: string;
  readonly serverBrand: string;
  readonly tls = null;
  readonly services: PluginSession<ElasticCapability>["services"];
  readonly #connection: Connection;
  readonly #indices: ElasticIndices;
  readonly #readOnly: boolean;
  readonly #running = new Set<AbortController>();
  #busy = false;
  #closed = false;

  private constructor(connection: Connection, config: ElasticConfig, options: ConnectOptions) {
    this.#connection = connection;
    this.#readOnly = options.readOnly;
    this.serverVersion = connection.dialect.versionText;
    this.serverBrand = connection.dialect.distribution;
    this.#indices = new ElasticIndices(connection.transport, connection.dialect, config.indexFilter, (work) =>
      this.#tracked(work),
    );
    this.services = {
      searchIndices: this.#indices,
      nodes: { list: () => nodeList(this.#checked()) },
      serverInfo: {
        info: (node) => serverInfo(this.#checked(), connection.dialect, node),
        // Slow logs are written to the server's own log files; no API reads them back.
        slowLog: () => Promise.resolve([]),
      },
      keepAlive: { ping: () => this.#ping() },
      cancel: { cancel: () => this.#cancel(), reach: CANCEL_REACH },
    };
  }

  static async open(config: ElasticConfig, options: ConnectOptions): Promise<ElasticSession> {
    return ElasticSession.attach(await openConnection(config, options), config, options);
  }

  /** A session over a connection opened elsewhere, such as through another transport. */
  static attach(connection: Connection, config: ElasticConfig, options: ConnectOptions): ElasticSession {
    return new ElasticSession(connection, config, options);
  }

  /** The cluster's name, null when the user may not read it. */
  get clusterName(): string | null {
    return this.#connection.clusterName;
  }

  async execute(
    command: string,
    _params?: readonly ParameterValue[],
    _options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const transport = this.#checked();
    if (this.#busy) throw new PluginError("sessionBusy", BUSY_MESSAGE);
    this.#busy = true;
    const controller = new AbortController();
    this.#running.add(controller);
    try {
      return await runRequest(
        { transport, dialect: this.#connection.dialect, readOnly: this.#readOnly, signal: controller.signal },
        command.trim(),
      );
    } finally {
      this.#running.delete(controller);
      this.#busy = false;
    }
  }

  /** Index, alias and data stream names starting with `prefix`, at most 50, for completing a path. */
  async suggestIndices(prefix: string): Promise<readonly string[]> {
    this.#checked();
    return (await this.#indices.list())
      .filter((target) => !target.hidden && target.name.startsWith(prefix))
      .map((target) => target.name)
      .slice(0, SUGGESTION_LIMIT);
  }

  async #tracked<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#checked();
    const controller = new AbortController();
    this.#running.add(controller);
    try {
      return await work(controller.signal);
    } finally {
      this.#running.delete(controller);
    }
  }

  #cancel(): Promise<void> {
    for (const controller of this.#running) controller.abort();
    return Promise.resolve();
  }

  async #ping(): Promise<void> {
    const transport = this.#checked();
    try {
      await transport.request("HEAD", "/", { accept: [403] });
    } catch (cause) {
      if (cause instanceof PluginError) throw cause;
      throw new PluginError(isNetworkError(cause) ? "connectionLost" : "statementFailed", String(cause), { cause });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#cancel();
    await this.#indices.close();
    this.#connection.transport.close();
  }

  #checked(): ElasticTransport {
    if (this.#closed) throw new PluginError("connectionLost", CLOSED_MESSAGE);
    return this.#connection.transport;
  }
}
