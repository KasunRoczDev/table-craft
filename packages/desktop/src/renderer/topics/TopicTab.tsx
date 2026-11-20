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
import { scannedText, searchesOnlyNewest, topicFacts } from "@table-craft/desktop/renderer/model/topicRead.js";
import { GROUP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/groupActions.js";
import { useStreamReasons } from "@table-craft/desktop/renderer/streams/reasons.js";
import { MessagePanel } from "@table-craft/desktop/renderer/topics/MessagePanel.js";
import { capabilitiesOf, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useStreams } from "@table-craft/desktop/renderer/state/streams.js";
import {
  useTopicTabs,
  type TopicTab as TopicTabState,
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
/** Decision 4: the footer says so, since a reader would otherwise wonder whether browsing moved a group. */
const NO_GROUP_TEXT = "No group joined";

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

function Footer({ tab }: { readonly tab: TopicTabState }) {
  const rows = tab.result?.rowCount ?? 0;
  const newest = searchesOnlyNewest(tab.applied);
  return (
    <div
      data-testid="topic-footer"
      className="flex h-row shrink-0 items-center gap-gap overflow-hidden border-t border-line bg-panel px-gap whitespace-nowrap text-ink-muted"
    >
      {tab.read === null ? null : (
        <span data-testid="topic-scanned" className="text-ink">
          {scannedText(tab.read, tab.applied?.filter != null, rows, newest)}
        </span>
      )}
      {tab.read === null || newest === null ? null : (
        <button
          type="button"
          data-testid="topic-search-earlier"
          className={LINK_BUTTON}
          title="Read again from the earliest message of each partition, with the same filter"
          onClick={() => void invoke(TOPIC_ACTION_IDS.searchEarlier)}
        >
          Search Earlier
        </button>
      )}
      {tab.read === null ? null : tab.read.exhausted ? (
        <span className="min-w-0 truncate">reached the head of every partition</span>
      ) : (
        <button
          type="button"
          data-testid="topic-scan-further"
          className={LINK_BUTTON}
          onClick={() => void invoke(TOPIC_ACTION_IDS.scanFurther)}
        >
          Scan Further
        </button>
      )}
      {tab.read === null || tab.read.warnings.length === 0 ? null : (
        <span className="truncate text-warning" title={tab.read.warnings.join("\n")}>
          {tab.read.warnings[0]}
        </span>
      )}
      {tab.notice === null ? null : (
        <span role="status" data-testid="topic-notice" className="truncate text-warning">
          {tab.notice}
        </span>
      )}
      <span className="truncate">{STATUS_TEXT[tab.status]}</span>
      <span className="flex-1" />
      <span className="shrink-0">{NO_GROUP_TEXT}</span>
    </div>
  );
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
              panel={(focus) => <MessagePanel tab={tab} focus={focus} />}
              toolbar={
                <>
                  <span className="mx-1 h-4 w-px shrink-0 bg-line" />
                  <ActionButton actionId={TOPIC_ACTION_IDS.scanFurther} compact />
                  <ActionButton actionId={TOPIC_ACTION_IDS.produceFromRow} compact reason={writeReason} />
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
            <ActionButton actionId={TAIL_ACTION_IDS.start} compact reason={reasons.read} />
            <ActionButton actionId={TOPIC_ACTION_IDS.produce} compact reason={reasons.write} testId="topic-produce" />
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
        <PartitionsView description={tab.description} writeReason={reasons.write} />
      ) : tab.view === "configs" ? (
        <ConfigsView description={tab.description} writeReason={reasons.write} />
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
