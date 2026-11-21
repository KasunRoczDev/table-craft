import {
  MESSAGE_PREVIEW_CHARS,
  TOPIC_MESSAGE_COLUMNS,
  type Column,
  type ExecuteResult,
  type MessageHeader,
  type Row,
  type SpilledMessage,
  type WireValue,
} from "@table-craft/plugin-api";
import { readableText } from "./formats.js";
import type { Decoded } from "./formats.js";
import type { FetchedMessage, MessagePlace } from "./readPlan.js";

const PREVIEW_END = "…";
/** What a kept row costs beyond its key, value and headers text: its other cells and the array. */
const ROW_OVERHEAD_BYTES = 256;
const UTF16_BYTES = 2;

/** A message with its key and value decoded as the read asked. */
export interface DecodedMessage extends FetchedMessage {
  readonly decodedKey: Decoded;
  readonly decodedValue: Decoded;
}

const COLUMN_TYPES: Readonly<Record<(typeof TOPIC_MESSAGE_COLUMNS)[number], Omit<Column, "name">>> = {
  partition: { type: "int32", typeClass: "integer" },
  offset: { type: "int64", typeClass: "integer" },
  timestamp: { type: "timestamp", typeClass: "temporal" },
  key: { type: null },
  value: { type: null },
  headers: { type: "json", typeClass: "json" },
  size: { type: "int32", typeClass: "integer" },
  keySchema: { type: "text", typeClass: "text" },
  valueSchema: { type: "text", typeClass: "text" },
};

/** The columns of a topic read, in `TOPIC_MESSAGE_COLUMNS` order. */
export const MESSAGE_COLUMNS: readonly Column[] = TOPIC_MESSAGE_COLUMNS.map((name) => ({
  name,
  ...COLUMN_TYPES[name],
}));

export function isoOf(timestamp: bigint | null): string | null {
  return timestamp === null ? null : new Date(Number(timestamp)).toISOString();
}

/** Header values as text where they read as text, else hex. */
export function headersOf(message: FetchedMessage): MessageHeader[] {
  return message.headers.map(([name, value]) => ({
    name: name === null ? "" : name.toString("utf8"),
    value: value === null ? null : (readableText(value) ?? value.toString("hex")),
  }));
}

/** The text of every header, `name=value`, for the filter. */
export function headerTexts(message: FetchedMessage): string[] {
  return headersOf(message).map((header) => `${header.name}=${header.value ?? ""}`);
}

/** A message's key, value and headers cells, as its row holds them. */
export function messageCells(message: DecodedMessage): SpilledMessage {
  const headers = headersOf(message);
  return {
    key: message.decodedKey.cell,
    value: message.decodedValue.cell,
    headers: headers.length === 0 ? null : { kind: "json", text: JSON.stringify(headers) },
  };
}

export function messageRow(message: DecodedMessage, cells: SpilledMessage = messageCells(message)): Row {
  return [
    message.partition,
    { kind: "bigint", value: message.offset.toString() },
    message.timestamp === null ? null : { kind: "date", iso: isoOf(message.timestamp) ?? "" },
    cells.key,
    cells.value,
    cells.headers,
    message.size,
    message.decodedKey.schema,
    message.decodedValue.schema,
  ];
}

/** The characters a cell shows: its text, its JSON, or its hex preview. */
function cellLength(cell: WireValue): number {
  if (typeof cell === "string") return cell.length;
  if (cell === null || typeof cell !== "object") return 0;
  if (cell.kind === "json") return cell.text.length;
  if (cell.kind === "bytes") return cell.preview.length;
  return 0;
}

/** Whether a message has a cell longer than `MESSAGE_PREVIEW_CHARS`, so only its preview stays in memory. */
export function isLarge(cells: SpilledMessage): boolean {
  return [cells.key, cells.value, cells.headers].some((cell) => cellLength(cell) > MESSAGE_PREVIEW_CHARS);
}

/**
 * A cell cut to `MESSAGE_PREVIEW_CHARS`: text ends with `…`, cut JSON becomes text since it no
 * longer parses, and bytes keep a shorter hex preview, which a `BytesValue` already marks as partial.
 */
export function previewCell(cell: WireValue): WireValue {
  if (cellLength(cell) <= MESSAGE_PREVIEW_CHARS || cell === null) return cell;
  if (typeof cell === "string") return cell.slice(0, MESSAGE_PREVIEW_CHARS) + PREVIEW_END;
  if (typeof cell !== "object") return cell;
  if (cell.kind === "json") return cell.text.slice(0, MESSAGE_PREVIEW_CHARS) + PREVIEW_END;
  if (cell.kind === "bytes") return { ...cell, preview: cell.preview.slice(0, MESSAGE_PREVIEW_CHARS) };
  return cell;
}

export function previewCells(cells: SpilledMessage): SpilledMessage {
  return { key: previewCell(cells.key), value: previewCell(cells.value), headers: previewCell(cells.headers) };
}

/** About the memory a kept row takes: its key, value and headers text as UTF-16, and the rest. */
export function keptCellBytes(cells: SpilledMessage): number {
  return (
    ROW_OVERHEAD_BYTES + UTF16_BYTES * (cellLength(cells.key) + cellLength(cells.value) + cellLength(cells.headers))
  );
}

/** A row a read keeps, with what orders it; the fetched bytes behind it are let go. */
export interface KeptMessage extends MessagePlace {
  readonly row: Row;
}

async function* yieldRows(rows: readonly Row[]): AsyncIterable<Row> {
  for (const row of rows) yield row;
  return Promise.resolve();
}

export function tableResult(columns: readonly Column[], rows: readonly Row[]): ExecuteResult {
  return { columns, rows: yieldRows(rows), rowsAffected: null };
}

export function messagesResult(messages: readonly KeptMessage[]): ExecuteResult {
  return tableResult(
    MESSAGE_COLUMNS,
    messages.map((message) => message.row),
  );
}

/** Columns by name; those in `integers` are integer, the rest text. */
export function columnsOf(names: readonly string[], integers: readonly string[] = []): Column[] {
  return names.map((name) =>
    integers.includes(name) ? { name, type: null, typeClass: "integer" as const } : { name, type: null },
  );
}

/** A decimal string as an integer cell: a number when exact, a bigint otherwise; null stays null. */
export function decimalCell(value: string | null): WireValue {
  if (value === null) return null;
  const exact = BigInt(value);
  return exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(exact)
    : { kind: "bigint", value };
}

/** A one-value answer for Output, such as `Created topic orders` (decision 112). */
export function replyResult(value: WireValue, text: string): ExecuteResult {
  return { columns: [], rows: yieldRows([]), rowsAffected: null, reply: { value, text } };
}
