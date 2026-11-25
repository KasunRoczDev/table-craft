import type { TreeItemRef } from "@table-craft/desktop/datasourceTree/arrange.js";
import type { Capability } from "@table-craft/desktop/engine/protocol.js";
import { selectedItems } from "@table-craft/desktop/renderer/model/treeSelection.js";
import { useKeyAdmin } from "@table-craft/desktop/renderer/keyAdmin/store.js";
import { useWatch } from "@table-craft/desktop/renderer/watch/store.js";
import { useAdminSecret } from "@table-craft/desktop/renderer/keyAdmin/SecretPrompt.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import {
  activeResultOf,
  useConsoles,
  type ConsoleSession,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/consoles.js";
import { useDdl, type DdlTab } from "@table-craft/desktop/renderer/state/ddl.js";
import { useDiagrams, type DiagramTab } from "@table-craft/desktop/renderer/state/diagrams.js";
import { useDataSourcesDialog } from "@table-craft/desktop/renderer/state/dataSourcesDialog.js";
import { useExportDataSourcesDialog } from "@table-craft/desktop/renderer/state/exportDataSourcesDialog.js";
import { useImportDataSourcesDialog } from "@table-craft/desktop/renderer/state/importDataSourcesDialog.js";
import { useManageShownSchemasDialog } from "@table-craft/desktop/renderer/state/manageShownSchemasDialog.js";
import { useSettingsDialog } from "@table-craft/desktop/renderer/state/settingsDialog.js";
import { useSnippetsDialog } from "@table-craft/desktop/renderer/state/snippetsDialog.js";
import {
  capabilitiesOf,
  connectionOf,
  datasourceById,
  selectedDatasourceId,
  treeSelectionOf,
  useDatasources,
  type Connection,
  type TreeSelection,
} from "@table-craft/desktop/renderer/state/datasources.js";
import { useLayout, type ToolWindowId } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { usePalette } from "@table-craft/desktop/renderer/state/palette.js";
import { useHostKeyPrompt } from "@table-craft/desktop/renderer/state/hostKeyPrompt.js";
import { useSecretPrompt } from "@table-craft/desktop/renderer/state/secretPrompt.js";
import { useKeyTabs, type KeyTab } from "@table-craft/desktop/renderer/state/keyTabs.js";
import { useServer, type ServerTab } from "@table-craft/desktop/renderer/state/server.js";
import { useTopicTabs, type TopicTab } from "@table-craft/desktop/renderer/state/topicTabs.js";
import { useGroupTabs, type GroupTab } from "@table-craft/desktop/renderer/state/groupTabs.js";
import { useSubjectTabs } from "@table-craft/desktop/renderer/state/subjectTabs.js";
import { useIndexTabs, type IndexTab } from "@table-craft/desktop/renderer/state/indexTabs.js";
import { useStreamDialog } from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { useSessions, type SessionsTab } from "@table-craft/desktop/renderer/state/sessions.js";
import { activeTab, useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import { useTables, type TableSession } from "@table-craft/desktop/renderer/state/tables.js";
import { useWindowState } from "@table-craft/desktop/renderer/state/windowState.js";

/** The regions focus can be in; each is a `data-region` attribute on its container. */
export type FocusRegion =
  | "editor"
  | "editorFind"
  | "editorReplace"
  | "tableEditor"
  | "grid"
  | "gridFind"
  | "valuePanel"
  | "database"
  | "services"
  | "log"
  | "watch"
  | "other";

const REGIONS: readonly FocusRegion[] = [
  "editor",
  "editorFind",
  "editorReplace",
  "tableEditor",
  "grid",
  "gridFind",
  "valuePanel",
  "database",
  "services",
  "log",
  "watch",
];

export const REGION_ATTRIBUTE = "data-region";
/** Marks a pane's own text field whose Escape clears it, as the speed search field does, rather than leaving the pane. */
export const KEEPS_ESCAPE_ATTRIBUTE = "data-keeps-escape";

function keepsEscape(): boolean {
  return document.activeElement?.closest(`[${KEEPS_ESCAPE_ATTRIBUTE}]`) != null;
}

/** A datasource with what the window knows of it now. */
export interface DatasourceTarget {
  readonly view: DatasourceView;
  readonly connection: Connection;
  readonly capabilities: readonly Capability[];
}

/** A plain snapshot of the stores, taken at invoke time. Actions read this, never components. */
export interface ActionContext {
  readonly tabs: readonly Tab[];
  readonly activeTab: Tab | null;
  /** The active tab's console, when the active tab is one. */
  readonly console: ConsoleSession | null;
  /** The active tab's table, when the active tab shows one in the data editor. */
  readonly table: TableSession | null;
  /** The active tab's relation definition, when the active tab is a DDL tab. */
  readonly ddl: DdlTab | null;
  /** The active tab's ER diagram and its id, when the active tab is a diagram tab. */
  readonly diagram: (DiagramTab & { readonly id: string }) | null;
  /** The active tab's server sessions, when the active tab is a Sessions tab. */
  readonly sessions: SessionsTab | null;
  /** The active tab's key, when the active tab is a key tab (plan 058). */
  readonly keyTab: KeyTab | null;
  /** The active tab's server figures, when the active tab is a Server tab (plan 058). */
  readonly serverTab: ServerTab | null;
  /** The active tab's topic, when the active tab is a topic tab (plan 164). */
  readonly topicTab?: TopicTab | null;
  /** The active tab's consumer group, when the active tab is a group tab (plan 164). */
  readonly groupTab?: GroupTab | null;
  /** The active tab's index, alias or data stream, when the active tab is an index tab (plan 165). */
  readonly indexTab?: IndexTab | null;
  /** The grid's result: the active console's shown result tab, or the active table's or key's rows. */
  readonly result: ResultTab | null;
  readonly datasources: readonly DatasourceView[];
  readonly selection: TreeSelection | null;
  /**
   * What Move to Folder… and Delete act on (plan 136): every selected datasource and folder while
   * the Database pane has focus, otherwise `datasource`.
   */
  readonly items: readonly TreeItemRef[];
  /** Every folder in the stored order. */
  readonly folders: readonly string[];
  /**
   * What "the datasource" means to an action: the tree's selection while the Database pane has
   * focus, otherwise the active console's datasource, otherwise the tree's selection.
   */
  readonly datasource: DatasourceTarget | null;
  /** The active console's, table's, DDL or Sessions tab's datasource's capabilities. */
  readonly capabilities: readonly Capability[];
  readonly focus: FocusRegion;
  /** Focus is in the Database pane, or was when a menu or dialog took it: `datasource` is the tree's. */
  readonly inDatabasePane: boolean;
  readonly toolWindows: Readonly<Record<ToolWindowId, boolean>>;
  /** The palette or any dialog is open; it owns the keyboard. */
  readonly paletteOpen: boolean;
  /**
   * The Database pane's speed search field is open, or focus is in a field marked
   * `KEEPS_ESCAPE_ATTRIBUTE` such as the index filter; Escape closes it rather than leaving the pane.
   */
  readonly speedSearching: boolean;
  /** The main toolbar is the window's title bar (decision 034), rather than the system's. */
  readonly customTitleBar: boolean;
}

function regionOf(element: Element | null | undefined): FocusRegion {
  const region = element?.closest(`[${REGION_ATTRIBUTE}]`)?.getAttribute(REGION_ATTRIBUTE);
  return REGIONS.find((candidate) => candidate === region) ?? "other";
}

export function focusedRegion(): FocusRegion {
  return regionOf(document.activeElement);
}

/** The last region focus was in before a menu, dialog or the palette took it. */
let lastRegion: FocusRegion = "editor";

/** Remembers the last real region, so a context menu opened on the tree still means the tree. */
export function trackFocus(target: Pick<Document, "addEventListener" | "removeEventListener">): () => void {
  const listener = (event: FocusEvent) => {
    const region = regionOf(event.target instanceof Element ? event.target : null);
    if (region !== "other") lastRegion = region;
  };
  target.addEventListener("focusin", listener);
  return () => target.removeEventListener("focusin", listener);
}

/** Whether something modal holds the keyboard: the palette, a dialog or a prompt. */
export function modalOpen(): boolean {
  return (
    usePalette.getState().mode !== null ||
    useDataSourcesDialog.getState().target !== null ||
    useImportDataSourcesDialog.getState().session !== null ||
    useExportDataSourcesDialog.getState().session !== null ||
    useManageShownSchemasDialog.getState().datasourceId !== null ||
    useSettingsDialog.getState().page !== null ||
    useSnippetsDialog.getState().open ||
    useSecretPrompt.getState().pending !== null ||
    useHostKeyPrompt.getState().queue.length > 0 ||
    useModal.getState().pending !== null ||
    useAdminSecret.getState().pending !== null ||
    useStreamDialog.getState().pending !== null
  );
}

/** What the window knows now of datasource `id`, for an action whose target is not `context.datasource`. */
export function datasourceTarget(id: string | null | undefined): DatasourceTarget | null {
  const datasources = useDatasources.getState();
  const view = datasourceById(datasources, id);
  return view === undefined
    ? null
    : {
        view,
        connection: connectionOf(datasources, view.id),
        capabilities: capabilitiesOf(datasources.plugins, view.pluginId),
      };
}

export function currentContext(tabId?: string): ActionContext {
  const strip = useTabs.getState();
  const active = tabId === undefined ? activeTab(strip) : (strip.tabs.find((tab) => tab.id === tabId) ?? null);
  const { consoles } = useConsoles.getState();
  const datasources = useDatasources.getState();
  const console = active?.kind === "console" ? (consoles[active.id] ?? null) : null;
  const table = active?.kind === "table" ? (useTables.getState().tables[active.id] ?? null) : null;
  const ddl = active?.kind === "ddl" ? (useDdl.getState().ddls[active.id] ?? null) : null;
  const diagramTab = active?.kind === "diagram" ? useDiagrams.getState().tabs[active.id] : undefined;
  const sessions = active?.kind === "sessions" ? (useSessions.getState().tabs[active.id] ?? null) : null;
  const keyTab = active?.kind === "key" ? (useKeyTabs.getState().tabs[active.id] ?? null) : null;
  const serverTab = active?.kind === "server" ? (useServer.getState().tabs[active.id] ?? null) : null;
  const topicTab = active?.kind === "topic" ? (useTopicTabs.getState().tabs[active.id] ?? null) : null;
  const groupTab = active?.kind === "group" ? (useGroupTabs.getState().tabs[active.id] ?? null) : null;
  const indexTab = active?.kind === "index" ? (useIndexTabs.getState().tabs[active.id] ?? null) : null;
  const tabDatasourceId =
    console?.datasourceId ??
    table?.datasourceId ??
    ddl?.datasourceId ??
    diagramTab?.datasourceId ??
    sessions?.datasourceId ??
    keyTab?.datasourceId ??
    serverTab?.datasourceId ??
    topicTab?.datasourceId ??
    groupTab?.datasourceId ??
    indexTab?.datasourceId ??
    (active?.kind === "subject" ? useSubjectTabs.getState().tabs[active.id]?.datasourceId : undefined) ??
    (active === null ? undefined : useKeyAdmin.getState().tabs[active.id]?.datasourceId);
  const focus = focusedRegion();
  const selected = selectedDatasourceId(datasources.selection);
  const inTree = tabId === undefined && (focus === "database" || (focus === "other" && lastRegion === "database"));
  const watchState = useWatch.getState();
  const watchSource =
    focus === "watch" && watchState.activeId !== null
      ? watchState.entries[watchState.activeId]?.datasourceId
      : undefined;
  const targetId = inTree ? selected : (watchSource ?? tabDatasourceId ?? selected);
  const target = datasourceById(datasources, targetId);
  const treeItems = inTree ? selectedItems(treeSelectionOf(datasources)) : [];
  const items: readonly TreeItemRef[] =
    treeItems.length > 0 ? treeItems : target === undefined ? [] : [{ kind: "datasource", id: target.id }];
  return {
    tabs: strip.tabs,
    activeTab: active,
    console,
    table,
    ddl,
    diagram: diagramTab === undefined || active === null ? null : { ...diagramTab, id: active.id },
    sessions,
    keyTab,
    serverTab,
    topicTab,
    groupTab,
    indexTab,
    result:
      console === null
        ? (table?.result ??
          keyTab?.result ??
          (topicTab?.view === "messages" ? topicTab.result : null) ??
          (indexTab?.view === "documents" ? indexTab.result : null) ??
          null)
        : (activeResultOf(console) ?? null),
    datasources: datasources.datasources,
    selection: datasources.selection,
    items,
    folders: datasources.folders,
    datasource: datasourceTarget(target?.id),
    capabilities:
      tabDatasourceId === undefined
        ? []
        : capabilitiesOf(datasources.plugins, datasourceById(datasources, tabDatasourceId)?.pluginId ?? ""),
    focus,
    inDatabasePane: inTree,
    toolWindows: useLayout.getState().layout.visible,
    paletteOpen: modalOpen(),
    speedSearching: useCatalog.getState().speedSearch !== null || keepsEscape(),
    customTitleBar: useWindowState.getState().customTitleBar,
  };
}
