import { create } from "zustand";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { datasourceKey, keyTreeKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  EMPTY_INDICES,
  OPEN_INDEX_SECTIONS,
  type DatasourceIndices,
} from "@table-craft/desktop/renderer/model/indexTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

export interface IndicesState {
  /** By datasource id; a datasource without an entry has listed nothing since it last attached. */
  readonly indices: Readonly<Record<string, DatasourceIndices>>;
  /** Expands the datasource and its sections, connecting it and listing them the first time. */
  readonly expandDatasource: (datasourceId: string) => Promise<void>;
  /** Lists indices, aliases and data streams again. */
  readonly synchronize: (datasourceId: string) => Promise<void>;
  /** Narrows the tree to the targets whose names match `filter` (plan 166); empty shows them all. */
  readonly setFilter: (datasourceId: string, filter: string) => void;
  /** Forgets the datasource's list; its engine is gone. */
  readonly clear: (datasourceId: string) => void;
}

export interface IndicesDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly expand: (keys: readonly string[]) => void;
  readonly collapse: (key: string) => void;
}

export function createIndicesStore(dependencies: IndicesDependencies) {
  /** Bumped by `clear` and by every listing, so only the newest answer from a live engine lands. */
  const generations = new Map<string, number>();
  const generationOf = (id: string) => generations.get(id) ?? 0;
  const bump = (id: string) => {
    const next = generationOf(id) + 1;
    generations.set(id, next);
    return next;
  };

  return create<IndicesState>()((set, get) => {
    function indicesOf(id: string): DatasourceIndices {
      return get().indices[id] ?? EMPTY_INDICES;
    }

    function update(id: string, change: Partial<DatasourceIndices>): void {
      set({ indices: { ...get().indices, [id]: { ...indicesOf(id), ...change } } });
    }

    async function list(id: string): Promise<void> {
      const generation = bump(id);
      update(id, { loading: true, error: null });
      try {
        const client = await dependencies.connect(id);
        const targets = await client.call("indices.list", {});
        if (generationOf(id) !== generation) return;
        update(id, { targets, loading: false, error: null });
      } catch (cause) {
        if (generationOf(id) !== generation) return;
        update(id, { loading: false, error: toError(cause) });
      }
    }

    return {
      indices: {},

      async expandDatasource(id) {
        const key = datasourceKey(id);
        dependencies.expand([key, ...OPEN_INDEX_SECTIONS.map((section) => keyTreeKey(id, "indexSection", section))]);
        const current = indicesOf(id);
        if (current.targets !== null || current.loading) return;
        try {
          await dependencies.connect(id);
        } catch {
          // The datasource row shows why (plan 004); there is nothing to list.
          dependencies.collapse(key);
          return;
        }
        await list(id);
      },

      synchronize: list,

      setFilter(id, filter) {
        update(id, { filter });
      },

      clear(id) {
        bump(id);
        const { [id]: _gone, ...indices } = get().indices;
        set({ indices });
      },
    };
  });
}

export type IndicesStore = ReturnType<typeof createIndicesStore>;

export const useIndices = createIndicesStore({
  connect: (id) => useDatasources.getState().connect(id),
  expand: (keys) => useCatalog.getState().expandAll(keys),
  collapse: (key) => useCatalog.getState().setExpanded(key, false),
});
