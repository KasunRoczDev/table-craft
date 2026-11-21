import { MESSAGE_FORMATS, SCHEMA_TYPES, type StatementKind } from "@table-craft/plugin-api";

/** What completion offers for an argument, from a helper session or offline. */
export type ValueKind = "topic" | "group" | "subject" | "format" | "schemaType" | "level" | "state" | "resource";

/** A `--flag`; `value` names what it takes, absent for a switch. */
export interface FlagDoc {
  readonly name: string;
  /** A one-letter alias, written `-p`. */
  readonly short?: string;
  readonly value?: string;
  readonly summary: string;
  readonly choices?: readonly string[];
  readonly completion?: ValueKind;
  /** May be given more than once, such as `--header`. */
  readonly repeat?: true;
}

export interface ParameterDoc {
  readonly name: string;
  readonly optional?: true;
  /** Takes every positional argument from here on, such as `k=v…`. */
  readonly variadic?: true;
  readonly completion?: ValueKind;
  readonly choices?: readonly string[];
}

/** One console command (decision 9 of plan 164). `kind` is its class unless `classify` refines it. */
export interface CommandDoc {
  readonly name: string;
  readonly summary: string;
  readonly kind: StatementKind;
  readonly parameters: readonly ParameterDoc[];
  readonly flags: readonly FlagDoc[];
}

export const COMPATIBILITY_LEVELS = [
  "BACKWARD",
  "BACKWARD_TRANSITIVE",
  "FORWARD",
  "FORWARD_TRANSITIVE",
  "FULL",
  "FULL_TRANSITIVE",
  "NONE",
] as const;
export const GROUP_STATES = ["Stable", "Empty", "PreparingRebalance", "CompletingRebalance", "Dead"] as const;
export const FROM_CHOICES = ["earliest", "latest", "-500", "offset:", "time:", "group:"] as const;
export const RESET_CHOICES = ["earliest", "latest", "offset:", "time:", "shift:"] as const;

const TOPIC: ParameterDoc = { name: "topic", completion: "topic" };
const GROUP: ParameterDoc = { name: "group", completion: "group" };
const SUBJECT: ParameterDoc = { name: "subject", completion: "subject" };
const VALIDATE_ONLY: FlagDoc = {
  name: "validate-only",
  summary: "ask the broker whether it would accept it, change nothing",
};
const FORMAT = (name: string, summary: string): FlagDoc => ({
  name,
  value: "format",
  summary,
  choices: MESSAGE_FORMATS,
  completion: "format",
});

/** Every command the console runs, in the order completion offers them. */
export const COMMANDS: readonly CommandDoc[] = [
  {
    name: "topics",
    summary: "Lists the topics, with partitions, replication and an estimate of their messages.",
    kind: "read",
    parameters: [{ name: "glob", optional: true }],
    flags: [{ name: "internal", summary: "include Kafka's own topics, such as __consumer_offsets" }],
  },
  {
    name: "describe",
    summary: "Shows a topic's partitions: leader, replicas, ISR and watermarks.",
    kind: "read",
    parameters: [TOPIC],
    flags: [],
  },
  {
    name: "consume",
    summary: "Reads messages without joining a group or committing (decision 4).",
    kind: "read",
    parameters: [TOPIC],
    flags: [
      { name: "partitions", short: "p", value: "0,3", summary: "only these partitions" },
      {
        name: "from",
        value: "start",
        summary: "earliest (default), latest, -N (the newest N), offset:N, time:ISO or group:id",
        choices: FROM_CHOICES,
      },
      { name: "limit", value: "N", summary: "at most N messages (default: all, up to the 50,000 read cap)" },
      FORMAT("key-format", "how keys are shown"),
      FORMAT("value-format", "how values are shown"),
      {
        name: "grep",
        value: "text",
        summary: "only messages whose key, value or a header holds text, or matches /regex/",
      },
      {
        name: "wait",
        value: "seconds",
        summary: "keep reading what arrives past the end for this long, as kcat without -e",
      },
    ],
  },
  {
    name: "message",
    summary: "Reads the one message at an offset of a partition and answers its value.",
    kind: "read",
    parameters: [TOPIC, { name: "partition" }, { name: "offset" }],
    flags: [FORMAT("value-format", "how the value is shown")],
  },
  {
    name: "produce",
    summary: "Sends one record and answers its partition and offset.",
    kind: "write",
    parameters: [TOPIC, { name: "value" }],
    flags: [
      { name: "key", value: "key", summary: "the record's key" },
      { name: "partition", value: "N", summary: "this partition instead of the key's" },
      { name: "header", value: "k=v", summary: "a header; repeat for more", repeat: true },
      FORMAT("key-format", "how the key is encoded"),
      FORMAT("value-format", "how the value is encoded"),
      {
        name: "key-schema",
        value: "subject[:version]",
        summary: "the subject a registry key format encodes with",
        completion: "subject",
      },
      {
        name: "value-schema",
        value: "subject[:version]",
        summary: "the subject a registry value format encodes with",
        completion: "subject",
      },
    ],
  },
  {
    name: "create-topic",
    summary: "Creates a topic.",
    kind: "write",
    parameters: [{ name: "name" }],
    flags: [
      { name: "partitions", value: "N", summary: "partitions (default 1)" },
      { name: "replication", value: "N", summary: "replication factor (default: the broker's)" },
      { name: "config", value: "k=v", summary: "a topic config; repeat for more", repeat: true },
      VALIDATE_ONLY,
    ],
  },
  {
    name: "delete-topic",
    summary: "Deletes a topic and every message in it.",
    kind: "write",
    parameters: [TOPIC],
    flags: [],
  },
  {
    name: "alter-config",
    summary: "Sets or resets configs of a topic or a broker, incrementally.",
    kind: "write",
    parameters: [
      { name: "resource", choices: ["topic", "broker"], completion: "resource" },
      { name: "name", completion: "topic" },
      { name: "k=v", optional: true, variadic: true },
    ],
    flags: [
      { name: "delete", value: "key", summary: "reset a config to its default; repeat for more", repeat: true },
      VALIDATE_ONLY,
    ],
  },
  {
    name: "add-partitions",
    summary: "Raises a topic's partition count to a new total.",
    kind: "write",
    parameters: [TOPIC, { name: "total" }],
    flags: [VALIDATE_ONLY],
  },
  {
    name: "delete-records",
    summary: "Deletes a partition's records before an offset.",
    kind: "write",
    parameters: [TOPIC, { name: "partition" }, { name: "beforeOffset" }],
    flags: [],
  },
  {
    name: "groups",
    summary: "Lists the consumer groups with their state and total lag.",
    kind: "read",
    parameters: [{ name: "state", optional: true, completion: "state", choices: GROUP_STATES }],
    flags: [],
  },
  {
    name: "group",
    summary: "Shows a group's members and their assignments.",
    kind: "read",
    parameters: [GROUP],
    flags: [],
  },
  {
    name: "lag",
    summary: "Shows a group's committed offsets and lag per partition.",
    kind: "read",
    parameters: [GROUP],
    flags: [],
  },
  {
    name: "reset-offsets",
    summary: "Moves a group's committed offsets; only while the group has no members.",
    kind: "write",
    parameters: [GROUP, { name: "topic|*", completion: "topic" }],
    flags: [
      {
        name: "to",
        value: "target",
        summary: "earliest, latest, offset:N, time:ISO or shift:±N",
        choices: RESET_CHOICES,
      },
      { name: "partitions", short: "p", value: "0,3", summary: "only these partitions" },
      { name: "dry-run", summary: "show the new offsets and change nothing" },
    ],
  },
  {
    name: "delete-group",
    summary: "Deletes a consumer group without members.",
    kind: "write",
    parameters: [GROUP],
    flags: [],
  },
  {
    name: "delete-offsets",
    summary: "Deletes a group's committed offsets on a topic.",
    kind: "write",
    parameters: [GROUP, TOPIC],
    flags: [],
  },
  {
    name: "brokers",
    summary: "Lists the brokers, their racks and the controller.",
    kind: "read",
    parameters: [],
    flags: [],
  },
  {
    name: "subjects",
    summary: "Lists the Schema Registry's subjects.",
    kind: "read",
    parameters: [{ name: "glob", optional: true }],
    flags: [],
  },
  {
    name: "schema",
    summary: "Shows a subject's schema at a version, the latest by default.",
    kind: "read",
    parameters: [SUBJECT, { name: "version", optional: true }],
    flags: [],
  },
  {
    name: "register",
    summary: "Registers a schema as the next version of a subject.",
    kind: "write",
    parameters: [SUBJECT, { name: "type", choices: SCHEMA_TYPES, completion: "schemaType" }, { name: "schema" }],
    flags: [],
  },
  {
    name: "compatibility",
    summary: "Shows a subject's compatibility level, or sets it when a level is given.",
    kind: "read",
    parameters: [
      { ...SUBJECT, optional: true },
      { name: "level", optional: true, choices: COMPATIBILITY_LEVELS, completion: "level" },
    ],
    flags: [{ name: "global", summary: "the registry's global level instead of a subject's" }],
  },
];

const BY_NAME = new Map(COMMANDS.map((doc) => [doc.name, doc]));

export function commandOf(name: string): CommandDoc | null {
  return BY_NAME.get(name.toLowerCase()) ?? null;
}

/** `consume <topic> [--partitions=0,3] …` as the popup and errors show it. */
export function syntaxOf(doc: CommandDoc): string {
  const parameters = doc.parameters.map((parameter) => {
    const shown = parameter.variadic === true ? `${parameter.name}…` : parameter.name;
    return parameter.optional === true ? `[${shown}]` : `<${shown}>`;
  });
  const flags = doc.flags.map((flag) => `[--${flag.name}${flag.value === undefined ? "" : ` ${flag.value}`}]`);
  return [doc.name, ...parameters, ...flags].join(" ");
}
