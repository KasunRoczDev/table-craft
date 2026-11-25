import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { datasourceTarget, type ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { MESSAGE_PREVIEW_CHARS } from "@table-craft/desktop/engine/protocol.js";
import { canWriteGroup } from "@table-craft/desktop/renderer/actions/groupActions.js";
import { createActionRegistry } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  canWriteStreams,
  canWriteTopic,
  producible,
  TOPIC_ACTION_IDS,
  TOPIC_ACTIONS,
  topicTarget,
} from "@table-craft/desktop/renderer/actions/topicActions.js";
import { catalogKeyPrefix } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { buttonClass } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import type { TopicMessage } from "@table-craft/desktop/renderer/model/topicMessage.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { EMPTY_PRODUCE } from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { produceRecordOf } from "@table-craft/desktop/renderer/streams/ProduceDialog.js";
import { IDLE_CONTEXT } from "./support.js";

function source(id: string, readOnly: boolean): DatasourceView {
  return {
    id,
    name: id,
    pluginId: "kafka",
    folder: null,
    color: null,
    readOnly,
    comment: "",
    config: {},
    secretModes: {},
    storedSecrets: [],
    ephemeral: false,
  };
}

const WRITABLE = source("kafka-a", false);
const READ_ONLY = source("kafka-b", true);
const CONNECTED = { status: "connected", error: null, serverVersion: null, serverBrand: null } as const;

/** The active tab's datasource is A, connected and writable; the tree's selection may name B. */
const CONTEXT: ActionContext = {
  ...IDLE_CONTEXT,
  datasources: [WRITABLE, READ_ONLY],
  datasource: { view: WRITABLE, connection: CONNECTED, capabilities: ["topics", "consumerGroups"] },
};

describe("stream write checks", () => {
  const initial = useDatasources.getState();

  beforeEach(() => {
    useDatasources.setState({
      datasources: [WRITABLE, READ_ONLY],
      plugins: [{ id: "kafka", capabilities: ["topics", "consumerGroups"] } as never],
      connections: { "kafka-a": CONNECTED, "kafka-b": CONNECTED },
    });
  });

  afterEach(() => useDatasources.setState(initial, true));

  it("givenTargetOnAnotherReadOnlyDatasource_whenChecked_thenThatDatasourceDecides", () => {
    expect(canWriteStreams(CONTEXT, "kafka-a")).toBe(true);
    expect(canWriteStreams(CONTEXT, "kafka-b")).toBe(false);
    expect(canWriteStreams(CONTEXT, "kafka-b", "consumerGroups")).toBe(false);
  });

  it("givenTargetOnAnotherDisconnectedDatasource_whenChecked_thenRefused", () => {
    useDatasources.setState({
      datasources: [WRITABLE, { ...READ_ONLY, readOnly: false }],
      connections: { "kafka-a": CONNECTED },
    });
    expect(canWriteStreams(CONTEXT, "kafka-b")).toBe(false);
  });

  it("givenTargetWithoutTheCapability_whenChecked_thenRefused", () => {
    useDatasources.setState({ plugins: [{ id: "kafka", capabilities: ["topics"] } as never] });
    expect(canWriteStreams({ ...CONTEXT, datasource: null }, "kafka-a", "consumerGroups")).toBe(false);
  });
});

describe("tab buttons with their own target", () => {
  const initial = useDatasources.getState();
  const TAB_TOPIC = { datasourceId: "kafka-a", topic: "orders" };
  const MYSQL: DatasourceView = { ...source("mysql-c", false), pluginId: "mysql" };
  const registry = createActionRegistry(() => IDLE_CONTEXT);
  registry.register(TOPIC_ACTIONS);

  /** Focus in the Database tree, its selection `kind` on datasource `id`: what a toolbar click keeps. */
  function treeSelects(id: string, kind: string, name: string): ActionContext {
    return {
      ...IDLE_CONTEXT,
      datasources: [WRITABLE, READ_ONLY, MYSQL],
      inDatabasePane: true,
      selection: {
        kind: "catalog",
        id,
        key: `${catalogKeyPrefix(id)}${JSON.stringify([kind, name]).slice(1)}`,
        path: [],
        name: null,
      },
      datasource: datasourceTarget(id),
    };
  }

  beforeEach(() => {
    useDatasources.setState({
      datasources: [WRITABLE, READ_ONLY, MYSQL],
      plugins: [
        { id: "kafka", capabilities: ["topics", "consumerGroups"] } as never,
        { id: "mysql", capabilities: [] } as never,
      ],
      connections: { "kafka-a": CONNECTED, "kafka-b": CONNECTED, "mysql-c": CONNECTED },
    });
  });

  afterEach(() => useDatasources.setState(initial, true));

  it("givenTreeSelectsAGroup_whenTabButtonsPassTheirTopic_thenEnabledAndActOnTheTab", () => {
    const context = treeSelects("kafka-b", "consumerGroup", "billing");
    expect(topicTarget(context, TAB_TOPIC)).toEqual(TAB_TOPIC);
    for (const id of [TOPIC_ACTION_IDS.addPartitions, TOPIC_ACTION_IDS.deleteRecords, TOPIC_ACTION_IDS.editConfigs]) {
      expect(registry.isEnabled(id, context)).toBe(false);
      expect(registry.isEnabled(id, context, TAB_TOPIC)).toBe(true);
    }
  });

  it("givenTreeSelectsAnotherTopicOrAnotherDatasource_whenTabButtonsPassTheirTopic_thenTheTabDecides", () => {
    const otherTopic = treeSelects("kafka-b", "topic", "payments");
    expect(topicTarget(otherTopic)).toEqual({ datasourceId: "kafka-b", topic: "payments" });
    expect(canWriteTopic(otherTopic)).toBe(false);
    expect(canWriteTopic(otherTopic, TAB_TOPIC)).toBe(true);
    expect(canWriteGroup(otherTopic)).toBe(false);
    expect(canWriteGroup(otherTopic, { datasourceId: "kafka-a", group: "billing" })).toBe(true);
    const mysql = treeSelects("mysql-c", "relation", "users");
    expect(registry.isAvailable(TOPIC_ACTION_IDS.addPartitions, mysql)).toBe(false);
    expect(registry.isEnabled(TOPIC_ACTION_IDS.addPartitions, mysql, TAB_TOPIC)).toBe(true);
  });

  it("givenTheTabsOwnDatasourceReadOnly_whenItsButtonsAsk_thenDisabled", () => {
    const context = treeSelects("kafka-a", "topic", "orders");
    expect(
      registry.isEnabled(TOPIC_ACTION_IDS.deleteRecords, context, { datasourceId: "kafka-b", topic: "orders" }),
    ).toBe(false);
  });
});

describe("inline action buttons", () => {
  it("givenInlineTextButton_whenClassed_thenSquareUnframedAndFillsItsStrip", () => {
    const inline = buttonClass(false, false, undefined, true).split(" ");
    expect(inline).toEqual(expect.arrayContaining(["h-full", "px-gap", "hover:bg-hover"]));
    expect(inline.some((name) => name.startsWith("rounded") || name.startsWith("border"))).toBe(false);
    expect(buttonClass(false, false, "danger", true)).toBe(buttonClass(false, false, undefined, true));
    expect(buttonClass(false, false, undefined).split(" ")).toEqual(expect.arrayContaining(["rounded", "border"]));
  });
});

describe("produce dialog fields", () => {
  const SUBJECTS = { key: "", value: "", keyVersion: "", valueVersion: "" };

  it("givenPartitionPastInt32_whenProduced_thenRefusedInTheDialog", () => {
    const draft = { ...EMPTY_PRODUCE, value: "v" };
    expect(produceRecordOf("orders", { ...draft, partition: "2147483648" }, SUBJECTS)).toMatch(/2,147,483,647/);
    expect(produceRecordOf("orders", { ...draft, partition: "2147483647" }, SUBJECTS)).toMatchObject({
      partition: 2_147_483_647,
    });
  });
});

describe("produce again from a row", () => {
  const message = {
    partition: 0,
    offset: "7",
    timestamp: null,
    key: "k",
    value: "small",
    valueJson: false,
    headers: [],
    keySchema: null,
    valueSchema: null,
  } as unknown as TopicMessage;

  it("givenOnlyThePreviewLeft_whenProducedAgain_thenRefusedBeforeTheDialog", () => {
    const cut = { ...message, value: `${"v".repeat(MESSAGE_PREVIEW_CHARS)}…` };
    expect(() => producible(cut)).toThrow(/cut record/);
    expect(producible(message)).toBe(message);
  });
});
