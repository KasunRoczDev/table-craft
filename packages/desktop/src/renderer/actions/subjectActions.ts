import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { openServerIn } from "@table-craft/desktop/renderer/actions/serverActions.js";
import { dialogDatasource, guarded } from "@table-craft/desktop/renderer/actions/topicActions.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { serverTabOf, useServer } from "@table-craft/desktop/renderer/state/server.js";
import { useStreams } from "@table-craft/desktop/renderer/state/streams.js";
import { schemaText, useSubjectTabs, type SubjectTarget } from "@table-craft/desktop/renderer/state/subjectTabs.js";
import { useTabs, type Tab } from "@table-craft/desktop/renderer/state/tabs.js";
import { useStreamDialog } from "@table-craft/desktop/renderer/streams/dialogStore.js";

export const SUBJECT_ACTION_IDS = {
  open: "subject.open",
  refresh: "subject.refresh",
  selectVersion: "subject.selectVersion",
  check: "subject.check",
  register: "subject.register",
  brokerInfo: "broker.showInfo",
} as const;

export interface SubjectVersionArgs {
  readonly version: number;
}

export interface BrokerArgs {
  readonly datasourceId: string;
  readonly node: string;
}

const SUBJECT_TAB_PREFIX = "subject-";
let subjectTabsOpened = 0;

const registry = (context: ActionContext) => context.datasource?.capabilities.includes("schemaRegistry") === true;

function activeSubject(context: ActionContext) {
  return context.activeTab?.kind === "subject" ? (useSubjectTabs.getState().tabs[context.activeTab.id] ?? null) : null;
}

/** Opens the subject in a subject tab (audit m12), or brings its open tab forward. */
export function openSubject(target: SubjectTarget): void {
  const existing = Object.entries(useSubjectTabs.getState().tabs).find(
    ([, tab]) => tab.datasourceId === target.datasourceId && tab.subject === target.subject,
  )?.[0];
  if (existing !== undefined) {
    useTabs.getState().activate(existing);
    return;
  }
  const tab: Tab = {
    id: `${SUBJECT_TAB_PREFIX}${String(subjectTabsOpened++)}`,
    kind: "subject",
    title: target.subject,
  };
  useTabs.getState().open(tab);
  void useSubjectTabs.getState().open(tab.id, target);
}

function schemaDialog(mode: "check" | "register") {
  return guarded(mode === "check" ? "Check Compatibility" : "Register New Version", async (context: ActionContext) => {
    const tab = activeSubject(context);
    if (context.activeTab === null || tab === null) return;
    const id = context.activeTab.id;
    const client = await useDatasources.getState().connect(tab.datasourceId);
    const changed = await useStreamDialog.getState().ask({
      kind: "schema",
      mode,
      datasource: dialogDatasource(context, tab.datasourceId),
      subject: tab.subject,
      type: tab.schema?.type ?? "AVRO",
      initial: schemaText(tab.schema),
      check: (schemaType, schema) => client.call("schemas.check", { subject: tab.subject, schemaType, schema }),
      register: (schemaType, schema) => client.call("schemas.register", { subject: tab.subject, schemaType, schema }),
    });
    if (!changed) return;
    await Promise.all([useSubjectTabs.getState().refresh(id), useStreams.getState().synchronize(tab.datasourceId)]);
  });
}

export const SUBJECT_ACTIONS: readonly AnyAction[] = [
  defineAction<SubjectTarget | undefined>({
    id: SUBJECT_ACTION_IDS.open,
    title: "Open Subject",
    category: "Streams",
    available: registry,
    inPalette: false,
    run: (_context, args) => {
      if (args !== undefined) openSubject(args);
    },
  }),
  defineAction({
    id: SUBJECT_ACTION_IDS.refresh,
    title: "Refresh Subject",
    category: "Streams",
    icon: "synchronize",
    tabKind: "subject",
    when: (context) => activeSubject(context)?.loading === false,
    run: async (context) => {
      if (context.activeTab !== null) await useSubjectTabs.getState().refresh(context.activeTab.id);
    },
  }),
  defineAction<SubjectVersionArgs | undefined>({
    id: SUBJECT_ACTION_IDS.selectVersion,
    title: "Show Schema Version",
    category: "Streams",
    tabKind: "subject",
    inPalette: false,
    run: async (context, args) => {
      if (context.activeTab !== null && args !== undefined)
        await useSubjectTabs.getState().select(context.activeTab.id, args.version);
    },
  }),
  defineAction({
    id: SUBJECT_ACTION_IDS.check,
    title: "Check Compatibility…",
    category: "Streams",
    tabKind: "subject",
    when: (context) => context.datasource?.connection.status === "connected",
    run: schemaDialog("check"),
  }),
  defineAction({
    id: SUBJECT_ACTION_IDS.register,
    title: "Register New Version…",
    category: "Streams",
    icon: "add",
    tabKind: "subject",
    when: (context) =>
      context.datasource?.connection.status === "connected" && context.datasource.view.readOnly !== true,
    run: schemaDialog("register"),
  }),
  defineAction<BrokerArgs | undefined>({
    id: SUBJECT_ACTION_IDS.brokerInfo,
    title: "Broker Info",
    category: "Streams",
    icon: "server",
    inPalette: false,
    run: async (_context, args) => {
      if (args === undefined) return;
      await openServerIn({ tabs: useTabs, server: useServer }, args.datasourceId);
      const tab = serverTabOf(useServer.getState().tabs, args.datasourceId);
      if (tab !== null) await useServer.getState().setNode(tab, args.node);
    },
  }),
];
