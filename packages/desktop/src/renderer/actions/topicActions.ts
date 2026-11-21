import type { SchemaType, SubjectSummary } from "@table-craft/desktop/engine/protocol.js";
import {
  isPreviewMessage,
  messageCommand,
  messageJson,
  messageOf,
  PREVIEW_ONLY_NOTICE,
  withFullCells,
  type TopicMessage,
} from "@table-craft/desktop/renderer/model/topicMessage.js";
import { toggledPartitionFilter } from "@table-craft/desktop/renderer/model/topicRead.js";
import { openConsole } from "@table-craft/desktop/renderer/actions/consoleCommands.js";
import {
  datasourceTarget,
  type ActionContext,
  type DatasourceTarget,
} from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { catalogRowOf } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { DEFAULT_DRAFT, type ReadDraft } from "@table-craft/desktop/renderer/model/topicRead.js";
import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { topicFormatKey, useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { rowAt } from "@table-craft/desktop/renderer/state/resultTab.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import { untilListed, useStreams } from "@table-craft/desktop/renderer/state/streams.js";
import { useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import {
  canReadTopic,
  TOPIC_VIEWS,
  useTopicTabs,
  type TopicTab,
  type TopicTarget,
  type TopicView,
} from "@table-craft/desktop/renderer/state/topicTabs.js";
import { isProduction } from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { PRODUCTION_TEXT } from "@table-craft/desktop/renderer/streams/DialogTitle.js";
import {
  EMPTY_PRODUCE,
  useStreamDialog,
  type DialogDatasource,
  type ProduceDraft,
  type ProduceSchema,
} from "@table-craft/desktop/renderer/streams/dialogStore.js";

export const TOPIC_ACTION_IDS = {
  open: "topic.open",
  read: "topic.read",
  scanFurther: "topic.scanFurther",
  refresh: "topic.refresh",
  showView: "topic.showView",
  selectPartition: "topic.selectPartition",
  copyName: "topic.copyName",
  produce: "topic.produce",
  produceFromRow: "topic.produceFromRow",
  create: "topic.create",
  editConfigs: "topic.editConfigs",
  addPartitions: "topic.addPartitions",
  deleteRecords: "topic.deleteRecords",
  delete: "topic.delete",
  cancelRead: "topic.cancelRead",
  searchEarlier: "topic.searchEarlier",
  filterPartition: "topic.filterPartition",
  copyMessage: "topic.copyMessage",
  openMessageInConsole: "topic.openMessageInConsole",
  openAt: "topic.openAt",
  toggleInternal: "topic.toggleInternal",
} as const;

/** A message to open the topic at, as the Live Tail's row action names it. */
export interface TopicOffsetArgs extends TopicTarget {
  readonly partition: number;
  readonly offset: string;
  /** Marks this group's committed offsets in what the tab reads, as Read from Here does. */
  readonly group?: string;
}

const PREVIEW_PRODUCE_REFUSED = `${PREVIEW_ONLY_NOTICE} Producing it again would send a cut record; read the topic again to produce it whole.`;
const PREVIEW_COPIED_TITLE = "Copied the Preview Only";
const PREVIEW_COPIED_HINT = "Read the topic again to copy the message whole.";

/** Read from Here and Open at This Offset read this many messages (audit M9). */
const READ_HERE_LIMIT = "50";

export type OpenTopicArgs = TopicTarget;

export interface TopicViewArgs {
  readonly view: TopicView;
}

export interface PartitionArgs {
  readonly partition: number;
}

/**
 * `run` with what the broker refused said in a notice titled `title`, rather than only logged:
 * a write the user asked for must say when it did not happen. Nothing is retried (decision 139).
 */
export function guarded<A>(
  title: string,
  run: (context: ActionContext, args: A) => Promise<void>,
): (context: ActionContext, args: A) => Promise<void> {
  return async (context, args) => {
    try {
      await run(context, args);
    } catch (cause) {
      const error = toError(cause);
      await useModal.getState().ask({ kind: "notice", title, message: error.message, hint: error.hint });
    }
  };
}

const TOPIC_TAB_PREFIX = "topic-";
let topicTabsOpened = 0;

const streams = (context: ActionContext) => context.datasource?.capabilities.includes("topics") === true;
const readOnly = (context: ActionContext) => context.datasource?.view.readOnly === true;
const connected = (context: ActionContext) => context.datasource?.connection.status === "connected";

/** `datasourceId`'s state: `context.datasource` when it is that one, else read from the store. */
export function streamSource(context: ActionContext, datasourceId: string): DatasourceTarget | null {
  return context.datasource?.view.id === datasourceId ? context.datasource : datasourceTarget(datasourceId);
}

/** Whether a topic action applies: to the topic `args` name when given, else to `context.datasource`. */
export function topicsAvailable(context: ActionContext, args?: unknown): boolean {
  if (!isTopicTarget(args)) return streams(context);
  return streamSource(context, args.datasourceId)?.capabilities.includes("topics") === true;
}

function isTopicTarget(args: unknown): args is TopicTarget {
  return typeof args === "object" && args !== null && "datasourceId" in args && "topic" in args;
}

/** The topic the tree's selection is, if it is one. */
export function selectedTopic(context: ActionContext): TopicTarget | null {
  const { selection } = context;
  if (selection?.kind !== "catalog") return null;
  const row = catalogRowOf(selection.key);
  const topic = row?.rest[0];
  return row?.kind === "topic" && typeof topic === "string" ? { datasourceId: selection.id, topic } : null;
}

/** What a topic action acts on: its arguments, the tree's selected topic in the pane, else the active topic tab. */
export function topicTarget(context: ActionContext, args?: unknown): TopicTarget | null {
  if (isTopicTarget(args)) return { datasourceId: args.datasourceId, topic: args.topic };
  const selected = context.inDatabasePane ? selectedTopic(context) : null;
  if (selected !== null) return selected;
  const tab = context.topicTab;
  return tab == null ? selectedTopic(context) : { datasourceId: tab.datasourceId, topic: tab.topic };
}

/** The active topic tab's topic: what a row of its grid belongs to, whatever the tree selects. */
function tabTopic(context: ActionContext): TopicTarget | undefined {
  const tab = context.topicTab;
  return tab == null ? undefined : { datasourceId: tab.datasourceId, topic: tab.topic };
}

/** The draft a topic opens with: its remembered formats over the defaults (decision 7). */
export function openingDraft(target: TopicTarget): ReadDraft {
  const formats = useLayout.getState().layout.messageFormats[topicFormatKey(target.datasourceId, target.topic)];
  return formats === undefined
    ? DEFAULT_DRAFT
    : { ...DEFAULT_DRAFT, keyFormat: formats.key, valueFormat: formats.value };
}

/** Opens the topic in a topic tab (decision 5), or brings its open tab forward. */
export function openTopic(target: TopicTarget): void {
  const existing = Object.entries(useTopicTabs.getState().tabs).find(
    ([, tab]) => tab.datasourceId === target.datasourceId && tab.topic === target.topic,
  )?.[0];
  if (existing !== undefined) {
    useTabs.getState().activate(existing);
    return;
  }
  const tab: Tab = { id: `${TOPIC_TAB_PREFIX}${String(topicTabsOpened++)}`, kind: "topic", title: target.topic };
  useTabs.getState().open(tab);
  void useTopicTabs.getState().open(tab.id, target, openingDraft(target));
}

/** The topic tabs showing `target`, by tab id. */
function tabsShowing(target: TopicTarget): readonly string[] {
  return Object.entries(useTopicTabs.getState().tabs)
    .filter(([, tab]) => tab.datasourceId === target.datasourceId && tab.topic === target.topic)
    .map(([id]) => id);
}

/** After a write: the tree's counts and every tab showing the topic read again. */
async function refreshTopic(target: TopicTarget): Promise<void> {
  await Promise.all([
    useStreams.getState().synchronize(target.datasourceId),
    ...tabsShowing(target).map((id) => useTopicTabs.getState().describe(id)),
  ]);
}

async function clientOf(datasourceId: string) {
  return useDatasources.getState().connect(datasourceId);
}

/** The data source a dialog names in its title (audit M8). */
export function dialogDatasource(context: ActionContext, datasourceId: string): DialogDatasource {
  const view = context.datasources.find((datasource) => datasource.id === datasourceId);
  return { name: view?.name ?? datasourceId, color: view?.color ?? null };
}

/** The focused row of a topic tab as a message; null without one loaded. */
export function focusedMessage(tab: TopicTab | null | undefined): TopicMessage | null {
  const result = tab?.result;
  const focus = result?.selection?.focus;
  if (result == null || focus === undefined) return null;
  const row = rowAt(result.windows, focus.row);
  return row === undefined ? null : messageOf(result.columns, row);
}

/**
 * The focused message with the whole key, value and headers its read kept on disk (decision 172);
 * the row's own cells when the read no longer holds them.
 */
export async function wholeFocusedMessage(context: ActionContext): Promise<TopicMessage | null> {
  const message = focusedMessage(context.topicTab);
  const tabId = context.activeTab?.id;
  if (message === null || message.partition === null || tabId === undefined) return message;
  const full = await useTopicTabs
    .getState()
    .message(tabId, message.partition, message.offset)
    .catch(() => null);
  return full === null ? message : withFullCells(message, full);
}

/** `message` to produce again; refused when only its preview is left, which would send a cut record. */
export function producible(message: TopicMessage | null): TopicMessage | null {
  if (message !== null && isPreviewMessage(message)) throw new Error(PREVIEW_PRODUCE_REFUSED);
  return message;
}

/** The focused row of a topic tab, or `message`, as a record to send again (decision 13). */
export function produceDraftOf(
  tab: TopicTab | null | undefined,
  message: TopicMessage | null = focusedMessage(tab),
): ProduceDraft | null {
  if (message === null) return null;
  return {
    ...EMPTY_PRODUCE,
    partition: message.partition === null ? "" : String(message.partition),
    key: message.key ?? "",
    value: message.value ?? "",
    headers: message.headers,
  };
}

const SCHEMA_ID = /^(AVRO|PROTOBUF|JSON) id \d+$/;

/**
 * The value schema Produce preselects (audit M7): `<topic>-value` when the registry lists it, at
 * its latest version, else none. The last read's `valueSchema` names only an id, so it tells the
 * type when the subject is named otherwise.
 */
export function produceSchemaOf(
  topic: string,
  subjects: readonly SubjectSummary[] | null | undefined,
  lastValueSchema: string | null,
): ProduceSchema | null {
  const subject = subjects?.find((each) => each.subject === `${topic}-value`);
  if (subject?.type != null) return { subject: subject.subject, version: subject.latestVersion, type: subject.type };
  const match = lastValueSchema === null ? null : SCHEMA_ID.exec(lastValueSchema);
  const type = match?.[1] as SchemaType | undefined;
  return type === undefined ? null : { subject: `${topic}-value`, version: null, type };
}

async function produce(context: ActionContext, initial: ProduceDraft, args?: unknown): Promise<void> {
  const target = topicTarget(context, args);
  if (target === null) return;
  const client = await clientOf(target.datasourceId);
  const tab =
    context.topicTab?.datasourceId === target.datasourceId && context.topicTab.topic === target.topic
      ? context.topicTab
      : null;
  const partitions =
    tab?.description?.partitions.length ??
    useStreams.getState().streams[target.datasourceId]?.topics?.find((topic) => topic.name === target.topic)
      ?.partitions ??
    null;
  const streams = useStreams.getState().streams[target.datasourceId];
  const registry = streams?.registry?.available === true;
  const lastSchema = focusedMessage(tab)?.valueSchema ?? null;
  const sent = await useStreamDialog.getState().ask({
    kind: "produce",
    datasource: dialogDatasource(context, target.datasourceId),
    topic: target.topic,
    partitions,
    initial,
    registry,
    valueSchema: registry ? produceSchemaOf(target.topic, streams?.subjects, lastSchema) : null,
    send: (record) => client.call("topics.produce", { record }),
  });
  if (sent) await refreshTopic(target);
}

/**
 * Whether `datasourceId` takes `capability`'s writes now. It is the target's datasource, which
 * need not be `context.datasource` when the target came from the tree.
 */
export function canWriteStreams(
  context: ActionContext,
  datasourceId: string,
  capability: "topics" | "consumerGroups" = "topics",
): boolean {
  const source = streamSource(context, datasourceId);
  return (
    source !== null &&
    source.capabilities.includes(capability) &&
    !source.view.readOnly &&
    source.connection.status === "connected"
  );
}

/** Whether the topic `args` name, else the one the context points at, takes writes now. */
export function canWriteTopic(context: ActionContext, args?: unknown): boolean {
  const target = topicTarget(context, args);
  return target !== null && canWriteStreams(context, target.datasourceId);
}

const writeTopicAction = { available: topicsAvailable, when: canWriteTopic } as const;

export const TOPIC_ACTIONS: readonly AnyAction[] = [
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.open,
    title: "Open Topic",
    category: "Streams",
    icon: "topic",
    available: streams,
    run: (context, args) => {
      const target = isTopicTarget(args) ? args : selectedTopic(context);
      if (target !== null) openTopic(target);
    },
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.read,
    title: "Read Messages",
    category: "Streams",
    icon: "run",
    tabKind: "topic",
    when: (context) => context.topicTab != null && canReadTopic(context.topicTab.status),
    busy: (context) => context.topicTab?.status === "loading",
    run: async (context) => {
      const tab = context.topicTab;
      if (context.activeTab === null || tab == null) return;
      useLayout.getState().setMessageFormats(topicFormatKey(tab.datasourceId, tab.topic), {
        key: tab.draft.keyFormat,
        value: tab.draft.valueFormat,
      });
      await useTopicTabs.getState().read(context.activeTab.id);
    },
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.scanFurther,
    title: "Scan Further",
    category: "Streams",
    icon: "fetchNextPage",
    tabKind: "topic",
    when: (context) =>
      context.topicTab != null && canReadTopic(context.topicTab.status) && context.topicTab.read?.resume != null,
    run: async (context) => {
      if (context.activeTab !== null) await useTopicTabs.getState().scanFurther(context.activeTab.id);
    },
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.refresh,
    title: "Refresh Topic",
    category: "Streams",
    icon: "synchronize",
    tabKind: "topic",
    when: (context) => context.topicTab != null && !context.topicTab.describing,
    run: async (context) => {
      if (context.activeTab !== null) await useTopicTabs.getState().describe(context.activeTab.id);
    },
  }),
  defineAction<TopicViewArgs | undefined>({
    id: TOPIC_ACTION_IDS.showView,
    title: "Show Topic View",
    category: "Streams",
    tabKind: "topic",
    inPalette: false,
    run: (context, args) => {
      if (context.activeTab === null || args === undefined || !TOPIC_VIEWS.includes(args.view)) return;
      useTopicTabs.getState().setView(context.activeTab.id, args.view);
    },
  }),
  defineAction<PartitionArgs | undefined>({
    id: TOPIC_ACTION_IDS.selectPartition,
    title: "Read Only Partition",
    category: "Streams",
    tabKind: "topic",
    inPalette: false,
    when: (context) => context.topicTab != null && canReadTopic(context.topicTab.status),
    run: async (context, args) => {
      if (context.activeTab === null || args === undefined || !Number.isInteger(args.partition)) return;
      await useTopicTabs.getState().selectPartition(context.activeTab.id, args.partition);
    },
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.copyName,
    title: "Copy Topic Name",
    category: "Streams",
    icon: "copy",
    available: topicsAvailable,
    when: (context, args) => topicTarget(context, args) !== null,
    run: async (context, args) => {
      const target = topicTarget(context, args);
      if (target !== null) await writeClipboard(target.topic);
    },
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.produce,
    title: "Produce Message…",
    category: "Streams",
    icon: "produce",
    ...writeTopicAction,
    run: guarded("Produce Message", async (context, args: OpenTopicArgs | undefined) => {
      const formats = context.topicTab?.draft;
      await produce(
        context,
        {
          ...EMPTY_PRODUCE,
          ...(formats === undefined || formats.valueFormat === "auto" ? {} : { valueFormat: formats.valueFormat }),
          ...(formats === undefined || formats.keyFormat === "auto" ? {} : { keyFormat: formats.keyFormat }),
        },
        args,
      );
    }),
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.produceFromRow,
    title: "Produce Again from Row…",
    category: "Streams",
    icon: "produce",
    tabKind: "topic",
    available: topicsAvailable,
    when: (context, args) =>
      canWriteTopic(context, args ?? tabTopic(context)) && produceDraftOf(context.topicTab) !== null,
    run: guarded("Produce Message", async (context, args: OpenTopicArgs | undefined) => {
      const draft = produceDraftOf(context.topicTab, producible(await wholeFocusedMessage(context)));
      if (draft !== null) await produce(context, draft, args ?? tabTopic(context));
    }),
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.create,
    title: "Create Topic…",
    category: "Streams",
    icon: "add",
    available: streams,
    when: (context) => streams(context) && !readOnly(context) && connected(context),
    run: guarded("Create Topic", async (context) => {
      const datasourceId = context.datasource?.view.id;
      if (datasourceId === undefined) return;
      const client = await clientOf(datasourceId);
      let name: string | null = null;
      const created = await useStreamDialog.getState().ask({
        kind: "createTopic",
        datasource: dialogDatasource(context, datasourceId),
        existing: (useStreams.getState().streams[datasourceId]?.topics ?? []).map((topic) => topic.name),
        create: async (request, validateOnly) => {
          await client.call("topics.create", { request, validateOnly });
          if (!validateOnly) name = request.name;
        },
      });
      if (!created) return;
      const streams = useStreams.getState();
      await untilListed(
        () => streams.synchronize(datasourceId),
        () => (useStreams.getState().streams[datasourceId]?.topics ?? []).some((topic) => topic.name === name),
        (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      );
    }),
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.editConfigs,
    title: "Edit Topic Configs…",
    category: "Streams",
    icon: "properties",
    ...writeTopicAction,
    run: guarded("Edit Topic Configs", async (context, args: OpenTopicArgs | undefined) => {
      const target = topicTarget(context, args);
      if (target === null) return;
      const client = await clientOf(target.datasourceId);
      const { configs } = await client.call("topics.describe", { topic: target.topic });
      const altered = await useStreamDialog.getState().ask({
        kind: "configs",
        datasource: dialogDatasource(context, target.datasourceId),
        topic: target.topic,
        configs,
        alter: (changes, validateOnly) =>
          client.call("topics.alterConfigs", { topic: target.topic, changes, validateOnly }).then(() => undefined),
      });
      if (altered) await refreshTopic(target);
    }),
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.addPartitions,
    title: "Add Partitions…",
    category: "Streams",
    icon: "add",
    ...writeTopicAction,
    run: guarded("Add Partitions", async (context, args: OpenTopicArgs | undefined) => {
      const target = topicTarget(context, args);
      if (target === null) return;
      const client = await clientOf(target.datasourceId);
      const { partitions } = await client.call("topics.describe", { topic: target.topic });
      const added = await useStreamDialog.getState().ask({
        kind: "addPartitions",
        datasource: dialogDatasource(context, target.datasourceId),
        topic: target.topic,
        current: partitions.length,
        add: (total, validateOnly) =>
          client.call("topics.addPartitions", { topic: target.topic, total, validateOnly }).then(() => undefined),
      });
      if (added) await refreshTopic(target);
    }),
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.deleteRecords,
    title: "Delete Records…",
    category: "Streams",
    icon: "delete",
    ...writeTopicAction,
    run: guarded("Delete Records", async (context, args: OpenTopicArgs | undefined) => {
      const target = topicTarget(context, args);
      if (target === null) return;
      const client = await clientOf(target.datasourceId);
      const { partitions } = await client.call("topics.describe", { topic: target.topic });
      const deleted = await useStreamDialog.getState().ask({
        kind: "deleteRecords",
        datasource: dialogDatasource(context, target.datasourceId),
        topic: target.topic,
        partitions: partitions.length,
        prepare: (chosen, before) =>
          client.call("topics.prepareDeleteRecords", { topic: target.topic, partitions: chosen, before }),
        apply: (token) => client.call("topics.deleteRecords", { token }).then(() => undefined),
      });
      if (deleted) await refreshTopic(target);
    }),
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TOPIC_ACTION_IDS.delete,
    title: "Delete Topic…",
    category: "Streams",
    icon: "delete",
    ...writeTopicAction,
    run: guarded("Delete Topic", async (context, args: OpenTopicArgs | undefined) => {
      const target = topicTarget(context, args);
      if (target === null) return;
      const where = dialogDatasource(context, target.datasourceId);
      const answer = await useModal.getState().ask({
        kind: "confirm",
        title: `Delete Topic on ${where.name}`,
        message: `${isProduction(where) ? `${PRODUCTION_TEXT}. ` : ""}Delete ${target.topic} on ${where.name} and every message in it? Consumers and producers of it start failing. This cannot be undone.`,
        confirm: "Delete Topic",
        destructive: true,
        typed: target.topic,
      });
      if (answer === null) return;
      const client = await clientOf(target.datasourceId);
      await client.call("topics.delete", { topic: target.topic });
      for (const id of tabsShowing(target)) {
        useTabs.getState().close(id);
        useTopicTabs.getState().close(id);
      }
      await useStreams.getState().synchronize(target.datasourceId);
    }),
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.cancelRead,
    title: "Cancel Read",
    category: "Streams",
    icon: "cancel",
    tabKind: "topic",
    when: (context) => context.topicTab?.status === "loading",
    run: async (context) => {
      if (context.activeTab !== null) await useTopicTabs.getState().cancel(context.activeTab.id);
    },
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.searchEarlier,
    title: "Search Earlier",
    category: "Streams",
    tabKind: "topic",
    when: (context) => context.topicTab != null && canReadTopic(context.topicTab.status),
    run: async (context) => {
      if (context.activeTab !== null)
        await useTopicTabs.getState().readWith(context.activeTab.id, { from: "earliest" });
    },
  }),
  defineAction<PartitionArgs | undefined>({
    id: TOPIC_ACTION_IDS.filterPartition,
    title: "Show Only Partition's Rows",
    category: "Streams",
    tabKind: "topic",
    inPalette: false,
    when: (context) => context.topicTab?.result != null && !context.topicTab.result.stale,
    run: async (context, args) => {
      const result = context.topicTab?.result;
      if (context.activeTab === null || result == null || args === undefined) return;
      await useTopicTabs.getState().search(context.activeTab.id, result.id, (search) => ({
        ...search,
        filters: toggledPartitionFilter(result.columns, search.filters, args.partition),
      }));
    },
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.copyMessage,
    title: "Copy Message as JSON",
    category: "Streams",
    icon: "copy",
    tabKind: "topic",
    when: (context) => focusedMessage(context.topicTab) !== null,
    run: async (context) => {
      const message = await wholeFocusedMessage(context);
      if (message === null) return;
      await writeClipboard(messageJson(message));
      if (isPreviewMessage(message))
        await useModal.getState().ask({
          kind: "notice",
          tone: "info",
          title: PREVIEW_COPIED_TITLE,
          message: PREVIEW_ONLY_NOTICE,
          hint: PREVIEW_COPIED_HINT,
        });
    },
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.openMessageInConsole,
    title: "Open Message in Console",
    category: "Streams",
    icon: "newConsole",
    tabKind: "topic",
    when: (context) => focusedMessage(context.topicTab) !== null,
    run: async (context) => {
      const tab = context.topicTab;
      const message = focusedMessage(tab);
      if (tab == null || message === null) return;
      await openConsole(tab.datasourceId, messageCommand(tab.topic, message));
    },
  }),
  defineAction<TopicOffsetArgs | undefined>({
    id: TOPIC_ACTION_IDS.openAt,
    title: "Open in Topic Tab at This Offset",
    category: "Streams",
    inPalette: false,
    run: (_context, args) => {
      if (args !== undefined) openTopicAt(args);
    },
  }),
  defineAction({
    id: TOPIC_ACTION_IDS.toggleInternal,
    title: "Show Internal Topics",
    category: "Streams",
    available: streams,
    run: () => useLayout.getState().toggleSystemSchemas(),
  }),
];

/**
 * Opens the topic on one partition from `offset`, 50 messages (audit M9 and M11): a new tab, or the
 * open one with those fields read at once. `group` marks that group's committed offsets.
 */
export function openTopicAt(args: TopicOffsetArgs): void {
  const target = { datasourceId: args.datasourceId, topic: args.topic };
  const change: Partial<ReadDraft> = {
    partitions: [args.partition],
    from: "offset",
    offset: args.offset,
    limit: READ_HERE_LIMIT,
  };
  const existing = tabsShowing(target)[0];
  if (existing !== undefined) {
    useTabs.getState().activate(existing);
    useTopicTabs.getState().setView(existing, "messages");
    void useTopicTabs.getState().readWith(existing, change, args.group);
    return;
  }
  const tab: Tab = { id: `${TOPIC_TAB_PREFIX}${String(topicTabsOpened++)}`, kind: "topic", title: target.topic };
  useTabs.getState().open(tab);
  void useTopicTabs.getState().open(tab.id, target, { ...openingDraft(target), ...change }, args.group);
}
