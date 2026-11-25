import { ACTION_IDS } from "@table-craft/desktop/renderer/actions/appActions.js";
import { GROUP_ACTION_IDS, type OpenGroupArgs } from "@table-craft/desktop/renderer/actions/groupActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { TOPIC_ACTION_IDS, type OpenTopicArgs } from "@table-craft/desktop/renderer/actions/topicActions.js";
import type { ExplorerNode } from "@table-craft/desktop/renderer/model/explorerTree.js";
import { STREAM_TREE_KINDS } from "@table-craft/desktop/renderer/model/streamTree.js";
import type { MenuEntry } from "@table-craft/desktop/renderer/panes/menuEntries.js";
import { SUBJECT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/subjectActions.js";
import { TAIL_ACTION_IDS } from "@table-craft/desktop/renderer/tail/actions.js";

const TOPIC_MENU = [
  TOPIC_ACTION_IDS.open,
  TAIL_ACTION_IDS.start,
  TOPIC_ACTION_IDS.produce,
  null,
  TOPIC_ACTION_IDS.editConfigs,
  TOPIC_ACTION_IDS.addPartitions,
  TOPIC_ACTION_IDS.deleteRecords,
  TOPIC_ACTION_IDS.delete,
  null,
  ACTION_IDS.synchronize,
  TOPIC_ACTION_IDS.copyName,
  null,
  TOPIC_ACTION_IDS.toggleInternal,
  TOPIC_ACTION_IDS.manageShown,
] as const;

const GROUP_MENU = [
  GROUP_ACTION_IDS.open,
  GROUP_ACTION_IDS.resetOffsets,
  null,
  GROUP_ACTION_IDS.deleteOffsets,
  GROUP_ACTION_IDS.delete,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
] as const;

const STREAM_MENU = [
  TOPIC_ACTION_IDS.create,
  ACTION_IDS.newConsole,
  null,
  ACTION_IDS.synchronize,
  ACTION_IDS.copyName,
  null,
  TOPIC_ACTION_IDS.toggleInternal,
  TOPIC_ACTION_IDS.manageShown,
] as const;

/** A stream tree row's context menu (decision 169); null for any other row. */
export function streamMenuOf(node: ExplorerNode): readonly MenuEntry[] | null {
  if (node.kind === "topic") return TOPIC_MENU;
  if (node.kind === "consumerGroup") return GROUP_MENU;
  return STREAM_TREE_KINDS.has(node.kind) ? STREAM_MENU : null;
}

/** Opens a topic or group row in its tab; false for any other row. */
export function activateStreamRow(node: ExplorerNode): boolean {
  if (node.kind === "topic") {
    const args: OpenTopicArgs = { datasourceId: node.datasourceId, topic: node.topic.name };
    invoke(TOPIC_ACTION_IDS.open, args);
    return true;
  }
  if (node.kind === "consumerGroup") {
    const args: OpenGroupArgs = { datasourceId: node.datasourceId, group: node.group.id };
    invoke(GROUP_ACTION_IDS.open, args);
    return true;
  }
  if (node.kind === "subject") {
    invoke(SUBJECT_ACTION_IDS.open, { datasourceId: node.datasourceId, subject: node.subject.subject });
    return true;
  }
  if (node.kind === "broker") {
    invoke(SUBJECT_ACTION_IDS.brokerInfo, { datasourceId: node.datasourceId, node: node.broker.id });
    return true;
  }
  return false;
}

/** Stable handles on stream rows for the end-to-end suites: `stream-topic` and the topic's name, say. */
export function streamRowAttributes(node: ExplorerNode): Readonly<Record<string, string>> {
  if (!STREAM_TREE_KINDS.has(node.kind)) return {};
  return { "data-testid": `stream-${node.kind}`, "data-name": streamRowName(node) };
}

function streamRowName(node: ExplorerNode): string {
  switch (node.kind) {
    case "streamSection":
      return node.section;
    case "topicFolder":
      return node.prefix;
    case "topic":
      return node.topic.name;
    case "consumerGroup":
      return node.group.id;
    case "broker":
      return node.broker.id;
    case "subject":
      return node.subject.subject;
    default:
      return "";
  }
}
