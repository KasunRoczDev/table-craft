import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { TOPIC_ACTION_IDS } from "@table-craft/desktop/renderer/actions/topicActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { ResultGrid } from "@table-craft/desktop/renderer/grid/ResultGrid.js";
import {
  approxCount,
  DEFAULT_LAG_WARNING,
  lagWarningOf,
  nounFor,
} from "@table-craft/desktop/renderer/model/streamTree.js";
import {
  footerAction,
  scannedScope,
  scannedText,
  searchesOnlyNewest,
  topicFacts,
} from "@table-craft/desktop/renderer/model/topicRead.js";
import { GROUP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/groupActions.js";
import { useStreamReasons } from "@table-craft/desktop/renderer/streams/reasons.js";
import { MessagePanel } from "@table-craft/desktop/renderer/topics/MessagePanel.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useStreams } from "@table-craft/desktop/renderer/state/streams.js";
import {
  useTopicTabs,
  type TopicTab as TopicTabState,
  type TopicTarget,
  type TopicView,
} from "@table-craft/desktop/renderer/state/topicTabs.js";
import { ObjectHeader, Subtabs } from "@table-craft/desktop/renderer/streams/ObjectHeader.js";
import { TAIL_ACTION_IDS } from "@table-craft/desktop/renderer/tail/actions.js";
import { PartitionStrip } from "@table-craft/desktop/renderer/topics/PartitionStrip.js";
import { ReadBar } from "@table-craft/desktop/renderer/topics/ReadBar.js";
import { ConfigsView, ConsumersView, PartitionsView } from "@table-craft/desktop/renderer/topics/TopicViews.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { LINK_BUTTON } from "@table-craft/desktop/renderer/ui/linkClasses.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";

const STATUS_TEXT = {
  connecting: "Connecting…",
  loading: "Reading…",
  ready: "",
  failed: "",
  disconnected: "Disconnected; Read reconnects.",
} as const;
const STALE_TEXT = "The connection closed; Read reads the topic again.";
const ERROR_CLASS = "shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger";

function Facts({ tab }: { readonly tab: TopicTabState }) {
  if (tab.description === null)
    return <span>{tab.describeError === null ? "Reading partitions…" : tab.describeError.message}</span>;
  const facts = topicFacts(tab.description);
  const messages = approxCount(facts.messages);
  return (
    <>
      <b className="font-normal text-ink">{facts.partitions}</b> {nounFor(facts.partitions, "partition")}
      {facts.replication === null ? null : (
        <>
          {" "}
          · replication <b className="font-normal text-ink">{facts.replication}</b>
        </>
      )}
      {messages === null ? null : (
        <>
          {" "}
          · <b className="font-normal text-ink">{messages}</b> {nounFor(messages, "message")}, estimated
        </>
      )}
      {facts.retention === null ? null : (
        <>
          {" "}
          · retention <b className="font-normal text-ink">{facts.retention}</b>
        </>
      )}
      {facts.underReplicated.length === 0 ? null : (
        <span className="text-warning">
          {" · "}
          <WarningIcon aria-hidden weight="fill" className="inline size-3 align-[-1px]" /> partition{" "}
          {facts.underReplicated.join(", ")} under-replicated
        </span>
      )}
    </>
  );
}

const FOOTER_ACTIONS = {
  searchEarlier: {
    actionId: TOPIC_ACTION_IDS.searchEarlier,
    label: "Search Earlier",
    testId: "topic-search-earlier",
    title: "Read again from the earliest message of each partition, with the same filter",
  },
  scanFurther: {
    actionId: TOPIC_ACTION_IDS.scanFurther,
    label: "Scan Further",
    testId: "topic-scan-further",
    title: "Read on from where this read stopped",
  },
} as const;

function ReadWarnings({ warnings }: { readonly warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <span
      data-testid="topic-warnings"
      className="flex shrink-0 items-center gap-1 text-warning"
      title={warnings.join("\n")}
    >
      <WarningIcon aria-hidden weight="fill" className="size-3" />
      <span className="tabular-nums">{warnings.length}</span>
      <span className="sr-only">{warnings.length === 1 ? "warning" : "warnings"}</span>
    </span>
  );
}

function Footer({ tab }: { readonly tab: TopicTabState }) {
  const rows = tab.result?.rowCount ?? 0;
  const newest = searchesOnlyNewest(tab.applied);
  const filtered = tab.applied?.filter != null;
  const read = tab.read;
  const next = read === null ? null : footerAction(read, newest);
  const action = next === null ? null : FOOTER_ACTIONS[next];
  return (
    <div
      data-testid="topic-footer"
      className="flex h-row shrink-0 items-center gap-gap overflow-hidden border-t border-line bg-panel px-gap whitespace-nowrap text-ink-muted"
    >
      {read === null ? null : (
        <span
          data-testid="topic-scanned"
          className="shrink-0 text-ink tabular-nums"
          title={scannedScope(read, filtered, newest)}
        >
          {scannedText(read, filtered, rows)}
        </span>
      )}
      {action === null ? null : (
        <button
          type="button"
          data-testid={action.testId}
          className={cn(LINK_BUTTON, "shrink-0")}
          title={action.title}
          onClick={() => void invoke(action.actionId)}
        >
          {action.label}
        </button>
      )}
      {read === null ? null : <ReadWarnings warnings={read.warnings} />}
      {tab.notice === null ? null : (
        <span role="status" data-testid="topic-notice" className="min-w-0 truncate text-warning">
          {tab.notice}
        </span>
      )}
      <span className="min-w-0 truncate">{STATUS_TEXT[tab.status]}</span>
    </div>
  );
}

/** What the tab's own buttons act on, whatever the Database tree selects. */
function targetOf(tab: TopicTabState): TopicTarget {
  return { datasourceId: tab.datasourceId, topic: tab.topic };
}

function Messages({
  tabId,
  tab,
  registry,
  groups,
  writeReason,
}: {
  readonly tabId: string;
  readonly tab: TopicTabState;
  readonly registry: boolean;
  readonly groups: boolean;
  readonly writeReason: string | null;
}) {
  const result = tab.result;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ReadBar tabId={tabId} tab={tab} registry={registry} groups={groups} />
      {tab.queryError === null ? null : (
        <div role="alert" data-testid="query-error" className={ERROR_CLASS}>
          {tab.queryError.message} <span className="text-ink-muted">{tab.queryError.hint}</span>
        </div>
      )}
      {result === null || tab.description === null ? null : (
        <PartitionStrip
          result={result}
          partitions={tab.description.partitions.length}
          only={tab.applied?.partitions ?? null}
        />
      )}
      {result === null ? (
        <div className="flex flex-1 items-center justify-center text-ink-muted">
          {tab.status === "loading" || tab.status === "connecting" ? "Reading messages…" : "Read to see messages."}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <ResultGrid
              ownerId={tabId}
              result={result}
              host={useTopicTabs.getState}
              staleText={STALE_TEXT}
              panel={(focus) => <MessagePanel tabId={tabId} tab={tab} focus={focus} />}
              toolbar={
                <>
                  <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                  <ActionButton actionId={TOPIC_ACTION_IDS.scanFurther} compact />
                  <ActionButton
                    actionId={TOPIC_ACTION_IDS.produceFromRow}
                    compact
                    args={targetOf(tab)}
                    reason={writeReason}
                  />
                  <ActionButton actionId={GROUP_ACTION_IDS.skipFromRow} compact reason={writeReason} />
                </>
              }
            />
          </div>
        </div>
      )}
      <Footer tab={tab} />
    </div>
  );
}

/** A topic's tab (plan 164 decision 5): its facts, then Messages, Partitions, Configs and Consumers. */
export function TopicTab({ tabId }: { readonly tabId: string }) {
  const tab = useTopicTabs((state) => state.tabs[tabId]);
  const datasource = useConsoleDatasource(tabId);
  const capabilities = useDatasources((state) =>
    datasource === undefined ? [] : capabilitiesOf(state.plugins, datasource.pluginId),
  );
  const registry = useStreams((state) =>
    datasource === undefined ? false : state.streams[datasource.id]?.registry?.available === true,
  );
  const reasons = useStreamReasons(datasource);
  if (tab === undefined) return null;
  const target = targetOf(tab);
  const color = datasource?.color ?? null;
  const groups = capabilities.includes("consumerGroups");
  const views: readonly { readonly value: TopicView; readonly label: string; readonly count?: number | null }[] = [
    { value: "messages", label: "Messages" },
    { value: "partitions", label: "Partitions", count: tab.description?.partitions.length ?? null },
    { value: "configs", label: "Configs" },
    ...(groups ? [{ value: "consumers" as const, label: "Consumers", count: tab.consumers?.length ?? null }] : []),
  ];
  return (
    <div
      data-testid="topic-tab"
      data-color={color ?? undefined}
      {...{ [REGION_ATTRIBUTE]: "tableEditor" }}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <ObjectHeader
        testId="topic-header"
        kind="Topic"
        name={tab.topic}
        scope={datasource?.name}
        facts={<Facts tab={tab} />}
        actions={
          <>
            <ActionButton actionId={TOPIC_ACTION_IDS.refresh} compact reason={reasons.read} />
            <ActionButton actionId={TAIL_ACTION_IDS.start} compact args={target} reason={reasons.read} />
            <ActionButton
              actionId={TOPIC_ACTION_IDS.produce}
              compact
              args={target}
              reason={reasons.write}
              testId="topic-produce"
            />
          </>
        }
      />
      <Subtabs
        label="Topic views"
        views={views}
        value={tab.view}
        onSelect={(view) => void invoke(TOPIC_ACTION_IDS.showView, { view })}
      />
      {tab.error === null ? null : (
        <div role="alert" data-testid="topic-error" className={ERROR_CLASS}>
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      {tab.view === "messages" ? (
        <Messages tabId={tabId} tab={tab} registry={registry} groups={groups} writeReason={reasons.write} />
      ) : tab.description === null ? (
        <p className="px-pane-inset py-gap text-ink-muted">
          {tab.describeError === null ? "Reading the topic…" : tab.describeError.message}
        </p>
      ) : tab.view === "partitions" ? (
        <PartitionsView target={target} description={tab.description} writeReason={reasons.write} />
      ) : tab.view === "configs" ? (
        <ConfigsView target={target} description={tab.description} writeReason={reasons.write} />
      ) : (
        <ConsumersView
          datasourceId={tab.datasourceId}
          topic={tab.topic}
          consumers={tab.consumers}
          lagWarning={datasource === undefined ? DEFAULT_LAG_WARNING : lagWarningOf(datasource.config)}
        />
      )}
    </div>
  );
}
