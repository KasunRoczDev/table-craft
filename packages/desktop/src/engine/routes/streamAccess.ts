import { isPluginError, type SessionServices } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { helperRequestFailed } from "@table-craft/desktop/engine/failures.js";
import { definitelyNotApplied } from "@table-craft/desktop/engine/keyOperations/scope.js";
import { serviceOf } from "@table-craft/desktop/engine/services.js";

type StreamCapability = "topics" | "consumerGroups" | "schemaRegistry";

/**
 * A broker or registry answers every request it refuses with an error code, so a plugin's
 * `statementFailed` means nothing changed and its words are shown as they are (decision 12). A
 * plugin marks a failure it cannot place (a timeout after sending) `connectionLost` or `outcome:
 * "unknown"`, which stays "may have committed".
 */
export function streamNotApplied(cause: unknown): boolean {
  if (definitelyNotApplied(cause)) return true;
  return (
    isPluginError(cause) && cause.code === "statementFailed" && !("outcome" in cause && cause.outcome === "unknown")
  );
}

/** How the stream routes reach their services; built lazily, as a route group is built before it runs. */
export function streamAccess(connection: ConnectionContext) {
  const scope = () => connection.keyOperations.scope;
  return {
    /** A read on the engine's helper session, which reconnects once when the session was lost. */
    read: <C extends StreamCapability, T>(capability: C, work: (service: SessionServices[C]) => Promise<T>) => {
      scope().capability(capability);
      return connection
        .onHelper((session) => work(serviceOf(session, capability)))
        .catch((cause: unknown) => {
          throw helperRequestFailed(cause);
        });
    },
    /** A read whose answer holds a token the matching write applies, so it runs on the same admin session. */
    prepare: <C extends StreamCapability, T>(capability: C, work: (service: SessionServices[C]) => Promise<T>) =>
      scope().run(capability, false, work),
    /** A write: refused on a read-only datasource before the plugin hears of it, serialized, never retried. */
    write: <C extends StreamCapability, T>(capability: C, work: (service: SessionServices[C]) => Promise<T>) =>
      scope().run(capability, true, work, streamNotApplied),
  };
}
