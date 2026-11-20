import type { Row, WireValue } from "@table-craft/desktop/engine/protocol.js";

/** One message of a topic read, its cells as text (decision 5's columns). */
export interface TopicMessage {
  readonly partition: number | null;
  readonly offset: string;
  readonly timestamp: string;
  readonly key: string | null;
  readonly value: string | null;
  /** The value's cell was JSON, so the panel lays it out. */
  readonly valueJson: boolean;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly size: string;
  readonly keySchema: string | null;
  readonly valueSchema: string | null;
}

/** A cell as text: JSON's own text, a bigint's digits, a date's ISO instant, bytes' preview; null stays null. */
export function cellText(value: WireValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return String(value);
  if (value.kind === "json") return value.text;
  if (value.kind === "bigint") return value.value;
  if (value.kind === "date") return value.iso;
  return value.preview;
}

function headerText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A `headers` cell as name and value lines: an array of `{name, value}`, or an object by name. */
export function headerLines(value: WireValue | undefined): TopicMessage["headers"] {
  const text = cellText(value);
  if (text === null || text === "") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed))
      return parsed.flatMap((entry: unknown) =>
        typeof entry === "object" && entry !== null && "name" in entry
          ? [{ name: headerText(entry.name), value: "value" in entry ? headerText(entry.value) : "" }]
          : [],
      );
    if (typeof parsed === "object" && parsed !== null)
      return Object.entries(parsed).map(([name, header]) => ({ name, value: headerText(header) }));
  } catch {
    // A header cell that is not JSON has no lines to show.
  }
  return [];
}

/** The message a read's row holds, by its column names. */
export function messageOf(columns: readonly { readonly name: string }[], row: Row): TopicMessage {
  const cell = (name: string) => row[columns.findIndex((column) => column.name === name)];
  const partition = cellText(cell("partition"));
  const value = cell("value");
  return {
    partition: partition === null ? null : Number(partition),
    offset: cellText(cell("offset")) ?? "",
    timestamp: cellText(cell("timestamp")) ?? "",
    key: cellText(cell("key")),
    value: cellText(value),
    valueJson: typeof value === "object" && value !== null && value.kind === "json",
    headers: headerLines(cell("headers")),
    size: cellText(cell("size")) ?? "",
    keySchema: cellText(cell("keySchema")),
    valueSchema: cellText(cell("valueSchema")),
  };
}

/** The message as one JSON document, for Copy Message as JSON (audit M12); JSON values stay JSON. */
export function messageJson(message: TopicMessage): string {
  let value: unknown = message.value;
  if (message.valueJson && message.value !== null) {
    try {
      value = JSON.parse(message.value);
    } catch {
      value = message.value;
    }
  }
  return JSON.stringify(
    {
      partition: message.partition,
      offset: message.offset,
      timestamp: message.timestamp,
      key: message.key,
      value,
      headers: message.headers,
      keySchema: message.keySchema,
      valueSchema: message.valueSchema,
    },
    null,
    2,
  );
}

function quoted(text: string): string {
  return /^[\w.:/-]+$/.test(text) ? text : JSON.stringify(text);
}

/** The console command that reads exactly this message again (audit M12). */
export function messageCommand(topic: string, message: Pick<TopicMessage, "partition" | "offset">): string {
  return `consume ${quoted(topic)} -p ${String(message.partition ?? 0)} --from offset:${message.offset} --limit 1`;
}
