import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import { datasourceTarget, type ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { catalogRowOf } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import {
  canSearchIndex,
  INDEX_VIEWS,
  useIndexTabs,
  type IndexTarget,
  type IndexView,
} from "@table-craft/desktop/renderer/state/indexTabs.js";
import { useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";

export const INDEX_ACTION_IDS = {
  open: "index.open",
  run: "index.run",
  showView: "index.showView",
  refresh: "index.refresh",
  cancel: "index.cancel",
  copyRequest: "index.copyRequest",
  openRequestInConsole: "index.openRequestInConsole",
  copyName: "index.copyName",
  analyze: "index.analyze",
  toggleSortOrder: "index.toggleSortOrder",
  searchAllTime: "index.searchAllTime",
} as const;

const ALL_TIME = "all";

const SEARCH_CAPABILITY = "searchIndices";
const INDEX_TAB_PREFIX = "index-";
let indexTabsOpened = 0;

export type OpenIndexArgs = IndexTarget;

export interface IndexViewArgs {
  readonly view: IndexView;
}

function isIndexTarget(args: unknown): args is IndexTarget {
  return typeof args === "object" && args !== null && "datasourceId" in args && "target" in args;
}

const searches = (context: ActionContext) => context.datasource?.capabilities.includes(SEARCH_CAPABILITY) === true;

/** Whether an index action applies: to the target `args` name when given, else to `context.datasource`. */
export function indicesAvailable(context: ActionContext, args?: unknown): boolean {
  if (!isIndexTarget(args)) return searches(context);
  const source =
    context.datasource?.view.id === args.datasourceId ? context.datasource : datasourceTarget(args.datasourceId);
  return source?.capabilities.includes(SEARCH_CAPABILITY) === true;
}

/** The index, alias or data stream the tree's selection is, if it is one. */
export function selectedIndex(context: ActionContext): IndexTarget | null {
  const { selection } = context;
  if (selection?.kind !== "catalog") return null;
  const row = catalogRowOf(selection.key);
  const target = row?.rest[0];
  return row?.kind === "searchTarget" && typeof target === "string" ? { datasourceId: selection.id, target } : null;
}

/** What an index action acts on: its arguments, the tree's selected target in the pane, else the active index tab. */
export function indexTarget(context: ActionContext, args?: unknown): IndexTarget | null {
  if (isIndexTarget(args)) return { datasourceId: args.datasourceId, target: args.target };
  const selected = context.inDatabasePane ? selectedIndex(context) : null;
  if (selected !== null) return selected;
  const tab = context.indexTab;
  return tab == null ? selectedIndex(context) : { datasourceId: tab.datasourceId, target: tab.target };
}

/** Opens the target in an index tab, or brings its open tab forward. */
export function openIndex(target: IndexTarget): void {
  const existing = Object.entries(useIndexTabs.getState().tabs).find(
    ([, tab]) => tab.datasourceId === target.datasourceId && tab.target === target.target,
  )?.[0];
  if (existing !== undefined) {
    useTabs.getState().activate(existing);
    return;
  }
  const tab: Tab = { id: `${INDEX_TAB_PREFIX}${String(indexTabsOpened++)}`, kind: "index", title: target.target };
  useTabs.getState().open(tab);
  void useIndexTabs.getState().open(tab.id, target);
}

const searchRequestOf = (context: ActionContext) => context.indexTab?.search?.request ?? null;

export const INDEX_ACTIONS: readonly AnyAction[] = [
  defineAction<OpenIndexArgs | undefined>({
    id: INDEX_ACTION_IDS.open,
    title: "Open Index",
    category: "Search",
    icon: "searchIndex",
    available: indicesAvailable,
    when: (context, args) => (isIndexTarget(args) ? true : selectedIndex(context) !== null),
    run: (context, args) => {
      const target = isIndexTarget(args) ? args : selectedIndex(context);
      if (target !== null) openIndex(target);
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.run,
    title: "Search Index",
    category: "Search",
    icon: "run",
    tabKind: "index",
    when: (context) =>
      context.indexTab != null &&
      canSearchIndex(context.indexTab.status) &&
      !(context.indexTab.describing && context.indexTab.description === null),
    busy: (context) => context.indexTab?.status === "loading",
    run: async (context) => {
      if (context.activeTab !== null) await useIndexTabs.getState().run(context.activeTab.id);
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.toggleSortOrder,
    title: "Reverse Sort Order",
    category: "Search",
    tabKind: "index",
    when: (context) => context.indexTab?.draft.sortField != null,
    run: (context) => {
      const tab = context.indexTab;
      if (context.activeTab === null || tab == null) return;
      useIndexTabs
        .getState()
        .setDraft(context.activeTab.id, { sortOrder: tab.draft.sortOrder === "asc" ? "desc" : "asc" });
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.searchAllTime,
    title: "Search All Time",
    category: "Search",
    tabKind: "index",
    when: (context) =>
      context.indexTab != null &&
      context.indexTab.draft.range !== ALL_TIME &&
      context.indexTab.description?.timeField != null &&
      canSearchIndex(context.indexTab.status),
    run: async (context) => {
      if (context.activeTab === null) return;
      useIndexTabs.getState().setDraft(context.activeTab.id, { range: ALL_TIME });
      await useIndexTabs.getState().run(context.activeTab.id);
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.cancel,
    title: "Cancel Search",
    category: "Search",
    icon: "cancel",
    tabKind: "index",
    when: (context) => context.indexTab?.status === "loading",
    run: async (context) => {
      if (context.activeTab !== null) await useIndexTabs.getState().cancel(context.activeTab.id);
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.refresh,
    title: "Refresh Index",
    category: "Search",
    icon: "synchronize",
    tabKind: "index",
    when: (context) =>
      context.indexTab != null && !context.indexTab.describing && canSearchIndex(context.indexTab.status),
    run: async (context) => {
      if (context.activeTab !== null) await useIndexTabs.getState().refresh(context.activeTab.id);
    },
  }),
  defineAction<IndexViewArgs | undefined>({
    id: INDEX_ACTION_IDS.showView,
    title: "Show Index View",
    category: "Search",
    tabKind: "index",
    inPalette: false,
    run: (context, args) => {
      if (context.activeTab === null || args === undefined || !INDEX_VIEWS.includes(args.view)) return;
      useIndexTabs.getState().setView(context.activeTab.id, args.view);
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.copyRequest,
    title: "Copy Search Request",
    category: "Search",
    icon: "copy",
    tabKind: "index",
    when: (context) => searchRequestOf(context) !== null,
    run: async (context) => {
      const request = searchRequestOf(context);
      if (request !== null) await writeClipboard(request);
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.openRequestInConsole,
    title: "Open Search Request in Console",
    category: "Search",
    icon: "newConsole",
    tabKind: "index",
    when: (context) => searchRequestOf(context) !== null,
    run: async (context) => {
      const tab = context.indexTab;
      const request = searchRequestOf(context);
      if (tab == null || request === null) return;
      await openConsole(tab.datasourceId, request);
    },
  }),
  defineAction<OpenIndexArgs | undefined>({
    id: INDEX_ACTION_IDS.copyName,
    title: "Copy Index Name",
    category: "Search",
    icon: "copy",
    available: indicesAvailable,
    when: (context, args) => indexTarget(context, args) !== null,
    run: async (context, args) => {
      const target = indexTarget(context, args);
      if (target !== null) await writeClipboard(target.target);
    },
  }),
  defineAction({
    id: INDEX_ACTION_IDS.analyze,
    title: "Analyze Text",
    category: "Search",
    icon: "analyze",
    tabKind: "index",
    when: (context) =>
      context.indexTab != null && !context.indexTab.analyzing && context.indexTab.analyzeDraft.text.trim() !== "",
    busy: (context) => context.indexTab?.analyzing === true,
    run: async (context) => {
      if (context.activeTab !== null) await useIndexTabs.getState().analyze(context.activeTab.id);
    },
  }),
];
