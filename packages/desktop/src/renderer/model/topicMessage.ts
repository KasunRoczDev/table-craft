import {
  MESSAGE_PREVIEW_CHARS,
  type Row,
  type SpilledMessage,
  type WireValue,
} from "@table-craft/desktop/engine/protocol.js";

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

/** The message with the whole key, value and headers its read kept on disk (decision 172). */
export function withFullCells(message: TopicMessage, full: SpilledMessage): TopicMessage {
  return {
    ...message,
    key: cellText(full.key),
    value: cellText(full.value),
    valueJson: typeof full.value === "object" && full.value !== null && full.value.kind === "json",
    headers: headerLines(full.headers),
  };
}

const PREVIEW_END = "…";

/** Whether `text` is a preview the engine or plugin cut at `MESSAGE_PREVIEW_CHARS`. */
export function isPreviewText(text: string | null): boolean {
  return text !== null && text.length > MESSAGE_PREVIEW_CHARS && text.endsWith(PREVIEW_END);
}

/** Whether any of the message's key, value or header values is a cut preview. */
export function isPreviewMessage(message: {
  readonly key: string | null;
  readonly value: string | null;
  readonly headers: readonly { readonly value: string | null }[];
}): boolean {
  return (
    isPreviewText(message.key) ||
    isPreviewText(message.value) ||
    message.headers.some((header) => header.value?.endsWith(PREVIEW_END) === true)
  );
}

/**
 * The whole text of the key or headers cell the grid has focused, which the message panel shows
 * in full instead of in its one-line facts; null for any other column.
 */
export function focusedCellText(
  message: TopicMessage,
  column: string | null,
): { readonly title: string; readonly text: string } | null {
  if (column === "key") return { title: "Key", text: message.key ?? "null" };
  if (column === "headers" && message.headers.length > 0)
    return { title: "Headers", text: message.headers.map((header) => `${header.name}: ${header.value}`).join("\n") };
  return null;
}

/** Shown when a large message's whole text is gone and only its preview is left. */
export const PREVIEW_ONLY_NOTICE = "Only the first 1,024 characters are kept; the full message is no longer available.";

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
