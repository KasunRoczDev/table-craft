import type { Row, WireValue } from "@table-craft/plugin-api";

const MIB = 1024 * 1024;

/**
 * The largest reply body the client reads. Reading one holds its bytes, its text and the parsed
 * objects at once, about five times the body, so a `size: 10000` search of large documents would
 * otherwise take the engine down with it.
 */
export const REPLY_MAX_BYTES = 64 * MIB;

/**
 * Memory the rows of one search keep, counted as their text in UTF-16. Paging stops there, as a
 * topic read stops at its own cap (decision 172); the rest stays on the server, a narrower search
 * away.
 */
export const SEARCH_KEPT_BYTES = 128 * MIB;

/**
 * Characters of a field or `_source` cell a row keeps; a longer one keeps its start and `…`. A
 * document is re-read by `_id` whole, so nothing is spilled to disk the way a topic message is.
 */
export const CELL_PREVIEW_CHARS = 32_768;

/** Characters of a console reply shown in Output or opened as a result. */
export const REPLY_PREVIEW_CHARS = 262_144;

export const PREVIEW_END = "…";

const ROW_OVERHEAD_BYTES = 256;
const CELL_OVERHEAD_BYTES = 16;
const UTF16_BYTES = 2;

function cellChars(cell: WireValue): number {
  if (cell === null || typeof cell === "boolean" || typeof cell === "number") return 0;
  if (typeof cell === "string") return cell.length;
  if (cell.kind === "json") return cell.text.length;
  if (cell.kind === "bytes") return cell.preview.length;
  return 0;
}

/** About the memory a kept row takes: its text as UTF-16, and the rest. */
export function rowBytes(row: Row): number {
  let bytes = ROW_OVERHEAD_BYTES;
  for (const cell of row) bytes += CELL_OVERHEAD_BYTES + UTF16_BYTES * cellChars(cell);
  return bytes;
}

/** Text cut to `limit` characters and ended with `…`, or the text itself when it fits. */
export function previewText(text: string, limit: number = CELL_PREVIEW_CHARS): string {
  return text.length <= limit ? text : text.slice(0, limit) + PREVIEW_END;
}

/** A JSON cell, or the start of its text when it is too long to keep, since cut JSON no longer parses. */
export function jsonCell(text: string): WireValue {
  return text.length <= CELL_PREVIEW_CHARS ? { kind: "json", text } : previewText(text);
}
