import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  canWriteStreams,
  dialogDatasource,
  focusedMessage,
  guarded,
  openTopicAt,
  type TopicOffsetArgs,
} from "@table-craft/desktop/renderer/actions/topicActions.js";
import type { ResetDraft } from "@table-craft/desktop/renderer/model/groupLag.js";
import { DEFAULT_LAG_WARNING, lagWarningOf } from "@table-craft/desktop/renderer/model/streamTree.js";
import { isProduction } from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { PRODUCTION_TEXT } from "@table-craft/desktop/renderer/streams/DialogTitle.js";
import { catalogRowOf } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useGroupTabs, type GroupTarget, type GroupView } from "@table-craft/desktop/renderer/state/groupTabs.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { useStreams } from "@table-craft/desktop/renderer/state/streams.js";
import { useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import { useTopicTabs } from "@table-craft/desktop/renderer/state/topicTabs.js";
import { useStreamDialog } from "@table-craft/desktop/renderer/streams/dialogStore.js";

export const GROUP_ACTION_IDS = {
  open: "group.open",
  refresh: "group.refresh",
  showView: "group.showView",
  resetOffsets: "group.resetOffsets",
  deleteOffsets: "group.deleteOffsets",
  delete: "group.delete",
  readFromHere: "group.readFromHere",
  skipFromRow: "group.skipFromRow",
} as const;

export type OpenGroupArgs = GroupTarget;

/** Reset Offsets opened on one topic with some fields set, as Skip Record does (audit M1). */
export interface ResetArgs extends GroupTarget {
  readonly topic?: string;
  readonly draft?: Partial<ResetDraft>;
}

export interface GroupViewArgs {
  readonly view: GroupView;
}

const GROUP_TAB_PREFIX = "group-";
let groupTabsOpened = 0;

const groups = (context: ActionContext) => context.datasource?.capabilities.includes("consumerGroups") === true;

function isGroupTarget(args: unknown): args is GroupTarget {
  return typeof args === "object" && args !== null && "datasourceId" in args && "group" in args;
}

/** The consumer group the tree's selection is, if it is one. */
export function selectedGroup(context: ActionContext): GroupTarget | null {
  const { selection } = context;
  if (selection?.kind !== "catalog") return null;
  const row = catalogRowOf(selection.key);
  const group = row?.rest[0];
  return row?.kind === "consumerGroup" && typeof group === "string" ? { datasourceId: selection.id, group } : null;
}

/** What a group action acts on: its arguments, the tree's selected group in the pane, else the active group tab. */
export function groupTarget(context: ActionContext, args?: unknown): GroupTarget | null {
  if (isGroupTarget(args)) return { datasourceId: args.datasourceId, group: args.group };
  const selected = context.inDatabasePane ? selectedGroup(context) : null;
  if (selected !== null) return selected;
  const tab = context.groupTab;
  return tab == null ? selectedGroup(context) : { datasourceId: tab.datasourceId, group: tab.group };
}

/** Opens the group in a group tab, or brings its open tab forward. */
export function openGroup(target: GroupTarget): void {
  const existing = Object.entries(useGroupTabs.getState().tabs).find(
    ([, tab]) => tab.datasourceId === target.datasourceId && tab.group === target.group,
  )?.[0];
  if (existing !== undefined) {
    useTabs.getState().activate(existing);
    return;
  }
  const tab: Tab = { id: `${GROUP_TAB_PREFIX}${String(groupTabsOpened++)}`, kind: "group", title: target.group };
  useTabs.getState().open(tab);
  void useGroupTabs.getState().open(tab.id, target);
}

function tabsShowing(target: GroupTarget): readonly string[] {
  return Object.entries(useGroupTabs.getState().tabs)
    .filter(([, tab]) => tab.datasourceId === target.datasourceId && tab.group === target.group)
    .map(([id]) => id);
}

/** After a write: the tree's lag, the group's tabs and every topic tab's Consumers read again. */
async function refreshGroup(target: GroupTarget): Promise<void> {
  const topicTabs = Object.entries(useTopicTabs.getState().tabs)
    .filter(([, tab]) => tab.datasourceId === target.datasourceId)
    .map(([id]) => id);
  await Promise.all([
    useStreams.getState().synchronize(target.datasourceId),
    ...tabsShowing(target).map((id) => useGroupTabs.getState().refresh(id)),
    ...topicTabs.map((id) => useTopicTabs.getState().describe(id)),
  ]);
}

const canWriteGroup = (context: ActionContext) => {
  const target = groupTarget(context);
  return target !== null && canWriteStreams(context, target.datasourceId, "consumerGroups");
};

/** Reset Offsets… (decision 11), opened on the group's topics or on the one `args` names. */
const resetOffsets = guarded("Reset Offsets", async (context: ActionContext, args: ResetArgs | undefined) => {
  const target = groupTarget(context, args);
  if (target === null) return;
  const client = await useDatasources.getState().connect(target.datasourceId);
  const description = await client.call("groups.describe", { group: target.group });
  const view = context.datasources.find((datasource) => datasource.id === target.datasourceId);
  const applied = await useStreamDialog.getState().ask({
    kind: "reset",
    datasource: dialogDatasource(context, target.datasourceId),
    group: target.group,
    state: description.state,
    members: description.members.map((member) => ({ clientId: member.clientId, host: member.host })),
    topics: [...new Set(description.offsets.map((offset) => offset.topic))].sort(),
    ...(args?.topic === undefined && args?.draft === undefined
      ? {}
      : { initial: { topic: args.topic ?? null, draft: args.draft ?? {} } }),
    lagWarning: view === undefined ? DEFAULT_LAG_WARNING : lagWarningOf(view.config),
    prepare: (scope, resetTarget) =>
      client.call("groups.prepareReset", { group: target.group, scope, target: resetTarget }),
    apply: (token) => client.call("groups.applyReset", { token }).then(() => undefined),
  });
  if (applied) await refreshGroup(target);
});

export const GROUP_ACTIONS: readonly AnyAction[] = [
  defineAction<OpenGroupArgs | undefined>({
    id: GROUP_ACTION_IDS.open,
    title: "Open Consumer Group",
    category: "Streams",
    icon: "group",
    available: groups,
    run: (context, args) => {
      const target = isGroupTarget(args) ? args : selectedGroup(context);
      if (target !== null) openGroup(target);
    },
  }),
  defineAction({
    id: GROUP_ACTION_IDS.refresh,
    title: "Refresh Lag",
    category: "Streams",
    icon: "synchronize",
    tabKind: "group",
    when: (context) => context.groupTab != null && !context.groupTab.loading,
    busy: (context) => context.groupTab?.loading === true,
    run: async (context) => {
      if (context.activeTab !== null) await useGroupTabs.getState().refresh(context.activeTab.id);
    },
  }),
  defineAction<GroupViewArgs | undefined>({
    id: GROUP_ACTION_IDS.showView,
    title: "Show Group View",
    category: "Streams",
    tabKind: "group",
    inPalette: false,
    run: (context, args) => {
      if (context.activeTab === null || (args?.view !== "lag" && args?.view !== "members")) return;
      useGroupTabs.getState().setView(context.activeTab.id, args.view);
    },
  }),
  defineAction<OpenGroupArgs | undefined>({
    id: GROUP_ACTION_IDS.resetOffsets,
    title: "Reset Offsets…",
    category: "Streams",
    icon: "rollback",
    available: groups,
    when: canWriteGroup,
    run: resetOffsets,
  }),
  defineAction<OpenGroupArgs | undefined>({
    id: GROUP_ACTION_IDS.deleteOffsets,
    title: "Delete Committed Offsets…",
    category: "Streams",
    icon: "delete",
    available: groups,
    when: canWriteGroup,
    run: guarded("Delete Committed Offsets", async (context, args: OpenGroupArgs | undefined) => {
      const target = groupTarget(context, args);
      if (target === null) return;
      const client = await useDatasources.getState().connect(target.datasourceId);
      const description = await client.call("groups.describe", { group: target.group });
      const topics = [...new Set(description.offsets.map((offset) => offset.topic))].sort();
      const topic =
        topics.length === 1
          ? topics[0]
          : await useModal.getState().ask({
              kind: "pick",
              title: "Delete Committed Offsets",
              searchLabel: "Topic",
              items: topics.map((name) => ({ id: name, label: name, detail: "" })),
              empty: "The group has no committed offsets.",
              confirm: "Continue",
            });
      if (topic == null) return;
      const where = dialogDatasource(context, target.datasourceId);
      const answer = await useModal.getState().ask({
        kind: "confirm",
        title: `Delete Committed Offsets on ${where.name}`,
        message: `${isProduction(where) ? `${PRODUCTION_TEXT}. ` : ""}Delete ${target.group}'s committed offsets on ${topic}? It then starts from its reset policy the next time it consumes the topic. This cannot be undone.`,
        confirm: "Delete Offsets",
        destructive: true,
        typed: target.group,
      });
      if (answer === null) return;
      await client.call("groups.deleteOffsets", { group: target.group, topic });
      await refreshGroup(target);
    }),
  }),
  defineAction<OpenGroupArgs | undefined>({
    id: GROUP_ACTION_IDS.delete,
    title: "Delete Consumer Group…",
    category: "Streams",
    icon: "delete",
    available: groups,
    when: canWriteGroup,
    run: guarded("Delete Consumer Group", async (context, args: OpenGroupArgs | undefined) => {
      const target = groupTarget(context, args);
      if (target === null) return;
      const where = dialogDatasource(context, target.datasourceId);
      const answer = await useModal.getState().ask({
        kind: "confirm",
        title: `Delete Consumer Group on ${where.name}`,
        message: `${isProduction(where) ? `${PRODUCTION_TEXT}. ` : ""}Delete ${target.group} on ${where.name} and every offset it committed? The broker refuses while it has members.`,
        confirm: "Delete Group",
        destructive: true,
        typed: target.group,
      });
      if (answer === null) return;
      const client = await useDatasources.getState().connect(target.datasourceId);
      await client.call("groups.delete", { group: target.group });
      for (const id of tabsShowing(target)) {
        useTabs.getState().close(id);
        useGroupTabs.getState().close(id);
      }
      await useStreams.getState().synchronize(target.datasourceId);
    }),
  }),
  defineAction<TopicOffsetArgs | undefined>({
    id: GROUP_ACTION_IDS.readFromHere,
    title: "Read from Here",
    category: "Streams",
    inPalette: false,
    run: (_context, args) => {
      if (args !== undefined) openTopicAt(args);
    },
  }),
  defineAction({
    id: GROUP_ACTION_IDS.skipFromRow,
    title: "Skip This Record for a Group…",
    category: "Streams",
    icon: "rollback",
    tabKind: "topic",
    available: groups,
    when: (context) =>
      context.topicTab != null &&
      canWriteStreams(context, context.topicTab.datasourceId, "consumerGroups") &&
      focusedMessage(context.topicTab) !== null &&
      (context.topicTab?.consumers?.length ?? 0) > 0,
    run: guarded("Skip Record", async (context) => {
      const tab = context.topicTab;
      const message = focusedMessage(tab);
      if (tab == null || message === null || message.partition === null) return;
      const consumers = tab.consumers ?? [];
      const group =
        tab.committed?.group ??
        (consumers.length === 1
          ? consumers[0]?.id
          : await useModal.getState().ask({
              kind: "pick",
              title: "Skip This Record for a Group",
              searchLabel: "Consumer group",
              items: consumers.map((each) => ({ id: each.id, label: each.id, detail: each.state })),
              empty: "No group has committed offsets on this topic.",
              confirm: "Continue",
            }));
      if (group == null) return;
      const next = (BigInt(message.offset) + 1n).toString();
      const args: ResetArgs = {
        datasourceId: tab.datasourceId,
        group,
        topic: tab.topic,
        draft: { kind: "offset", offset: next, partitions: String(message.partition) },
      };
      await resetOffsets(context, args);
    }),
  }),
];
