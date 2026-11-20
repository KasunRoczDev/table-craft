import { create } from "zustand";
import type { Capability, ServerNode } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { datasourceKey, keyTreeKey } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  EMPTY_STREAMS,
  STREAM_SECTIONS,
  type DatasourceStreams,
} from "@table-craft/desktop/renderer/model/streamTree.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { useServer } from "@table-craft/desktop/renderer/state/server.js";

/** How often a write's follow-up listing is tried before it shows what the cluster lists. */
export const LISTED_ATTEMPTS = 6;
export const LISTED_RETRY_MS = 500;

/**
 * Lists until `listed` holds or the attempts run out, and says whether it held. Kafka answers
 * CreateTopics once the controller has the topic, before every broker's metadata names it, so the
 * first listing after a create can still lack it.
 */
export async function untilListed(
  list: () => Promise<void>,
  listed: () => boolean,
  wait: (ms: number) => Promise<void>,
  attempts: number = LISTED_ATTEMPTS,
): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    await list();
    if (listed()) return true;
    if (attempt >= attempts) return false;
    await wait(LISTED_RETRY_MS);
  }
}

export interface StreamsState {
  /** By datasource id; a datasource without an entry has listed nothing since it last attached. */
  readonly streams: Readonly<Record<string, DatasourceStreams>>;
  /** Expands the datasource and its sections, connecting it and listing them the first time. */
  readonly expandDatasource: (datasourceId: string) => Promise<void>;
  /** Lists topics, groups, brokers and subjects again. */
  readonly synchronize: (datasourceId: string) => Promise<void>;
  /** Forgets the datasource's lists; its engine is gone. */
  readonly clear: (datasourceId: string) => void;
}

export interface StreamsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly expand: (keys: readonly string[]) => void;
  readonly collapse: (key: string) => void;
  readonly capabilities: (datasourceId: string) => readonly Capability[];
  /** The datasource's brokers; empty unless its plugin declares `nodes`. */
  readonly nodes: (datasourceId: string) => Promise<readonly ServerNode[]>;
}

async function optional<T>(run: boolean, read: () => Promise<T>): Promise<T | null> {
  if (!run) return null;
  try {
    return await read();
  } catch {
    // A listing the datasource refuses (no ACL to describe groups, say) leaves its section out.
    return null;
  }
}

export function createStreamsStore(dependencies: StreamsDependencies) {
  /** Bumped by `clear`, so an answer from an engine that has since gone is dropped. */
  const generations = new Map<string, number>();
  const generationOf = (id: string) => generations.get(id) ?? 0;

  return create<StreamsState>()((set, get) => {
    function streamsOf(id: string): DatasourceStreams {
      return get().streams[id] ?? EMPTY_STREAMS;
    }

    function update(id: string, change: Partial<DatasourceStreams>): void {
      set({ streams: { ...get().streams, [id]: { ...streamsOf(id), ...change } } });
    }

    async function list(id: string): Promise<void> {
      const generation = generationOf(id);
      update(id, { loading: true, error: null });
      try {
        const client = await dependencies.connect(id);
        const capabilities = dependencies.capabilities(id);
        const [topics, groups, registry, brokers] = await Promise.all([
          client.call("topics.list", { glob: null, internal: true }),
          optional(capabilities.includes("consumerGroups"), () => client.call("groups.list", {})),
          optional(capabilities.includes("schemaRegistry"), () => client.call("schemas.status", {})),
          dependencies.nodes(id),
        ]);
        const subjects =
          registry?.available === true
            ? await optional(true, () => client.call("schemas.subjects", { glob: null }))
            : null;
        if (generationOf(id) !== generation) return;
        update(id, { topics, groups, registry, subjects, brokers, loading: false, error: null });
      } catch (cause) {
        if (generationOf(id) !== generation) return;
        update(id, { loading: false, error: toError(cause) });
      }
    }

    return {
      streams: {},

      async expandDatasource(id) {
        const key = datasourceKey(id);
        dependencies.expand([key, ...STREAM_SECTIONS.map((section) => keyTreeKey(id, "streamSection", section))]);
        const current = streamsOf(id);
        if (current.topics !== null || current.loading) return;
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

      clear(id) {
        generations.set(id, generationOf(id) + 1);
        const { [id]: _gone, ...streams } = get().streams;
        set({ streams });
      },
    };
  });
}

export type StreamsStore = ReturnType<typeof createStreamsStore>;

function capabilitiesOfDatasource(datasourceId: string): readonly Capability[] {
  const state = useDatasources.getState();
  const datasource = state.datasources.find((candidate) => candidate.id === datasourceId);
  return datasource === undefined ? [] : capabilitiesOf(state.plugins, datasource.pluginId);
}

export const useStreams = createStreamsStore({
  connect: (id) => useDatasources.getState().connect(id),
  expand: (keys) => useCatalog.getState().expandAll(keys),
  collapse: (key) => useCatalog.getState().setExpanded(key, false),
  capabilities: capabilitiesOfDatasource,
  nodes: async (id) => (capabilitiesOfDatasource(id).includes("nodes") ? useServer.getState().loadNodes(id) : []),
});

/** The capabilities a stream datasource declares, read now. */
export const streamCapabilities = capabilitiesOfDatasource;
