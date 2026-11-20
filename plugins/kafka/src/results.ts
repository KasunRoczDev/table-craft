import {
  TOPIC_MESSAGE_COLUMNS,
  type Column,
  type ExecuteResult,
  type MessageHeader,
  type Row,
  type WireValue,
} from "@table-craft/plugin-api";
import { readableText } from "./formats.js";
import type { Decoded } from "./formats.js";
import type { FetchedMessage } from "./readPlan.js";

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

export function messageRow(message: DecodedMessage): Row {
  const headers = headersOf(message);
  return [
    message.partition,
    { kind: "bigint", value: message.offset.toString() },
    message.timestamp === null ? null : { kind: "date", iso: isoOf(message.timestamp) ?? "" },
    message.decodedKey.cell,
    message.decodedValue.cell,
    headers.length === 0 ? null : { kind: "json", text: JSON.stringify(headers) },
    message.size,
    message.decodedKey.schema,
    message.decodedValue.schema,
  ];
}

async function* yieldRows(rows: readonly Row[]): AsyncIterable<Row> {
  for (const row of rows) yield row;
  return Promise.resolve();
}

export function tableResult(columns: readonly Column[], rows: readonly Row[]): ExecuteResult {
  return { columns, rows: yieldRows(rows), rowsAffected: null };
}

export function messagesResult(messages: readonly DecodedMessage[]): ExecuteResult {
  return tableResult(MESSAGE_COLUMNS, messages.map(messageRow));
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
