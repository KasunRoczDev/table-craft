import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { READ_ONLY_REASON } from "@table-craft/desktop/renderer/actions/sessionsActions.js";
import { connectionOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";

/** Why a Kafka button that reads is off: its data source is not connected (audit M10). */
export function connectReason(datasource: Pick<DatasourceView, "name"> | undefined, connected: boolean): string | null {
  if (datasource === undefined || connected) return null;
  return `Connect to ${datasource.name} first.`;
}

/** Why a Kafka button that writes is off: read-only, or not connected (audit M10). */
export function writeReason(
  datasource: Pick<DatasourceView, "name" | "readOnly"> | undefined,
  connected: boolean,
): string | null {
  if (datasource?.readOnly === true) return READ_ONLY_REASON;
  return connectReason(datasource, connected);
}

/** The reasons of a tab's datasource, read live. */
export function useStreamReasons(datasource: DatasourceView | undefined): {
  readonly read: string | null;
  readonly write: string | null;
} {
  const connected = useDatasources(
    (state) => datasource !== undefined && connectionOf(state, datasource.id).status === "connected",
  );
  return { read: connectReason(datasource, connected), write: writeReason(datasource, connected) };
}
