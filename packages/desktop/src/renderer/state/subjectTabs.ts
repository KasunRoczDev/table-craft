import { create } from "zustand";
import type { EngineError, SchemaVersion } from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

/** Which Schema Registry subject a subject tab shows (plan 164 Phase 6, audit m12). */
export interface SubjectTarget {
  readonly datasourceId: string;
  readonly subject: string;
}

export interface SubjectTab extends SubjectTarget {
  /** Oldest first; null until read. */
  readonly versions: readonly number[] | null;
  readonly selected: number | null;
  readonly schema: SchemaVersion | null;
  /** The subject's compatibility level, or the registry's when it sets none. */
  readonly level: string | null;
  readonly loading: boolean;
  readonly error: EngineError | null;
}

export interface SubjectTabsState {
  readonly tabs: Readonly<Record<string, SubjectTab>>;
  readonly open: (id: string, target: SubjectTarget) => Promise<void>;
  /** Lists the versions again and shows the selected one, or the latest. */
  readonly refresh: (id: string) => Promise<void>;
  readonly select: (id: string, version: number) => Promise<void>;
  readonly close: (id: string) => void;
  /** Drops the reads in flight on a datasource whose engine went away; the tabs keep what they show. */
  readonly detach: (datasourceId: string) => void;
}

export function createSubjectTabsStore(connect: (datasourceId: string) => Promise<EngineClient>) {
  const reads = new Map<string, number>();
  let readCount = 0;
  return create<SubjectTabsState>()((set, get) => {
    function patch(id: string, change: Partial<SubjectTab>): void {
      const current = get().tabs[id];
      if (current !== undefined) set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    async function load(id: string, version: number | null): Promise<void> {
      const tab = get().tabs[id];
      if (tab === undefined) return;
      const token = ++readCount;
      reads.set(id, token);
      patch(id, { loading: true });
      try {
        const client = await connect(tab.datasourceId);
        const [versions, level] = await Promise.all([
          client.call("schemas.versions", { subject: tab.subject }),
          client.call("schemas.compatibility", { subject: tab.subject, level: null }).catch(() => null),
        ]);
        const chosen = version !== null && versions.includes(version) ? version : (versions.at(-1) ?? null);
        const schema =
          chosen === null ? null : await client.call("schemas.get", { subject: tab.subject, version: chosen });
        if (reads.get(id) === token)
          patch(id, { versions, level, selected: chosen, schema, loading: false, error: null });
      } catch (cause) {
        if (reads.get(id) === token) patch(id, { loading: false, error: toError(cause) });
      }
    }

    return {
      tabs: {},
      async open(id, target) {
        const tab: SubjectTab = {
          ...target,
          versions: null,
          selected: null,
          schema: null,
          level: null,
          loading: false,
          error: null,
        };
        set({ tabs: { ...get().tabs, [id]: tab } });
        await load(id, null);
      },
      refresh: (id) => load(id, get().tabs[id]?.selected ?? null),
      select: (id, version) => load(id, version),
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

export const useSubjectTabs = createSubjectTabsStore((id) => useDatasources.getState().connect(id));

/** The subject tabs open on a datasource, by tab id. */
export function subjectTabsOf(tabs: SubjectTabsState["tabs"], datasourceId: string): readonly string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.datasourceId === datasourceId)
    .map(([id]) => id);
}

/** A schema's text laid out: JSON schemas indented, Protobuf as written. */
export function schemaText(schema: SchemaVersion | null): string {
  if (schema === null) return "";
  if (schema.type === "PROTOBUF") return schema.schema;
  try {
    return JSON.stringify(JSON.parse(schema.schema), null, 2);
  } catch {
    return schema.schema;
  }
}
