import type { SearchInfo, SearchTarget } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { INDEX_ACTION_IDS } from "@table-craft/desktop/renderer/actions/indexActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { ResultGrid } from "@table-craft/desktop/renderer/grid/ResultGrid.js";
import {
  AnalyzeView,
  HistogramStrip,
  MappingView,
  SettingsView,
} from "@table-craft/desktop/renderer/indices/IndexViews.js";
import { SearchBar } from "@table-craft/desktop/renderer/indices/SearchBar.js";
import { hitsText } from "@table-craft/desktop/renderer/model/indexSearch.js";
import { healthTone, searchTargetFacts } from "@table-craft/desktop/renderer/model/indexTree.js";
import {
  useIndexTabs,
  type IndexTab as IndexTabState,
  type IndexView,
} from "@table-craft/desktop/renderer/state/indexTabs.js";
import { useIndices } from "@table-craft/desktop/renderer/state/indices.js";
import { ObjectHeader, Subtabs } from "@table-craft/desktop/renderer/streams/ObjectHeader.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { LINK_BUTTON } from "@table-craft/desktop/renderer/ui/linkClasses.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";

const KIND_LABELS = { index: "Index", alias: "Alias", dataStream: "Data stream" } as const;
const FALLBACK_KIND = "Index";
const STATUS_TEXT = {
  connecting: "Connecting…",
  loading: "Searching…",
  ready: "",
  failed: "",
  disconnected: "Disconnected; Run reconnects.",
} as const;
const STALE_TEXT = "The connection closed; Run searches again.";
const ERROR_CLASS = "shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger";
const HEALTH_CLASS = { warning: "text-warning", danger: "text-danger" } as const;
const VIEWS: readonly { readonly value: IndexView; readonly label: string }[] = [
  { value: "documents", label: "Documents" },
  { value: "mapping", label: "Mapping" },
  { value: "settings", label: "Settings" },
  { value: "analyze", label: "Analyze" },
];

function plural(count: number, singular: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : many}`;
}

function Facts({ tab, listed }: { readonly tab: IndexTabState; readonly listed: SearchTarget | null }) {
  if (tab.description === null)
    return <span>{tab.describeError === null ? "Reading the mapping…" : tab.describeError.message}</span>;
  const tone = healthTone(listed?.health ?? null);
  return (
    <>
      {searchTargetFacts(listed, tab.description.indices)}
      {tone === null || listed?.health == null ? null : (
        <span data-testid="index-health" className={HEALTH_CLASS[tone]}>
          {" · "}
          <WarningIcon aria-hidden weight="fill" className="inline size-3 align-[-1px]" /> {listed.health}
        </span>
      )}
      {tab.description.timeField === null ? null : (
        <>
          {" "}
          · time field <b className="font-normal text-ink">{tab.description.timeField}</b>
        </>
      )}
    </>
  );
}

function SearchWarnings({ warnings }: { readonly warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <span
      data-testid="index-warnings"
      className="flex shrink-0 items-center gap-1 text-warning"
      title={warnings.join("\n")}
    >
      <WarningIcon aria-hidden weight="fill" className="size-3" />
      <span className="tabular-nums">{warnings.length}</span>
      <span className="sr-only">{warnings.length === 1 ? "warning" : "warnings"}</span>
    </span>
  );
}

function ShardsText({ shards }: { readonly shards: SearchInfo["shards"] }) {
  return (
    <span data-testid="index-shards" className="shrink-0 tabular-nums">
      {plural(shards.total, "shard", "shards")}
      {shards.skipped > 0 ? `, ${shards.skipped.toLocaleString("en-US")} skipped` : null}
      {shards.failed > 0 ? (
        <span className="text-warning">, {shards.failed.toLocaleString("en-US")} failed</span>
      ) : null}
    </span>
  );
}

function Footer({ tab }: { readonly tab: IndexTabState }) {
  const { search } = tab;
  return (
    <div
      data-testid="index-footer"
      className="flex h-row shrink-0 items-center gap-gap overflow-hidden border-t border-line bg-panel px-gap whitespace-nowrap text-ink-muted"
    >
      {search === null ? null : (
        <>
          <span data-testid="index-hits" className="shrink-0 text-ink tabular-nums">
            {hitsText(tab.result?.rowCount ?? 0, search.total)}
          </span>
          <span className="shrink-0 tabular-nums">· took {search.tookMs.toLocaleString("en-US")} ms ·</span>
          <ShardsText shards={search.shards} />
          <SearchWarnings warnings={search.warnings} />
        </>
      )}
      {tab.notice === null ? null : (
        <span role="status" data-testid="index-notice" className="min-w-0 truncate text-warning">
          {tab.notice}
        </span>
      )}
      <span className="min-w-0 truncate">{STATUS_TEXT[tab.status]}</span>
    </div>
  );
}

function Documents({ tabId, tab }: { readonly tabId: string; readonly tab: IndexTabState }) {
  const { result } = tab;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SearchBar tabId={tabId} tab={tab} />
      {tab.queryError === null ? null : (
        <div role="alert" data-testid="query-error" className={ERROR_CLASS}>
          {tab.queryError.message} <span className="text-ink-muted">{tab.queryError.hint}</span>
        </div>
      )}
      {tab.histogram === null ? null : <HistogramStrip histogram={tab.histogram} />}
      {result === null ? (
        <div className="flex flex-1 items-center justify-center text-ink-muted">
          {tab.status === "loading" || tab.status === "connecting" || tab.describing
            ? "Searching…"
            : "Run a search to see documents."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ResultGrid ownerId={tabId} result={result} host={useIndexTabs.getState} staleText={STALE_TEXT} />
        </div>
      )}
      <Footer tab={tab} />
    </div>
  );
}

function DescribeState({ tab }: { readonly tab: IndexTabState }) {
  if (tab.describeError === null) return <p className="px-pane-inset py-gap text-ink-muted">Reading the mapping…</p>;
  return (
    <p role="alert" data-testid="index-describe-error" className="px-pane-inset py-gap break-words text-danger">
      {tab.describeError.message} <span className="text-ink-muted">{tab.describeError.hint}</span>{" "}
      <button type="button" className={LINK_BUTTON} onClick={() => void invoke(INDEX_ACTION_IDS.refresh)}>
        Retry
      </button>
    </p>
  );
}

/** An index, alias or data stream's tab (plan 165): its facts, then Documents, Mapping, Settings and Analyze. */
export function IndexTab({ tabId }: { readonly tabId: string }) {
  const tab = useIndexTabs((state) => state.tabs[tabId]);
  const datasource = useConsoleDatasource(tabId);
  const listed = useIndices((state) =>
    tab === undefined
      ? null
      : (state.indices[tab.datasourceId]?.targets?.find((target) => target.name === tab.target) ?? null),
  );
  if (tab === undefined) return null;
  const color = datasource?.color ?? null;
  const kind = tab.kind ?? listed?.kind ?? null;
  return (
    <div
      data-testid="index-tab"
      data-color={color ?? undefined}
      {...{ [REGION_ATTRIBUTE]: "tableEditor" }}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <ObjectHeader
        testId="index-header"
        kind={kind === null ? FALLBACK_KIND : KIND_LABELS[kind]}
        name={tab.target}
        scope={datasource?.name}
        facts={<Facts tab={tab} listed={listed} />}
        actions={<ActionButton actionId={INDEX_ACTION_IDS.refresh} compact />}
      />
      <Subtabs
        label="Index views"
        views={VIEWS}
        value={tab.view}
        onSelect={(view) => void invoke(INDEX_ACTION_IDS.showView, { view })}
      />
      {tab.error === null ? null : (
        <div role="alert" data-testid="index-error" className={ERROR_CLASS}>
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      {tab.view === "documents" ? (
        <Documents tabId={tabId} tab={tab} />
      ) : tab.description === null ? (
        <DescribeState tab={tab} />
      ) : tab.view === "mapping" ? (
        <MappingView description={tab.description} />
      ) : tab.view === "settings" ? (
        <SettingsView description={tab.description} />
      ) : (
        <AnalyzeView tabId={tabId} tab={tab} />
      )}
    </div>
  );
}
