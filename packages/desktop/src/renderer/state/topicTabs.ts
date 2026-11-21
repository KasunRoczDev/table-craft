import { create } from "zustand";
import type {
  Capability,
  EngineError,
  GroupSummary,
  SortKey,
  SpilledMessage,
  TopicDescription,
  TopicReadInfo,
  TopicReadRequest,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { carriedLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { clampSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import {
  DEFAULT_DRAFT,
  readCommandText,
  readRequestOf,
  toggledPartition,
  type ReadDraft,
} from "@table-craft/desktop/renderer/model/topicRead.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import {
  NO_EXECUTION_REPORTER,
  useExecutions,
  type ExecutionReporter,
} from "@table-craft/desktop/renderer/state/executions.js";
import { NO_EXPORTS, useExports, type ExportStarter } from "@table-craft/desktop/renderer/state/exports.js";
import {
  resultTabOf,
  searchedColumnsChanged,
  shownRowCount,
  type ResultTab,
} from "@table-craft/desktop/renderer/state/resultTab.js";
import { createResultWindows, toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import {
  currentFormats,
  currentPaging,
  currentSpill,
  statementTimeoutOf,
} from "@table-craft/desktop/renderer/state/settings.js";
import { streamCapabilities } from "@table-craft/desktop/renderer/state/streams.js";

/** Which topic a topic tab shows (plan 164 decision 5). */
export interface TopicTarget {
  readonly datasourceId: string;
  readonly topic: string;
}

export const TOPIC_VIEWS = ["messages", "partitions", "configs", "consumers"] as const;
export type TopicView = (typeof TOPIC_VIEWS)[number];

export type TopicTabStatus = "connecting" | "ready" | "loading" | "failed" | "disconnected";

export interface TopicTab extends TopicTarget {
  readonly sessionId: string | null;
  readonly status: TopicTabStatus;
  /** What went wrong reaching the server. */
  readonly error: EngineError | null;
  /** Why the last read was refused, by the read bar or the broker. */
  readonly queryError: EngineError | null;
  readonly view: TopicView;
  readonly description: TopicDescription | null;
  readonly describing: boolean;
  readonly describeError: EngineError | null;
  /** The groups with committed offsets on the topic; null until read or without `consumerGroups`. */
  readonly consumers: readonly GroupSummary[] | null;
  readonly draft: ReadDraft;
  /** The request the shown rows answer. */
  readonly applied: TopicReadRequest | null;
  /** The shown read's counters. */
  readonly read: TopicReadInfo | null;
  readonly result: ResultTab | null;
  /** What the last read's end said, such as a cancel; null when it just read. */
  readonly notice: string | null;
  /**
   * A group's committed offsets on this topic, by partition, when the read starts at them or the
   * tab was opened from the group: the rows at those offsets are that group's next records.
   */
  readonly committed: CommittedOffsets | null;
}

export interface CommittedOffsets {
  readonly group: string;
  readonly offsets: Readonly<Record<number, string>>;
}

/** The header tooltip of the `timestamp` column names its clock (audit M3): rows show UTC. */
export const TIMESTAMP_COLUMN = "timestamp";
export const TIMESTAMP_TYPE = "timestamp, UTC (ISO 8601)";
const CANCELLED_NOTICE = "Read cancelled; the rows of the previous read stay.";

type ResultWindows = ReturnType<typeof createResultWindows>;

export interface TopicTabsState {
  readonly tabs: Readonly<Record<string, TopicTab>>;
  /** Opens the tab and reads; `group` marks that group's committed offsets in what it reads. */
  readonly open: (id: string, target: TopicTarget, draft?: ReadDraft, group?: string) => Promise<void>;
  /** Stops the running read through the session's `cancel` (audit M5). */
  readonly cancel: (id: string) => Promise<void>;
  /** Reads `draft` now, as Read from Here and Search Earlier do; `group` marks that group's committed offsets instead. */
  readonly readWith: (id: string, change: Partial<ReadDraft>, group?: string) => Promise<boolean>;
  readonly close: (id: string) => void;
  readonly detach: (datasourceId: string, error: EngineError | null) => void;
  readonly setDraft: (id: string, change: Partial<ReadDraft>) => void;
  readonly setView: (id: string, view: TopicView) => void;
  /** Reads with the read bar's fields; false when it could not. */
  readonly read: (id: string) => Promise<boolean>;
  /** Continues the last read where its scan stopped. */
  readonly scanFurther: (id: string) => Promise<boolean>;
  /** Reads only `partition`, or every partition again when it was the only one read. */
  readonly selectPartition: (id: string, partition: number) => Promise<boolean>;
  /** Partitions, configs and consumers read again. */
  readonly describe: (id: string) => Promise<void>;
  readonly ensureWindow: ResultWindows["ensureWindow"];
  readonly fetchMore: ResultWindows["fetchMore"];
  readonly stopFetch: ResultWindows["stopFetch"];
  readonly sort: (id: string, resultId: string, keys: readonly SortKey[]) => Promise<void>;
  readonly setLayout: (id: string, resultId: string, layout: ResultTab["layout"]) => void;
  readonly select: (id: string, resultId: string, selection: ResultTab["selection"]) => void;
  readonly extract: ResultWindows["extract"];
  readonly aggregate: ResultWindows["aggregate"];
  readonly chart: ResultWindows["chart"];
  readonly setChart: ResultWindows["setChart"];
  readonly cellBytes: ResultWindows["cellBytes"];
  readonly saveBytes: ResultWindows["saveBytes"];
  readonly loadBytes: ResultWindows["loadBytes"];
  readonly exportTo: (...args: Parameters<ResultWindows["exportTo"]>) => Promise<boolean>;
  readonly search: ResultWindows["search"];
  readonly findNext: ResultWindows["findNext"];
  /**
   * The whole key, value and headers of a shown message, from the read's temporary file when it
   * was large (decision 172); null when the read is gone or no longer holds it.
   */
  readonly message: (id: string, partition: number, offset: string) => Promise<SpilledMessage | null>;
}

export interface TopicTabsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly capabilities: (datasourceId: string) => readonly Capability[];
  readonly clock?: () => number;
  readonly executions?: ExecutionReporter;
  readonly exports?: ExportStarter;
  readonly statementTimeout?: (datasourceId: string) => number;
  /** `data.spillMessages`, read at each read; true when absent. */
  readonly spill?: () => boolean;
}

const READ_LABEL = "Read topic";

export function canReadTopic(status: TopicTabStatus): boolean {
  return status !== "connecting" && status !== "loading";
}

function problemError(message: string): EngineError {
  return { code: "invalidRequest", message, hint: "" };
}

function newTab(target: TopicTarget, draft: ReadDraft): TopicTab {
  return {
    ...target,
    sessionId: null,
    status: "disconnected",
    error: null,
    queryError: null,
    view: "messages",
    description: null,
    describing: false,
    describeError: null,
    consumers: null,
    draft,
    applied: null,
    read: null,
    result: null,
    notice: null,
    committed: null,
  };
}

export function createTopicTabsStore(dependencies: TopicTabsDependencies) {
  const clients = new Map<string, EngineClient>();
  const lifetimes = new Map<string, symbol>();
  const clock = dependencies.clock ?? (() => Date.now());
  const executions = dependencies.executions ?? NO_EXECUTION_REPORTER;
  let resultIds = 0;

  return create<TopicTabsState>()((set, get) => {
    const windows = createResultWindows({
      client: (id) => clients.get(id),
      result: (id, resultId) => resultOf(id, resultId),
      update: (id, resultId, change) => updateResult(id, resultId, change),
      failed: (id, _result, error) => patch(id, { error }),
      fetched: () => undefined,
      datasourceOf: (id) => get().tabs[id]?.datasourceId,
      exports: dependencies.exports ?? NO_EXPORTS,
    });

    function patch(id: string, change: Partial<TopicTab>): void {
      const current = get().tabs[id];
      if (current === undefined) return;
      set({ tabs: { ...get().tabs, [id]: { ...current, ...change } } });
    }

    function resultOf(id: string, resultId: string): ResultTab | undefined {
      const result = get().tabs[id]?.result;
      return result?.id === resultId ? result : undefined;
    }

    function updateResult(id: string, resultId: string, change: (result: ResultTab) => ResultTab): void {
      const result = resultOf(id, resultId);
      if (result !== undefined) patch(id, { result: change(result) });
    }

    function release(id: string, result: ResultTab | null): void {
      if (result === null) return;
      windows.forget(result.id);
      if (!result.stale)
        void clients
          .get(id)
          ?.call("result.release", { handle: result.handle })
          .catch(() => undefined);
    }

    async function openSession(id: string): Promise<boolean> {
      const current = get().tabs[id];
      if (current === undefined) return false;
      const lifetime = lifetimes.get(id);
      patch(id, { status: "connecting", error: null });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const opened = await client.call("session.open", {});
        if (lifetimes.get(id) !== lifetime) {
          void client.call("session.close", { sessionId: opened.sessionId }).catch(() => undefined);
          return false;
        }
        clients.set(id, client);
        patch(id, { sessionId: opened.sessionId, status: "ready", error: null });
        return true;
      } catch (cause) {
        if (lifetimes.get(id) === lifetime) patch(id, { status: "failed", error: toError(cause) });
        return false;
      }
    }

    async function describe(id: string): Promise<void> {
      const current = get().tabs[id];
      if (current === undefined) return;
      const lifetime = lifetimes.get(id);
      patch(id, { describing: true });
      try {
        const client = await dependencies.connect(current.datasourceId);
        const groups = dependencies.capabilities(current.datasourceId).includes("consumerGroups");
        const [description, consumers] = await Promise.all([
          client.call("topics.describe", { topic: current.topic }),
          groups ? client.call("groups.consumersOf", { topic: current.topic }).catch(() => null) : null,
        ]);
        if (lifetimes.get(id) === lifetime)
          patch(id, { description, consumers, describing: false, describeError: null });
      } catch (cause) {
        if (lifetimes.get(id) === lifetime) patch(id, { describing: false, describeError: toError(cause) });
      }
    }

    async function run(id: string, request: TopicReadRequest, draft: ReadDraft): Promise<boolean> {
      const before = get().tabs[id];
      if (before === undefined || !canReadTopic(before.status)) return false;
      if (before.status !== "ready" && !(await openSession(id))) return false;
      const current = get().tabs[id];
      const client = clients.get(id);
      if (current?.sessionId == null || client === undefined) return false;
      const lifetime = lifetimes.get(id);
      const live = () => lifetimes.get(id) === lifetime && get().tabs[id]?.sessionId === current.sessionId;
      const command = readCommandText(request);
      patch(id, { status: "loading", error: null, queryError: null, notice: null, draft });
      const group = request.from.kind === "group" ? request.from.group : (current.committed?.group ?? null);
      if (group !== null) void markCommitted(id, group);
      const begun = clock();
      const executionId = executions.start(id, { label: READ_LABEL, sql: command, startedAt: begun });
      try {
        const paging = currentPaging();
        const timeoutSeconds = dependencies.statementTimeout?.(current.datasourceId) ?? 0;
        const answer = await client.call("topics.open", {
          sessionId: current.sessionId,
          request,
          ...paging,
          spill: dependencies.spill?.() ?? true,
          ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}),
        });
        executions.finish(id, executionId, {
          outcome: "success",
          rowCount: answer.statement.rowCount,
          message: null,
          durationMs: Math.max(0, clock() - begun),
        });
        if (!live()) {
          void client.call("result.release", { handle: answer.statement.handle }).catch(() => undefined);
          return false;
        }
        const previous = get().tabs[id]?.result ?? null;
        release(id, previous);
        const statement = {
          ...answer.statement,
          columns: answer.statement.columns.map((column) =>
            column.name === TIMESTAMP_COLUMN ? { ...column, type: TIMESTAMP_TYPE } : column,
          ),
        };
        const fresh = resultTabOf(
          statement,
          { id: `${id}/read-${String(++resultIds)}`, title: current.topic },
          command,
          paging,
          currentFormats(),
        );
        const names = (columns: readonly { readonly name: string }[]) => columns.map((column) => column.name);
        const layout =
          previous === null
            ? fresh.layout
            : carriedLayout(previous.layout, names(previous.columns), names(fresh.columns));
        patch(id, { result: { ...fresh, layout }, read: answer.read, applied: request, queryError: null });
        return true;
      } catch (cause) {
        const error = toError(cause);
        executions.finish(id, executionId, {
          outcome: error.code === "cancelled" ? "cancelled" : "error",
          rowCount: null,
          message: error.message,
          durationMs: Math.max(0, clock() - begun),
        });
        if (live()) {
          if (error.code === "cancelled") patch(id, { notice: CANCELLED_NOTICE });
          else if (error.code === "statementFailed" || error.code === "invalidRequest")
            patch(id, { queryError: error });
          else patch(id, { error });
        }
        return false;
      } finally {
        if (live()) {
          const status = get().tabs[id]?.status;
          patch(id, { status: status === "disconnected" || status === "failed" ? status : "ready" });
        }
      }
    }

    async function markCommitted(id: string, group: string): Promise<void> {
      const current = get().tabs[id];
      if (current === undefined || !dependencies.capabilities(current.datasourceId).includes("consumerGroups")) return;
      try {
        const client = await dependencies.connect(current.datasourceId);
        const described = await client.call("groups.describe", { group });
        const offsets: Record<number, string> = {};
        for (const offset of described.offsets)
          if (offset.topic === current.topic && offset.committed !== null) offsets[offset.partition] = offset.committed;
        patch(id, { committed: { group, offsets } });
      } catch {
        // Without the group's offsets the rows simply carry no marker.
      }
    }

    function readDraft(id: string, draft: ReadDraft): Promise<boolean> {
      const current = get().tabs[id];
      if (current === undefined) return Promise.resolve(false);
      const asked = readRequestOf(current.topic, draft);
      if ("problem" in asked) {
        patch(id, { draft, queryError: problemError(asked.problem) });
        return Promise.resolve(false);
      }
      return run(id, asked.request, draft);
    }

    return {
      tabs: {},

      async open(id, target, draft = DEFAULT_DRAFT, group) {
        lifetimes.set(id, Symbol());
        const tab = newTab(target, draft);
        set({
          tabs: { ...get().tabs, [id]: group === undefined ? tab : { ...tab, committed: { group, offsets: {} } } },
        });
        await Promise.all([describe(id), readDraft(id, draft)]);
      },

      close(id) {
        lifetimes.delete(id);
        const closing = get().tabs[id];
        if (closing === undefined) return;
        const { [id]: _closed, ...rest } = get().tabs;
        set({ tabs: rest });
        if (closing.result !== null) windows.forget(closing.result.id);
        const client = clients.get(id);
        clients.delete(id);
        if (closing.sessionId === null || client === undefined) return;
        void client.call("session.close", { sessionId: closing.sessionId }).catch(() => undefined);
      },

      detach(datasourceId, error) {
        for (const [id, tab] of Object.entries(get().tabs)) {
          if (tab.datasourceId !== datasourceId) continue;
          lifetimes.set(id, Symbol());
          clients.delete(id);
          if (tab.result !== null) windows.invalidate(tab.result.id);
          patch(id, {
            sessionId: null,
            status: error === null ? "disconnected" : "failed",
            error: error ?? tab.error,
            describing: false,
            result: tab.result === null ? null : { ...tab.result, stale: true, cursorOpen: false, fetching: null },
          });
        }
      },

      setDraft(id, change) {
        const current = get().tabs[id];
        if (current !== undefined) patch(id, { draft: { ...current.draft, ...change } });
      },

      setView(id, view) {
        if (get().tabs[id]?.view !== view) patch(id, { view });
      },

      read: (id) => {
        const current = get().tabs[id];
        return current === undefined ? Promise.resolve(false) : readDraft(id, current.draft);
      },

      scanFurther(id) {
        const current = get().tabs[id];
        const resume = current?.read?.resume ?? null;
        if (current?.applied == null || resume === null) return Promise.resolve(false);
        return run(id, { ...current.applied, resume }, current.draft);
      },

      selectPartition(id, partition) {
        const current = get().tabs[id];
        if (current === undefined) return Promise.resolve(false);
        return readDraft(id, { ...current.draft, partitions: toggledPartition(current.draft.partitions, partition) });
      },

      describe,

      async cancel(id) {
        const current = get().tabs[id];
        const client = clients.get(id);
        if (current?.sessionId == null || client === undefined || current.status !== "loading") return;
        await client.call("statement.cancel", { sessionId: current.sessionId }).catch(() => undefined);
      },

      readWith(id, change, group) {
        const current = get().tabs[id];
        if (current === undefined) return Promise.resolve(false);
        if (group !== undefined && current.committed?.group !== group) patch(id, { committed: { group, offsets: {} } });
        return readDraft(id, { ...current.draft, ...change });
      },

      ensureWindow: windows.ensureWindow,
      fetchMore: windows.fetchMore,
      stopFetch: windows.stopFetch,

      async sort(id, resultId, keys) {
        const result = resultOf(id, resultId);
        const client = clients.get(id);
        // Sorting is the engine's (decision 009); a closed connection's rows keep their order.
        if (result === undefined || client === undefined || result.stale) return;
        try {
          const state = await client.call("result.sort", { handle: result.handle, keys: [...keys] });
          windows.invalidate(resultId);
          updateResult(id, resultId, (latest) => ({
            ...latest,
            ...state,
            sort: keys,
            windows: {},
            matches: {},
            selection: null,
            search: { ...latest.search, current: null },
          }));
          await windows.refreshView(id, resultId);
        } catch (cause) {
          patch(id, { error: toError(cause) });
        }
      },

      setLayout(id, resultId, layout) {
        const before = resultOf(id, resultId);
        updateResult(id, resultId, (latest) => {
          const visible = layout.hidden.filter((hidden) => !hidden).length;
          const hiddenChanged = layout.hidden.some((hidden, index) => hidden !== latest.layout.hidden[index]);
          const selection = hiddenChanged
            ? null
            : clampSelection(latest.selection, { rows: shownRowCount(latest), columns: visible });
          return { ...latest, layout, selection };
        });
        if (before !== undefined && searchedColumnsChanged(before.layout, layout)) void windows.applyView(id, resultId);
      },

      select(id, resultId, selection) {
        updateResult(id, resultId, (latest) => (latest.selection === selection ? latest : { ...latest, selection }));
      },

      extract: windows.extract,
      aggregate: windows.aggregate,
      chart: windows.chart,
      setChart: windows.setChart,
      cellBytes: windows.cellBytes,
      saveBytes: windows.saveBytes,
      loadBytes: windows.loadBytes,
      async exportTo(...args) {
        return (await windows.exportTo(...args)) !== null;
      },
      search: windows.search,
      findNext: windows.findNext,

      async message(id, partition, offset) {
        const result = get().tabs[id]?.result;
        const client = clients.get(id);
        if (result == null || result.stale || client === undefined) return null;
        return client.call("topics.message", { handle: result.handle, partition, offset });
      },
    };
  });
}

export type TopicTabsStore = ReturnType<typeof createTopicTabsStore>;

export const useTopicTabs = createTopicTabsStore({
  connect: (datasourceId) => useDatasources.getState().connect(datasourceId),
  capabilities: streamCapabilities,
  exports: useExports.getState(),
  statementTimeout: (datasourceId) => statementTimeoutOf(datasourceById(useDatasources.getState(), datasourceId)),
  spill: currentSpill,
  executions: {
    start: (tabId, start) => useExecutions.getState().start(tabId, start),
    finish: (tabId, executionId, end) => useExecutions.getState().finish(tabId, executionId, end),
    recount: (tabId, executionId, rowCount) => useExecutions.getState().recount(tabId, executionId, rowCount),
  },
});

/** The topic tabs open on a datasource, by tab id. */
export function topicTabsOf(tabs: TopicTabsState["tabs"], datasourceId: string): readonly string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.datasourceId === datasourceId)
    .map(([id]) => id);
}
