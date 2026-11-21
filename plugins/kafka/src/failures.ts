import { isPluginError, PluginError } from "@table-craft/plugin-api";

const MAX_DEPTH = 6;
const PROTOCOL_ERROR_CODE = "PLT_KFK_PROTOCOL";
const NETWORK_ERROR_CODE = "PLT_KFK_NETWORK";
/** Kafka's id for each refusal that has advice beyond the broker's own words. */
const ADVICE: Readonly<Record<string, string>> = {
  TOPIC_AUTHORIZATION_FAILED: "Ask a Kafka admin to grant the datasource's user access to this topic.",
  GROUP_AUTHORIZATION_FAILED: "Ask a Kafka admin to grant the datasource's user access to this group.",
  CLUSTER_AUTHORIZATION_FAILED: "Ask a Kafka admin to grant the datasource's user this cluster operation.",
  UNKNOWN_TOPIC_OR_PARTITION: "Refresh the topic list: the topic or partition does not exist.",
  NON_EMPTY_GROUP: "Stop the group's consumers first.",
};

interface DriverError {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly apiId?: unknown;
  readonly serverErrorMessage?: unknown;
  readonly errors?: unknown;
  readonly cause?: unknown;
}

function leaves(error: unknown, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || typeof error !== "object" || error === null) {
    if (typeof error === "string" || typeof error === "number") out.push(String(error));
    return;
  }
  const driver = error as DriverError;
  if (Array.isArray(driver.errors) && driver.errors.length > 0) {
    for (const nested of driver.errors as unknown[]) leaves(nested, depth + 1, out);
    return;
  }
  if (driver.code === PROTOCOL_ERROR_CODE && typeof driver.apiId === "string") {
    const detail = typeof driver.serverErrorMessage === "string" ? driver.serverErrorMessage : null;
    const base = typeof driver.message === "string" ? driver.message : driver.apiId;
    const advice = ADVICE[driver.apiId];
    out.push(`${detail ?? base} (${driver.apiId})${advice === undefined ? "" : `. ${advice}`}`);
    return;
  }
  if (driver.cause !== undefined && driver.code === NETWORK_ERROR_CODE) {
    leaves(driver.cause, depth + 1, out);
    if (out.length > 0) return;
  }
  if (typeof driver.message === "string" && driver.message !== "") out.push(driver.message);
}

/** What went wrong, from the innermost errors the driver nests, each said once. */
export function errorText(cause: unknown): string {
  const out: string[] = [];
  leaves(cause, 0, out);
  const unique = [...new Set(out)];
  return unique.length === 0 ? String(cause) : unique.join("; ");
}

/** The Kafka error id somewhere in `cause`, such as `NON_EMPTY_GROUP`; null when there is none. */
export function kafkaErrorId(cause: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH || typeof cause !== "object" || cause === null) return null;
  const driver = cause as DriverError;
  if (driver.code === PROTOCOL_ERROR_CODE && typeof driver.apiId === "string") return driver.apiId;
  if (Array.isArray(driver.errors)) {
    for (const nested of driver.errors as unknown[]) {
      const found = kafkaErrorId(nested, depth + 1);
      if (found !== null) return found;
    }
  }
  return kafkaErrorId(driver.cause, depth + 1);
}

/** A network failure, so the host may reconnect. */
export function isNetworkError(cause: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof cause !== "object" || cause === null) return false;
  const driver = cause as DriverError;
  if (driver.code === NETWORK_ERROR_CODE) return true;
  if (Array.isArray(driver.errors) && (driver.errors as unknown[]).some((nested) => isNetworkError(nested, depth + 1)))
    return true;
  return isNetworkError(driver.cause, depth + 1);
}

/** `cause` as a `statementFailed`, a `PluginError` passed through. */
export function statementFailure(cause: unknown, prefix = ""): PluginError {
  if (isPluginError(cause)) return cause;
  return new PluginError("statementFailed", `${prefix}${errorText(cause)}`, { cause });
}

const TIMEOUT_ERROR_CODE = "PLT_KFK_TIMEOUT";
/** Broker answers that come after the write may already be in the log. */
const UNCERTAIN_IDS: ReadonlySet<string> = new Set(["REQUEST_TIMED_OUT", "NOT_ENOUGH_REPLICAS_AFTER_APPEND"]);

function hasCode(cause: unknown, code: string, depth = 0): boolean {
  if (depth > MAX_DEPTH || typeof cause !== "object" || cause === null) return false;
  const driver = cause as DriverError;
  if (driver.code === code) return true;
  if (Array.isArray(driver.errors) && (driver.errors as unknown[]).some((nested) => hasCode(nested, code, depth + 1)))
    return true;
  return hasCode(driver.cause, code, depth + 1);
}

/**
 * A write whose request may have reached the broker or registry before the failure: the host
 * reports it as possibly applied and never as "Nothing changed" (structural `outcome`, as etcd's).
 */
export class UncertainWrite extends PluginError {
  readonly outcome = "unknown";

  constructor(message: string, options?: ErrorOptions) {
    super("statementFailed", `${message} It may have been applied; check before you try again.`, options);
  }
}

/** Whether `cause` leaves a sent write's outcome open: a lost connection, a timeout, or an answer after appending. */
export function isUncertain(cause: unknown): boolean {
  if (cause instanceof UncertainWrite) return true;
  const id = kafkaErrorId(cause);
  return isNetworkError(cause) || hasCode(cause, TIMEOUT_ERROR_CODE) || (id !== null && UNCERTAIN_IDS.has(id));
}

/** `cause` of a write that was sent: `UncertainWrite` when its outcome is open, else a refusal. */
export function writeFailure(cause: unknown, prefix = ""): PluginError {
  if (isPluginError(cause)) return cause;
  if (isUncertain(cause)) return new UncertainWrite(`${prefix}${errorText(cause)}.`, { cause });
  return statementFailure(cause, prefix);
}

/** Runs a write, turning a driver failure into `writeFailure`. */
export async function writeFailures<T>(work: () => Promise<T>, prefix = ""): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    throw writeFailure(cause, prefix);
  }
}

/** A preview cannot leave out a partition whose watermarks Kafka did not report, as when it has no leader. */
export function unreportedOffsets(topic: string, partition: number): string {
  return `Kafka did not report the offsets of partition ${String(partition)} of ${topic}; it may have no leader. Try again in a moment.`;
}

export function refused(message: string): PluginError {
  return new PluginError("statementFailed", message);
}

/** Runs `work`, turning a driver failure into a `statementFailed` that says what Kafka refused. */
export async function failures<T>(work: () => Promise<T>, prefix = ""): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    throw statementFailure(cause, prefix);
  }
}
