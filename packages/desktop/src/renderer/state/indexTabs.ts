import { create } from "zustand";
import type {
  AnalyzeStep,
  EngineError,
  SearchHistogram,
  SearchInfo,
  SearchRequest,
  SearchTargetDescription,
  SearchTargetKind,
  SortKey,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { carriedLayout } from "@table-craft/desktop/renderer/model/columnLayout.js";
import { clampSelection } from "@table-craft/desktop/renderer/model/gridSelection.js";
import {
  defaultDraft,
  EMPTY_SEARCH_DRAFT,
  HISTOGRAM_BUCKETS,
  searchRequestOf,
  type SearchDraft,
} from "@table-craft/desktop/renderer/model/indexSearch.js";
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
import { currentFormats, currentPaging, statementTimeoutOf } from "@table-craft/desktop/renderer/state/settings.js";

/** Which index, alias or data stream an index tab shows (plan 165). */
export interface IndexTarget {
  readonly datasourceId: string;
  readonly target: string;
}

export const INDEX_VIEWS = ["documents", "mapping", "settings", "analyze"] as const;
export type IndexView = (typeof INDEX_VIEWS)[number];

export type IndexTabStatus = "connecting" | "ready" | "loading" | "failed" | "disconnected";

export interface AnalyzeDraft {
  /** The field whose analyzer runs; null runs the index's default analyzer. */
  readonly field: string | null;
  readonly text: string;
}

export interface IndexTab extends IndexTarget {
  /** Null until described. */
  readonly kind: SearchTargetKind | null;
  readonly sessionId: string | null;
  readonly status: IndexTabStatus;
  /** What went wrong reaching the server. */
  readonly error: EngineError | null;
  /** Why the last search was refused, by the query bar or the cluster. */
  readonly queryError: EngineError | null;
  readonly view: IndexView;
  readonly description: SearchTargetDescription | null;
  readonly describing: boolean;
  readonly describeError: EngineError | null;
  readonly draft: SearchDraft;
  /** The request the shown rows answer. */
  readonly applied: SearchRequest | null;
  /** The shown search's total, timing, shards and the request it sent. */
  readonly search: SearchInfo | null;
  readonly result: ResultTab | null;
  /** Hits over time for the applied request; null without a time field. */
  readonly histogram: SearchHistogram | null;
  readonly analyzeDraft: AnalyzeDraft;
  readonly analysis: readonly AnalyzeStep[] | null;
  readonly analyzing: boolean;
  readonly analyzeError: EngineError | null;
  /** What the last search's end said, such as a cancel; null when it just ran. */
  readonly notice: string | null;
}

const CANCELLED_NOTICE = "Search cancelled; the hits of the previous search stay.";
const SEARCH_LABEL = "Search index";

type ResultWindows = ReturnType<typeof createResultWindows>;

export interface IndexTabsState {
  readonly tabs: Readonly<Record<string, IndexTab>>;
  /** Opens the tab, describes the target, then searches it with the draft its time field suggests. */
  readonly open: (id: string, target: IndexTarget) => Promise<void>;
  /** Stops the running search through the session's `cancel`. */
  readonly cancel: (id: string) => Promise<void>;
  readonly close: (id: string) => void;
  readonly detach: (datasourceId: string, error: EngineError | null) => void;
  readonly setDraft: (id: string, change: Partial<SearchDraft>) => void;
  readonly setView: (id: string, view: IndexView) => void;
  /** Searches with the query bar's fields; false when it could not. */
  readonly run: (id: string) => Promise<boolean>;
  /** Describes the target again, then searches. */
  readonly refresh: (id: string) => Promise<void>;
  readonly describe: (id: string) => Promise<void>;
  readonly setAnalyzeDraft: (id: string, change: Partial<AnalyzeDraft>) => void;
  /** Runs the analyze draft and keeps each step's tokens. */
  readonly analyze: (id: string) => Promise<void>;
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
}

export interface IndexTabsDependencies {
  readonly connect: (datasourceId: string) => Promise<EngineClient>;
  readonly clock?: () => number;
  readonly executions?: ExecutionReporter;
  readonly exports?: ExportStarter;
  readonly statementTimeout?: (datasourceId: string) => number;
}

export function canSearchIndex(status: IndexTabStatus): boolean {
  return status !== "connecting" && status !== "loading";
}

/** What the Services tree and history show for a search: `GET orders/_search status:paid`. */
export function searchCommandText(request: SearchRequest): string {
  const query = request.query === "" ? "" : ` ${request.query}`;
  return `GET ${request.target}/_search${query}`;
}

function newTab(target: IndexTarget): IndexTab {
  return {
    ...target,
    kind: null,
    sessionId: null,
    status: "disconnected",
    error: null,
    queryError: null,
    view: "documents",
    description: null,
    describing: false,
    describeError: null,
    draft: EMPTY_SEARCH_DRAFT,
    applied: null,
    search: null,
    result: null,
    histogram: null,
    analyzeDraft: { field: null, text: "" },
    analysis: null,
    analyzing: false,
    analyzeError: null,
    notice: null,
  };
}

export function createIndexTabsStore(dependencies: IndexTabsDependencies) {
  const clients = new Map<string, EngineClient>();
  const lifetimes = new Map<string, symbol>();
  const clock = dependencies.clock ?? (() => Date.now());
  const executions = dependencies.executions ?? NO_EXECUTION_REPORTER;
  let resultIds = 0;

  return create<IndexTabsState>()((set, get) => {
    const windows = createResultWindows({
      client: (id) => clients.get(id),
      result: (id, resultId) => resultOf(id, resultId),
      update: (id, resultId, change) => updateResult(id, resultId, change),
      failed: (id, _result, error) => patch(id, { error }),
      fetched: () => undefined,
      datasourceOf: (id) => get().tabs[id]?.datasourceId,
      exports: dependencies.exports ?? NO_EXPORTS,
    });

    function patch(id: string, change: Partial<IndexTab>): void {
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
        const description = await client.call("indices.describe", { target: current.target });
        if (lifetimes.get(id) !== lifetime) return;
        const latest = get().tabs[id]?.analyzeDraft;
        const field = latest?.field ?? null;
        patch(id, {
          description,
          kind: description.kind,
          describing: false,
          describeError: null,
          analyzeDraft: {
            text: latest?.text ?? "",
            field: field !== null && description.fields.some((known) => known.path === field) ? field : null,
          },
        });
      } catch (cause) {
        if (lifetimes.get(id) === lifetime) patch(id, { describing: false, describeError: toError(cause) });
      }
    }

    async function histogramOf(client: EngineClient, request: SearchRequest): Promise<SearchHistogram | null> {
      try {
        return await client.call("indices.histogram", { request, buckets: HISTOGRAM_BUCKETS });
      } catch {
        // The strip is a summary; the hits stand without it.
        return null;
      }
    }

    async function execute(id: string, draft: SearchDraft): Promise<boolean> {
      const before = get().tabs[id];
      if (before === undefined || !canSearchIndex(before.status)) return false;
      if (before.status !== "ready" && !(await openSession(id))) return false;
      const current = get().tabs[id];
      const client = clients.get(id);
      if (current?.sessionId == null || client === undefined) return false;
      const lifetime = lifetimes.get(id);
      const live = () => lifetimes.get(id) === lifetime && get().tabs[id]?.sessionId === current.sessionId;
      const paging = currentPaging();
      const timeField = current.description?.timeField ?? null;
      const request = searchRequestOf(current.target, draft, timeField, paging.pageRows, clock());
      const command = searchCommandText(request);
      patch(id, { status: "loading", error: null, queryError: null, notice: null, draft });
      const begun = clock();
      const executionId = executions.start(id, { label: SEARCH_LABEL, sql: command, startedAt: begun });
      try {
        const timeoutSeconds = dependencies.statementTimeout?.(current.datasourceId) ?? 0;
        const [answer, histogram] = await Promise.all([
          client.call("indices.open", {
            sessionId: current.sessionId,
            request,
            ...paging,
            ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}),
          }),
          timeField === null ? Promise.resolve(null) : histogramOf(client, request),
        ]);
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
        const fresh = resultTabOf(
          answer.statement,
          { id: `${id}/search-${String(++resultIds)}`, title: current.target },
          answer.search.request,
          paging,
          currentFormats(),
        );
        const names = (columns: readonly { readonly name: string }[]) => columns.map((column) => column.name);
        const layout =
          previous === null
            ? fresh.layout
            : carriedLayout(previous.layout, names(previous.columns), names(fresh.columns));
        patch(id, {
          result: { ...fresh, layout },
          search: answer.search,
          histogram,
          applied: request,
          queryError: null,
        });
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

    return {
      tabs: {},

      async open(id, target) {
        lifetimes.set(id, Symbol());
        set({ tabs: { ...get().tabs, [id]: newTab(target) } });
        await describe(id);
        const described = get().tabs[id];
        if (described === undefined) return;
        await execute(id, defaultDraft(described.description));
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
            analyzing: false,
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

      run(id) {
        const current = get().tabs[id];
        return current === undefined ? Promise.resolve(false) : execute(id, current.draft);
      },

      async refresh(id) {
        await describe(id);
        const current = get().tabs[id];
        if (current !== undefined) await execute(id, current.draft);
      },

      describe,

      setAnalyzeDraft(id, change) {
        const current = get().tabs[id];
        if (current !== undefined) patch(id, { analyzeDraft: { ...current.analyzeDraft, ...change } });
      },

      async analyze(id) {
        const current = get().tabs[id];
        if (current === undefined || current.analyzing) return;
        const lifetime = lifetimes.get(id);
        patch(id, { analyzing: true, analyzeError: null });
        try {
          const client = await dependencies.connect(current.datasourceId);
          const analysis = await client.call("indices.analyze", {
            request: {
              target: current.target,
              field: current.analyzeDraft.field,
              analyzer: null,
              text: current.analyzeDraft.text,
            },
          });
          if (lifetimes.get(id) === lifetime) patch(id, { analysis, analyzing: false });
        } catch (cause) {
          if (lifetimes.get(id) === lifetime) patch(id, { analyzing: false, analyzeError: toError(cause) });
        }
      },

      async cancel(id) {
        const current = get().tabs[id];
        const client = clients.get(id);
        if (current?.sessionId == null || client === undefined || current.status !== "loading") return;
        await client.call("statement.cancel", { sessionId: current.sessionId }).catch(() => undefined);
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
    };
  });
}

export type IndexTabsStore = ReturnType<typeof createIndexTabsStore>;

export const useIndexTabs = createIndexTabsStore({
  connect: (datasourceId) => useDatasources.getState().connect(datasourceId),
  exports: useExports.getState(),
  statementTimeout: (datasourceId) => statementTimeoutOf(datasourceById(useDatasources.getState(), datasourceId)),
  executions: {
    start: (tabId, start) => useExecutions.getState().start(tabId, start),
    finish: (tabId, executionId, end) => useExecutions.getState().finish(tabId, executionId, end),
    recount: (tabId, executionId, rowCount) => useExecutions.getState().recount(tabId, executionId, rowCount),
  },
});

/** The index tabs open on a datasource, by tab id. */
export function indexTabsOf(tabs: IndexTabsState["tabs"], datasourceId: string): readonly string[] {
  return Object.entries(tabs)
    .filter(([, tab]) => tab.datasourceId === datasourceId)
    .map(([id]) => id);
}
