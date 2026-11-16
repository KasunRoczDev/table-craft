import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { capabilitiesOf, pluginOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { currentFormatOptions } from "@table-craft/desktop/renderer/state/settings.js";

type DatasourceRef = Pick<DatasourceView, "id" | "pluginId">;

/** Formats a statement for display; it rejects with the plugin's message when the text cannot be laid out. */
export type StatementFormatter = (sql: string) => Promise<string>;

export function highlightOf(view: Pick<DatasourceView, "pluginId">): string | null | undefined {
  return pluginOf(useDatasources.getState().plugins, view.pluginId)?.highlight;
}

/**
 * The plugin's formatter with the user's layout, as Reformat Code uses it (decision 149); absent when
 * the plugin does not speak SQL. It needs only the language engine, never a connection.
 */
export function formatterOf(view: DatasourceRef): { readonly format?: StatementFormatter } {
  if (!capabilitiesOf(useDatasources.getState().plugins, view.pluginId).includes("sql")) return {};
  return {
    format: async (sql) => {
      const client = await useDatasources.getState().engine(view.id);
      return client.call("sql.format", { text: sql, options: currentFormatOptions() });
    },
  };
}
