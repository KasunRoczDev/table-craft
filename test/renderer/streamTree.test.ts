import { describe, expect, it } from "vitest";
import type { GroupSummary, ServerNode, TopicSummary } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { explorerRows, keyTreeKey, type ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  approxCount,
  brokerDetail,
  EMPTY_STREAMS,
  lagWarningOf,
  streamStatusText,
  subjectDetail,
  nounFor,
  topicDetail,
  topicFolders,
  type DatasourceStreams,
} from "@table-craft/desktop/renderer/model/streamTree.js";

function topic(name: string, partitions = 1, messages: string | null = "10", internal = false): TopicSummary {
  return { name, internal, partitions, replicationFactor: 3, messages };
}

function group(id: string, lag: string | null, state = "Stable"): GroupSummary {
  return { id, state, protocolType: "consumer", members: 0, lag };
}

const BROKER: ServerNode = {
  id: "1",
  address: "kafka-1:9093",
  role: "primary",
  slots: [],
  primaryId: null,
  state: "online, controller",
};

const DATASOURCE = {
  id: "kafka",
  name: "kafka-prod",
  pluginId: "kafka",
  folder: null,
  color: null,
  readOnly: false,
  comment: "",
  config: { lagWarning: 100 },
  secretModes: {},
} as unknown as DatasourceView;

const STREAMS: DatasourceStreams = {
  ...EMPTY_STREAMS,
  topics: [
    topic("orders.v1", 12, "3400000"),
    topic("orders.v1.dlq", 3, "14"),
    topic("audit.log", 1, "84000"),
    topic("plain"),
    topic("__consumer_offsets", 50, null, true),
  ],
  groups: [group("billing-worker", "18893", "Empty"), group("live-worker", "12")],
  brokers: [BROKER],
  registry: { available: true, reason: null },
  subjects: [{ subject: "orders.v1-value", latestVersion: 2, type: "AVRO" }],
};

function rows(streams: DatasourceStreams, showSystem: boolean, expanded: readonly string[]): readonly ExplorerRow[] {
  return explorerRows({
    tree: [{ kind: "datasource", datasource: DATASOURCE }],
    catalogs: {},
    expanded: new Set(["datasource:kafka", ...expanded]),
    collapsedFolders: new Set(),
    showSystem,
    canExpand: () => true,
    streams: { kafka: streams },
    browsesStreams: () => true,
  });
}

const SECTIONS = ["topics", "groups", "brokers", "subjects"].map((section) =>
  keyTreeKey("kafka", "streamSection", section),
);

describe("stream tree", () => {
  it("givenDottedTopics_whenGrouped_thenFolders", () => {
    const { folders, loose } = topicFolders(STREAMS.topics ?? []);
    expect(folders.map((folder) => [folder.prefix, folder.topics.map((each) => each.name)])).toEqual([
      ["orders.", ["orders.v1", "orders.v1.dlq"]],
    ]);
    expect(loose.map((each) => each.name)).toEqual(["__consumer_offsets", "audit.log", "plain"]);
  });

  it("givenEveryTopicSharesThePrefix_whenGrouped_thenNoFolder", () => {
    const { folders, loose } = topicFolders([topic("prod.a"), topic("prod.b")]);
    expect(folders).toEqual([]);
    expect(loose.map((each) => each.name)).toEqual(["prod.a", "prod.b"]);
  });

  it("givenExpandedFolder_whenRows_thenLeavesKeepTheirFullNames", () => {
    const shown = rows(STREAMS, false, [...SECTIONS, keyTreeKey("kafka", "topicFolder", "orders.")]);
    const labels = shown.map((row) => `${"  ".repeat(row.depth)}${row.node.kind}:${row.label}`);
    expect(labels).toContain("      topic:orders.v1");
    expect(labels).toContain("      topic:orders.v1.dlq");
    expect(labels).toContain("    topic:audit.log");
    expect(labels).not.toContain("    topicFolder:audit.");
  });

  it("givenInternalTopics_whenShowSystemOff_thenHidden", () => {
    const hidden = rows(STREAMS, false, SECTIONS).filter((row) => row.node.kind === "topic");
    const shown = rows(STREAMS, true, SECTIONS).filter((row) => row.node.kind === "topic");
    expect(hidden.map((row) => row.label)).toEqual(["audit.log", "plain"]);
    expect(shown.map((row) => row.label)).toEqual(["__consumer_offsets", "audit.log", "plain"]);
    const topics = rows(STREAMS, false, SECTIONS).find((row) => row.node.kind === "streamSection");
    expect(topics?.node).toMatchObject({ section: "topics", count: 4 });
  });

  it("givenLagAboveTheDatasourceWarning_whenRows_thenGroupLagging", () => {
    const groups = rows(STREAMS, false, SECTIONS).filter((row) => row.node.kind === "consumerGroup");
    expect(groups.map((row) => [row.label, row.node.kind === "consumerGroup" && row.node.lagging])).toEqual([
      ["billing-worker", true],
      ["live-worker", false],
    ]);
    expect(lagWarningOf({})).toBe(10_000);
    expect(lagWarningOf({ lagWarning: "250" })).toBe(250);
  });

  it("givenRegistryUnavailable_whenRows_thenNoSubjects", () => {
    const kinds = (streams: DatasourceStreams) =>
      rows(streams, false, SECTIONS)
        .filter((row) => row.node.kind === "streamSection")
        .map((row) => (row.node.kind === "streamSection" ? row.node.section : ""));
    expect(kinds(STREAMS)).toEqual(["topics", "groups", "brokers", "subjects"]);
    expect(kinds({ ...STREAMS, registry: { available: false, reason: "No URL" }, groups: null, brokers: [] })).toEqual([
      "topics",
    ]);
  });

  it("givenUnlisted_whenRows_thenLoadingOrError", () => {
    expect(rows(EMPTY_STREAMS, false, []).map((row) => row.node.kind)).toEqual(["datasource", "loading"]);
    const failed = { ...EMPTY_STREAMS, error: { code: "connectionFailed" as const, message: "down", hint: "" } };
    expect(rows(failed, false, []).map((row) => row.node.kind)).toEqual(["datasource", "error"]);
  });

  it("givenCounts_whenLabelled_thenEstimatesRead", () => {
    expect(approxCount("14")).toBe("14");
    expect(approxCount("84000")).toBe("~84 k");
    expect(approxCount("3400000")).toBe("~3.4 M");
    expect(approxCount(null)).toBeNull();
    expect(topicDetail(topic("orders.v1", 12, "3400000"))).toBe("12 partitions · ~3.4 M messages");
    expect(topicDetail(topic("one", 1, null))).toBe("1 partition");
    expect(topicDetail(topic("boot", 1, "1"))).toBe("1 partition · 1 message");
    expect(nounFor(1, "partition")).toBe("partition");
    expect(nounFor("~3 k", "message")).toBe("messages");
    expect(subjectDetail({ subject: "s", latestVersion: 5, type: "PROTOBUF" })).toBe("v5 · Protobuf");
    expect(brokerDetail(BROKER)).toBe("kafka-1:9093 · controller");
  });

  it("givenListed_whenStatus_thenBrokersAndRegistry", () => {
    expect(streamStatusText(STREAMS)).toBe("1 broker · Schema Registry · 1 subject");
    expect(streamStatusText({ ...STREAMS, brokers: [], registry: null })).toBe("4 topics");
    expect(streamStatusText(EMPTY_STREAMS)).toBeNull();
  });
});
