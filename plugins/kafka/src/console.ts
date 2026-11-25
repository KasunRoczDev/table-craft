import {
  MESSAGE_FORMATS,
  PluginError,
  SCHEMA_TYPES,
  TOPIC_MESSAGE_COLUMNS,
  TOPIC_READ_LIMIT,
  type ExecuteResult,
  type GroupManager,
  type MessageFormat,
  type ResetTarget,
  type SchemaReference,
  type SchemaRegistry,
  type SchemaType,
  type TopicRead,
  type TopicReadRequest,
  type TopicStart,
  type WireValue,
} from "@table-craft/plugin-api";
import type { KafkaAdmin } from "./admin.js";
import {
  argumentsOf,
  flagValue,
  flagValues,
  hasFlag,
  keyValue,
  partitionList,
  usage,
  wholeNumber,
  type Arguments,
} from "./args.js";
import { brokerRows } from "./brokers.js";
import { COMMANDS, commandOf, type CommandDoc } from "./docs.js";
import { classify } from "./language.js";
import { readOnlyRefusal } from "./readOnly.js";
import { columnsOf, decimalCell, replyResult, tableResult } from "./results.js";
import type { TopicAdmin } from "./topicAdmin.js";
import type { KafkaTopics } from "./topics.js";
import { tokenize } from "./tokens.js";

const ALL_TOPICS = "*";
const LATEST_N = /^-(\d+)$/;
const PREFIXED = /^(offset|time|group|shift):(.+)$/s;
const SUBJECT_VERSION = /^(.+?)(?::(\d+|latest))?$/;
const LATEST = "latest";
const MS_PER_SECOND = 1000;
const NIL = "(nil)";
const MESSAGE_OFFSET_COLUMN = TOPIC_MESSAGE_COLUMNS.indexOf("offset");
const MESSAGE_VALUE_COLUMN = TOPIC_MESSAGE_COLUMNS.indexOf("value");

/** What the console reaches on its session. */
export interface ConsoleHost {
  readonly readOnly: boolean;
  readonly admin: KafkaAdmin;
  readonly topics: KafkaTopics;
  /** A read that keeps what arrives past the end for `followMs` (`consume --wait`). */
  follow(request: TopicReadRequest, followMs: number): Promise<TopicRead>;
  readonly topicAdmin: TopicAdmin;
  readonly groups: GroupManager;
  readonly registry: SchemaRegistry;
}

function formatOf(doc: CommandDoc, text: string | null): MessageFormat {
  if (text === null) return "auto";
  const format = MESSAGE_FORMATS.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
  if (format === undefined) throw usage(doc, `${text} is not a format; use ${MESSAGE_FORMATS.join(", ")}.`);
  return format;
}

function startOf(doc: CommandDoc, text: string | null): TopicStart {
  if (text === null || text === "earliest") return { kind: "earliest" };
  if (text === LATEST) return { kind: "latest" };
  const latest = LATEST_N.exec(text);
  if (latest !== null) return { kind: "latestN", count: Number(latest[1]) };
  const prefixed = PREFIXED.exec(text);
  switch (prefixed?.[1]) {
    case "offset":
      return { kind: "offset", offset: String(wholeNumber(doc, "the offset", prefixed[2] ?? "")) };
    case "time":
      return { kind: "timestamp", timestamp: prefixed[2] ?? "" };
    case "group":
      return { kind: "group", group: prefixed[2] ?? "" };
    default:
      throw usage(doc, `--from takes earliest, latest, -N, offset:N, time:ISO or group:id, not ${text}.`);
  }
}

function resetTargetOf(doc: CommandDoc, text: string | null): ResetTarget {
  if (text === null) throw usage(doc, "say where to with --to.");
  if (text === "earliest" || text === LATEST) return { kind: text };
  const prefixed = PREFIXED.exec(text);
  switch (prefixed?.[1]) {
    case "offset":
      return { kind: "offset", offset: String(wholeNumber(doc, "the offset", prefixed[2] ?? "")) };
    case "time":
      return { kind: "timestamp", timestamp: prefixed[2] ?? "" };
    case "shift": {
      const by = prefixed[2] ?? "";
      if (!/^[-+]?\d+$/.test(by)) throw usage(doc, `shift takes a whole number such as -100, not ${by}.`);
      return { kind: "shift", by: by.replace(/^\+/, "") };
    }
    default:
      throw usage(doc, `--to takes earliest, latest, offset:N, time:ISO or shift:±N, not ${text}.`);
  }
}

function schemaReference(text: string | null): SchemaReference | null {
  if (text === null) return null;
  const match = SUBJECT_VERSION.exec(text);
  const version = match?.[2];
  return { subject: match?.[1] ?? text, version: version === undefined || version === LATEST ? null : Number(version) };
}

function text(args: Arguments, index: number): string {
  return args.positional[index]?.text ?? "";
}

function thousands(value: string | null): string {
  return value === null ? "?" : BigInt(value).toLocaleString("en-US");
}

async function consume(host: ConsoleHost, doc: CommandDoc, args: Arguments): Promise<ExecuteResult> {
  const from = startOf(doc, flagValue(args, "from"));
  const limitText = flagValue(args, "limit");
  const limit =
    limitText === null
      ? from.kind === "latestN"
        ? from.count
        : TOPIC_READ_LIMIT
      : wholeNumber(doc, "--limit", limitText);
  const partitions = flagValue(args, "partitions");
  const wait = flagValue(args, "wait");
  const request: TopicReadRequest = {
    topic: text(args, 0),
    partitions: partitions === null ? null : partitionList(doc, partitions),
    from,
    limit,
    keyFormat: formatOf(doc, flagValue(args, "key-format")),
    valueFormat: formatOf(doc, flagValue(args, "value-format")),
    filter: flagValue(args, "grep"),
    maxScan: null,
    resume: null,
  };
  const read =
    wait === null
      ? await host.topics.read(request)
      : await host.follow(request, wholeNumber(doc, "--wait", wait) * MS_PER_SECOND);
  return read.result;
}

/** How Output shows a value read, as `redis-cli` shows a bulk string; bytes as hex. */
function valueText(value: WireValue): string {
  if (value === null) return NIL;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value !== "object") return String(value);
  switch (value.kind) {
    case "bytes":
      return `0x${value.preview}${value.preview.length < value.length * 2 ? "…" : ""}`;
    case "json":
      return value.text;
    case "bigint":
      return value.value;
    case "date":
      return value.iso;
  }
}

async function message(host: ConsoleHost, doc: CommandDoc, args: Arguments): Promise<ExecuteResult> {
  const topic = text(args, 0);
  const partition = wholeNumber(doc, "the partition", text(args, 1));
  const offset = String(wholeNumber(doc, "the offset", text(args, 2)));
  const read = await host.topics.read({
    topic,
    partitions: [partition],
    from: { kind: "offset", offset },
    limit: 1,
    keyFormat: "auto",
    valueFormat: formatOf(doc, flagValue(args, "value-format")),
    filter: null,
    maxScan: 1,
    resume: null,
  });
  const row = (await firstRow(read.result))?.slice();
  const at = row?.[MESSAGE_OFFSET_COLUMN];
  if (row === undefined || typeof at !== "object" || at === null || !("value" in at) || at.value !== offset) {
    throw new PluginError(
      "statementFailed",
      `${topic} partition ${String(partition)} holds no message at offset ${offset}: it was deleted, compacted away or not written yet.`,
    );
  }
  const value = row[MESSAGE_VALUE_COLUMN] ?? null;
  return { ...replyResult(value, valueText(value)), reply: { value, text: valueText(value), read: true } };
}

async function firstRow(result: ExecuteResult): Promise<readonly WireValue[] | undefined> {
  for await (const row of result.rows) return row;
  return undefined;
}

async function produce(host: ConsoleHost, doc: CommandDoc, args: Arguments): Promise<ExecuteResult> {
  const topic = text(args, 0);
  const partition = flagValue(args, "partition");
  const result = await host.topics.produce({
    topic,
    partition: partition === null ? null : wholeNumber(doc, "--partition", partition),
    key: flagValue(args, "key"),
    value: text(args, 1),
    headers: flagValues(args, "header").map((header) => {
      const { name, value } = keyValue(doc, header);
      return { name, value };
    }),
    keyFormat: formatOf(doc, flagValue(args, "key-format")),
    valueFormat: formatOf(doc, flagValue(args, "value-format")),
    keySchema: schemaReference(flagValue(args, "key-schema")),
    valueSchema: schemaReference(flagValue(args, "value-schema")),
  });
  const where = `Sent to ${topic} partition ${String(result.partition)}`;
  return replyResult(
    result.offset === null ? null : decimalCell(result.offset),
    result.offset === null ? where : `${where} at offset ${thousands(result.offset)}`,
  );
}

async function describe(host: ConsoleHost, topic: string): Promise<ExecuteResult> {
  const described = await host.topics.describe(topic);
  const names = ["partition", "leader", "replicas", "isr", "offline", "low", "high", "messages", "bytes"];
  return tableResult(
    columnsOf(names, ["partition", "leader", "low", "high", "messages", "bytes"]),
    described.partitions.map((partition) => [
      partition.partition,
      partition.leader,
      partition.replicas.join(","),
      partition.isr.join(","),
      partition.offline.join(","),
      decimalCell(partition.low),
      decimalCell(partition.high),
      partition.low === null || partition.high === null
        ? null
        : decimalCell((BigInt(partition.high) - BigInt(partition.low)).toString()),
      decimalCell(partition.bytes),
    ]),
  );
}

async function resetOffsets(host: ConsoleHost, doc: CommandDoc, args: Arguments): Promise<ExecuteResult> {
  const group = text(args, 0);
  const topic = text(args, 1);
  const partitions = flagValue(args, "partitions");
  const preview = await host.groups.prepareReset(
    group,
    {
      topic: topic === ALL_TOPICS ? null : topic,
      partitions: partitions === null ? null : partitionList(doc, partitions),
    },
    resetTargetOf(doc, flagValue(args, "to")),
  );
  if (hasFlag(args, "dry-run")) {
    const names = ["topic", "partition", "current", "new", "high", "lag_after", "change"];
    return tableResult(
      columnsOf(names, ["partition", "current", "new", "high", "lag_after", "change"]),
      preview.partitions.map((row) => [
        row.topic,
        row.partition,
        decimalCell(row.current),
        decimalCell(row.next),
        decimalCell(row.high),
        decimalCell(row.lagAfter),
        decimalCell(row.change),
      ]),
    );
  }
  if (preview.token === null)
    throw new PluginError("statementFailed", `${preview.refusal ?? "The reset was refused"}. Nothing was changed.`);
  await host.groups.applyReset(preview.token);
  return replyResult(
    preview.partitions.length,
    `Reset ${String(preview.partitions.length)} partitions of ${group}: ${thousands(preview.skipped)} messages skipped, ${thousands(preview.reread)} to read again.`,
  );
}

async function alterConfig(host: ConsoleHost, doc: CommandDoc, args: Arguments): Promise<ExecuteResult> {
  const resource = text(args, 0);
  if (resource !== "topic" && resource !== "broker")
    throw usage(doc, `the resource is topic or broker, not ${resource}.`);
  const name = text(args, 1);
  const changes = [
    ...args.positional.slice(2).map((token) => keyValue(doc, token.text)),
    ...flagValues(args, "delete").map((key) => ({ name: key, value: null })),
  ];
  if (changes.length === 0) throw usage(doc, "give at least one k=v or --delete k.");
  const validateOnly = hasFlag(args, "validate-only");
  await host.topicAdmin.alter(resource, name, changes, { validateOnly });
  const what = `${String(changes.length)} ${changes.length === 1 ? "config" : "configs"} of ${resource} ${name}`;
  return replyResult(changes.length, validateOnly ? `Kafka would accept the change of ${what}.` : `Altered ${what}.`);
}

async function deleteRecords(host: ConsoleHost, doc: CommandDoc, args: Arguments): Promise<ExecuteResult> {
  const topic = text(args, 0);
  const partition = wholeNumber(doc, "the partition", text(args, 1));
  const before = String(wholeNumber(doc, "the offset", text(args, 2)));
  const preview = await host.topics.prepareDeleteRecords(topic, [partition], { kind: "offset", offset: before });
  await host.topics.deleteRecordsPrepared(preview.token);
  const low = preview.partitions[0]?.newLow ?? before;
  return replyResult(
    decimalCell(preview.removed),
    `Deleted ${thousands(preview.removed)} records of ${topic} partition ${String(partition)}; its low watermark is now ${thousands(low)}.`,
  );
}

async function compatibility(host: ConsoleHost, args: Arguments, doc: CommandDoc): Promise<ExecuteResult> {
  const global = hasFlag(args, "global");
  const subject = global ? null : args.positional[0]?.text;
  if (subject === undefined) throw usage(doc, "name a subject, or give --global.");
  const level = (global ? args.positional[0]?.text : args.positional[1]?.text) ?? null;
  const answer = await host.registry.compatibility(subject, level);
  return replyResult(
    answer,
    level === null ? answer : `Compatibility of ${subject ?? "the registry"} is now ${answer}.`,
  );
}

function schemaTypeOf(doc: CommandDoc, value: string): SchemaType {
  const type = SCHEMA_TYPES.find((candidate) => candidate === value.toUpperCase());
  if (type === undefined) throw usage(doc, `the type is ${SCHEMA_TYPES.join(", ")}, not ${value}.`);
  return type;
}

async function runDoc(host: ConsoleHost, doc: CommandDoc, args: Arguments): Promise<ExecuteResult> {
  switch (doc.name) {
    case "topics": {
      const topics = await host.topics.list({
        glob: args.positional[0]?.text ?? null,
        internal: hasFlag(args, "internal"),
      });
      return tableResult(
        columnsOf(
          ["topic", "partitions", "replication", "messages", "internal"],
          ["partitions", "replication", "messages"],
        ),
        topics.map((topic) => [
          topic.name,
          topic.partitions,
          topic.replicationFactor,
          decimalCell(topic.messages),
          topic.internal,
        ]),
      );
    }
    case "describe":
      return describe(host, text(args, 0));
    case "consume":
      return consume(host, doc, args);
    case "message":
      return message(host, doc, args);
    case "produce":
      return produce(host, doc, args);
    case "create-topic": {
      const name = text(args, 0);
      const partitions = flagValue(args, "partitions");
      const replication = flagValue(args, "replication");
      const count = partitions === null ? 1 : wholeNumber(doc, "--partitions", partitions);
      const validateOnly = hasFlag(args, "validate-only");
      await host.topics.create(
        {
          name,
          partitions: count,
          replicationFactor: replication === null ? null : wholeNumber(doc, "--replication", replication),
          configs: flagValues(args, "config").map((config) => keyValue(doc, config)),
        },
        { validateOnly },
      );
      const what = `topic ${name} with ${String(count)} ${count === 1 ? "partition" : "partitions"}`;
      return replyResult("OK", validateOnly ? `Kafka would create ${what}.` : `Created ${what}.`);
    }
    case "delete-topic":
      await host.topics.remove(text(args, 0));
      return replyResult("OK", `Deleted topic ${text(args, 0)}.`);
    case "alter-config":
      return alterConfig(host, doc, args);
    case "add-partitions": {
      const total = wholeNumber(doc, "the total", text(args, 1));
      const validateOnly = hasFlag(args, "validate-only");
      await host.topics.addPartitions(text(args, 0), total, { validateOnly });
      return replyResult(
        total,
        `${validateOnly ? "Kafka would raise" : "Raised"} ${text(args, 0)} to ${String(total)} partitions.`,
      );
    }
    case "delete-records":
      return deleteRecords(host, doc, args);
    case "groups": {
      const state = args.positional[0]?.text.toLowerCase() ?? null;
      const groups = (await host.groups.list()).filter(
        (group) => state === null || group.state.toLowerCase() === state,
      );
      return tableResult(
        columnsOf(["group", "state", "protocol_type", "lag"], ["lag"]),
        groups.map((group) => [group.id, group.state, group.protocolType, decimalCell(group.lag)]),
      );
    }
    case "group": {
      const group = await host.groups.describe(text(args, 0));
      return tableResult(
        columnsOf(["member", "instance", "client_id", "host", "assignments"]),
        group.members.map((member) => [
          member.id,
          member.instanceId,
          member.clientId,
          member.host,
          member.assignments.map((assignment) => `${assignment.topic}: ${assignment.partitions.join(",")}`).join("; "),
        ]),
      );
    }
    case "lag": {
      const group = await host.groups.describe(text(args, 0));
      return tableResult(
        columnsOf(["topic", "partition", "committed", "high", "lag"], ["partition", "committed", "high", "lag"]),
        group.offsets.map((offset) => [
          offset.topic,
          offset.partition,
          decimalCell(offset.committed),
          decimalCell(offset.high),
          decimalCell(offset.lag),
        ]),
      );
    }
    case "reset-offsets":
      return resetOffsets(host, doc, args);
    case "delete-group":
      await host.groups.remove(text(args, 0));
      return replyResult("OK", `Deleted group ${text(args, 0)}.`);
    case "delete-offsets":
      await host.groups.deleteOffsets(text(args, 0), text(args, 1));
      return replyResult("OK", `Deleted the offsets of ${text(args, 0)} on ${text(args, 1)}.`);
    case "brokers": {
      const brokers = await brokerRows(host.admin);
      return tableResult(
        columnsOf(["id", "host", "port", "rack", "controller"], ["id", "port"]),
        brokers.map((broker) => [broker.id, broker.host, broker.port, broker.rack, broker.controller]),
      );
    }
    case "subjects": {
      const subjects = await host.registry.subjects(args.positional[0]?.text ?? null);
      return tableResult(
        columnsOf(["subject", "latest_version", "type"], ["latest_version"]),
        subjects.map((subject) => [subject.subject, subject.latestVersion, subject.type]),
      );
    }
    case "schema": {
      const version = args.positional[1]?.text;
      const found = await host.registry.get(
        text(args, 0),
        version === undefined || version === LATEST ? null : wholeNumber(doc, "the version", version),
      );
      return tableResult(columnsOf(["subject", "version", "id", "type", "schema"], ["version", "id"]), [
        [found.subject, found.version, found.id, found.type, found.schema],
      ]);
    }
    case "register": {
      const subject = text(args, 0);
      const registered = await host.registry.register(subject, schemaTypeOf(doc, text(args, 1)), text(args, 2));
      const version = registered.version === null ? "" : ` as version ${String(registered.version)}`;
      return replyResult(registered.id, `Registered schema id ${String(registered.id)}${version} of ${subject}.`);
    }
    case "compatibility":
      return compatibility(host, args, doc);
    default:
      throw new PluginError("statementFailed", `${doc.name} has no runner.`);
  }
}

function unknown(name: string): PluginError {
  return new PluginError(
    "statementFailed",
    `${name} is not a command this console runs. It runs ${COMMANDS.map((doc) => doc.name).join(", ")}.`,
  );
}

/**
 * Runs one console command (decision 9 of plan 164). A write on a read-only datasource is refused
 * before anything is sent; the host confirmed a destructive one before calling.
 */
export async function runCommand(host: ConsoleHost, command: string): Promise<ExecuteResult> {
  const tokens = tokenize(command);
  const first = tokens[0];
  if (first === undefined) throw new PluginError("statementFailed", "Nothing to run: the command is empty.");
  if (tokens.some((token) => !token.closed)) {
    throw new PluginError("statementFailed", "A quote or bracket is not closed. Close it and run the command again.");
  }
  const doc = commandOf(first.text);
  if (doc === null) throw unknown(first.text);
  if (host.readOnly && classify(command).kind !== "read") throw readOnlyRefusal(doc.name);
  return runDoc(host, doc, argumentsOf(doc, tokens.slice(1)));
}
