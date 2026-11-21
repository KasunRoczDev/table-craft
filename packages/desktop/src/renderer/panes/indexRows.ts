import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { INDEX_ACTION_IDS, type OpenIndexArgs } from "@table-craft/desktop/renderer/actions/indexActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import type { ExplorerNode } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { INDEX_TREE_KINDS } from "@table-craft/desktop/renderer/model/indexTree.js";
import type { MenuEntry } from "@table-craft/desktop/renderer/panes/menuEntries.js";

const TARGET_MENU = [
  INDEX_ACTION_IDS.open,
  ACTION_IDS.newConsole,
  null,
  ACTION_IDS.synchronize,
  INDEX_ACTION_IDS.copyName,
] as const;

const INDEX_MENU = [ACTION_IDS.newConsole, null, ACTION_IDS.synchronize] as const;

/** An index tree row's context menu (decision 174); null for any other row. */
export function indexMenuOf(node: ExplorerNode): readonly MenuEntry[] | null {
  if (node.kind === "searchTarget") return TARGET_MENU;
  return INDEX_TREE_KINDS.has(node.kind) ? INDEX_MENU : null;
}

/** Opens an index, alias or data stream row in its tab; false for any other row. */
export function activateIndexRow(node: ExplorerNode): boolean {
  if (node.kind !== "searchTarget") return false;
  const args: OpenIndexArgs = { datasourceId: node.datasourceId, target: node.target.name };
  invoke(INDEX_ACTION_IDS.open, args);
  return true;
}

/**
 * Stable handles on index rows for the end-to-end suites: `index-index`, `index-alias` and
 * `index-dataStream` with the target's name, `index-section`, `index-folder`, `index-family`, `index-older`.
 */
export function indexRowAttributes(node: ExplorerNode): Readonly<Record<string, string>> {
  switch (node.kind) {
    case "searchTarget":
      return { "data-testid": `index-${node.target.kind}`, "data-name": node.target.name };
    case "indexSection":
      return { "data-testid": "index-section", "data-name": node.section };
    case "indexFolder":
      return { "data-testid": "index-folder", "data-name": node.prefix };
    case "indexFamily":
      return { "data-testid": "index-family", "data-name": node.base };
    case "indexOlder":
      return { "data-testid": "index-older", "data-name": node.base };
    default:
      return {};
  }
}
