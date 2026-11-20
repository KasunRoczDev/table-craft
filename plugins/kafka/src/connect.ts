import { Admin, type BaseOptions, type ClusterMetadata, type SASLOptions } from "@platformatic/kafka";
import { isPluginError, PluginError, type ConnectOptions } from "@table-craft/plugin-api";
import { parseBootstrap, usesSasl, usesTls, type KafkaConfig } from "./config.js";
import { errorText } from "./failures.js";
import { tlsFailure, tlsOptions } from "./tls.js";
import { clusterModeOf, missingApis, serverVersionOf, type BrokerApi, type ClusterMode } from "./version.js";

const MS_PER_SECOND = 1000;
/** Dialling a broker gives up sooner than a request, so an unreachable listener is named quickly. */
const MAX_CONNECT_TIMEOUT_MS = 10_000;
/** Reads ride out a leader moving; writes never retry (decision 139). */
const READ_RETRIES = 3;
const RETRY_DELAY_MS = 250;
const AUTHENTICATION_ERROR_CODE = "PLT_KFK_AUTHENTICATION";
const MAX_CAUSE_DEPTH = 8;

/** Everything a session needs to open more clients like the first one. */
export interface Connection {
  readonly options: BaseOptions;
  /** The shared reading client; writes use their own without retries. */
  readonly admin: Admin;
  readonly apis: readonly BrokerApi[];
  readonly clusterId: string;
  readonly controllerId: number;
  readonly brokerCount: number;
  readonly mode: ClusterMode;
  readonly serverVersion: string;
  readonly tls: boolean;
}

function saslOf(config: KafkaConfig): SASLOptions | undefined {
  if (!usesSasl(config.security)) return undefined;
  return { mechanism: config.saslMechanism, username: config.user, password: config.password };
}

/** The driver options every client of the datasource shares. */
export async function clientOptions(config: KafkaConfig, options: ConnectOptions): Promise<BaseOptions> {
  const timeout = config.requestTimeout * MS_PER_SECOND;
  const sasl = saslOf(config);
  const tls = usesTls(config.security) ? await tlsOptions(config) : undefined;
  return {
    clientId: config.clientId,
    bootstrapBrokers: parseBootstrap(config.bootstrapServers).map(({ host, port }) => ({ host, port })),
    timeout,
    requestTimeout: timeout,
    connectTimeout: Math.min(timeout, MAX_CONNECT_TIMEOUT_MS),
    retries: READ_RETRIES,
    retryDelay: RETRY_DELAY_MS,
    autocreateTopics: false,
    ...(sasl === undefined ? {} : { sasl }),
    ...(tls === undefined ? {} : { tls }),
    ...(options.keepAliveInitialDelayMs === undefined
      ? {}
      : { keepAlive: { initialDelay: options.keepAliveInitialDelayMs } }),
  };
}

function causes(error: unknown, depth = 0): unknown[] {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== "object" || error === null) return [];
  const nested = (error as { errors?: unknown }).errors;
  const inner = Array.isArray(nested) ? (nested as unknown[]) : [];
  return [
    error,
    ...inner.flatMap((e) => causes(e, depth + 1)),
    ...causes((error as { cause?: unknown }).cause, depth + 1),
  ];
}

function isAuthentication(error: unknown): boolean {
  return causes(error).some((cause) => (cause as { code?: unknown }).code === AUTHENTICATION_ERROR_CODE);
}

/** A failed connect worded for the form: TLS settings, SASL credentials, or the bootstrap list. */
export function connectFailure(config: KafkaConfig, cause: unknown): PluginError {
  if (isPluginError(cause)) return cause;
  if (usesTls(config.security)) {
    const host = parseBootstrap(config.bootstrapServers)[0]?.host ?? "";
    for (const inner of causes(cause)) {
      const tls = tlsFailure(config, host, inner);
      if (tls !== null) return tls;
    }
  }
  if (isAuthentication(cause)) {
    return new PluginError(
      "connectionFailed",
      `SASL authentication failed: ${errorText(cause)}. Check the username, the password and the SASL mechanism (${config.saslMechanism}).`,
      { cause },
    );
  }
  return new PluginError(
    "connectionFailed",
    `Cannot reach the bootstrap servers ${config.bootstrapServers}: ${errorText(cause)}. Check the host, the port and the Security setting.`,
    { cause },
  );
}

/**
 * Brokers hand out their advertised listeners and the client dials those, so a reachable bootstrap
 * server says nothing about the partition leaders (decision 17): dial each broker now and name the
 * first one that cannot be reached.
 */
async function checkAdvertisedListeners(admin: Admin, metadata: ClusterMetadata): Promise<void> {
  const failures = await Promise.all(
    [...metadata.brokers.entries()].map(async ([id, broker]) => {
      try {
        await admin.connectToBrokers([id]);
        return null;
      } catch (cause) {
        return { id, address: `${broker.host}:${String(broker.port)}`, cause };
      }
    }),
  );
  const failed = failures.find((failure) => failure !== null);
  if (failed === undefined || failed === null) return;
  throw new PluginError(
    "connectionFailed",
    `Connected to the bootstrap server, but broker ${String(failed.id)} advertises ${failed.address}, which is unreachable from here (${errorText(failed.cause)}). Kafka clients dial the advertised listeners, not the bootstrap address: connect over a network that reaches them.`,
    { cause: failed.cause },
  );
}

/** Opens the reading client, checks the broker answers what browsing needs, and reaches every broker. */
export async function openConnection(config: KafkaConfig, options: ConnectOptions): Promise<Connection> {
  const base = await clientOptions(config, options);
  const admin = new Admin(base);
  try {
    const apis = await admin.listApis();
    const missing = missingApis(apis);
    if (missing.length > 0) {
      throw new PluginError(
        "connectionFailed",
        `This server does not answer the Kafka ${missing.join(", ")} ${missing.length === 1 ? "API" : "APIs"} TableCraft needs to browse topics; connect to a Kafka-compatible broker that does.`,
      );
    }
    const metadata = await admin.metadata({ topics: [], forceUpdate: true });
    await checkAdvertisedListeners(admin, metadata);
    return {
      options: base,
      admin,
      apis,
      clusterId: metadata.id,
      controllerId: metadata.controllerId,
      brokerCount: metadata.brokers.size,
      mode: clusterModeOf(apis, metadata.id),
      serverVersion: serverVersionOf(apis),
      tls: usesTls(config.security),
    };
  } catch (cause) {
    await admin.close().catch(() => undefined);
    throw connectFailure(config, cause);
  }
}
