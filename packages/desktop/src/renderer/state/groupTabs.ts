import { create } from "zustand";
import type { EngineError, GroupDescription } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/** Which consumer group a group tab shows (plan 164 Phase 5). */
export interface GroupTarget {
  readonly datasourceId: string;
  readonly group: string;
}

export type GroupView = "lag" | "members";

export interface GroupTab extends GroupTarget {
  readonly description: GroupDescription | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
  /** When the shown lag was read, by the store's clock. */
  readonly readAt: number | null;
  readonly view: GroupView;
}

export interface GroupTabsState {
  readonly tabs: Readonly<Record<string, GroupTab>>;
  readonly open: (id: string, target: GroupTarget) => Promise<void>;
  /** Reads the group's members, offsets and lag again; `quiet`, as the timer does, shows no progress. */
  readonly refresh: (id: string, quiet?: boolean) => Promise<void>;
  readonly setView: (id: string, view: GroupView) => void;
  readonly close: (id: string) => void;
  readonly detach: (datasourceId: string) => void;
}

export interface GroupTabsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  /** Whether the datasource is connected now; the timer's refresh never connects one. */
  readonly connected: (datasourceId: string) => boolean;
  readonly clock?: () => number;
}

/** Lag refreshes on its own this often while a group tab shows (plan 164 Phase 5). */
export const GROUP_REFRESH_MS = 10_000;

export function createGroupTabsStore(dependencies: GroupTabsDependencies) {
  const clock = dependencies.clock ?? (() => Date.now());
  /** The latest read per tab, so an answer overtaken by a later one is dropped. */
  const reads = new Map<string, number>();
  let readCount = 0;

  return create<GroupTabsState>()((set, get) => {
    function patch(id: string, change: Partial<GroupTab>): void {
      const current = get().tabs[id];
      if (current !== undefined) set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    async function refresh(id: string, quiet = false): Promise<void> {
      const tab = get().tabs[id];
      if (tab === undefined || (quiet && (tab.loading || !dependencies.connected(tab.datasourceId)))) return;
      const token = ++readCount;
      reads.set(id, token);
      if (!quiet) patch(id, { loading: true });
      try {
        const client = await dependencies.connect(tab.datasourceId);
        const description = await client.call("groups.describe", { group: tab.group });
        if (reads.get(id) === token) patch(id, { description, loading: false, error: null, readAt: clock() });
      } catch (cause) {
        if (reads.get(id) === token) patch(id, { loading: false, error: toError(cause) });
      }
    }

    return {
      tabs: {},

      async open(id, target) {
        const tab: GroupTab = { ...target, description: null, loading: false, error: null, readAt: null, view: "lag" };
        set({ tabs: { ...get().tabs, [id]: tab } });
        await refresh(id);
      },

      refresh,

      setView(id, view) {
        if (get().tabs[id]?.view !== view) patch(id, { view });
      },

      close(id) {
        reads.delete(id);
        const { [id]: _gone, ...tabs } = get().tabs;
        set({ tabs });
      },

      detach(datasourceId) {
        for (const [id, tab] of Object.entries(get().tabs)) {
          if (tab.datasourceId !== datasourceId) continue;
          reads.delete(id);
          patch(id, { loading: false });
        }
      },
    };
  });
}

export type GroupTabsStore = ReturnType<typeof createGroupTabsStore>;

export const useGroupTabs = createGroupTabsStore({
  connect: (id) => useDatasources.getState().connect(id),
  connected: (id) => useDatasources.getState().connections[id]?.status === "connected",
});

/** The group tabs open on a datasource, by tab id. */
export function groupTabsOf(tabs: GroupTabsState["tabs"], datasourceId: string): readonly string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.datasourceId === datasourceId)
    .map(([id]) => id);
}
