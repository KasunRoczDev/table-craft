import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import { MESSAGE_PREVIEW_CHARS } from "@table-craft/desktop/engine/protocol.js";
import { canWriteStreams, producible } from "@table-craft/desktop/renderer/actions/topicActions.js";
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
