import {
  SEARCH_ID_COLUMN,
  SEARCH_INDEX_COLUMN,
  SEARCH_SOURCE_COLUMN,
  type Column,
  type Row,
  type SearchField,
  type TypeClass,
  type WireValue,
} from "@table-craft/plugin-api";
import { valueFields } from "./mapping.js";

export const SCORE_COLUMN = "_score";
/** Up to this many value fields, every one is a column; past it the plugin picks a few. */
export const ALL_FIELDS_LIMIT = 40;
/** Columns a wide mapping starts with besides `_id` and `_source`. */
const WIDE_COLUMNS = 8;
/** Names a log line's message and level go by, in the order a column is picked. */
const LOG_FIELDS = ["log.level", "level", "severity", "message", "msg"];

const INTEGER_TYPES = new Set(["long", "integer", "short", "byte", "unsigned_long", "token_count"]);
const FLOAT_TYPES = new Set(["double", "float", "half_float", "scaled_float"]);
const JSON_TYPES = new Set(["object", "nested", "flattened", "geo_point", "geo_shape", "point", "shape", "join"]);

export interface Hit {
  readonly _id?: unknown;
  readonly _index?: unknown;
  readonly _score?: unknown;
  readonly _source?: unknown;
  readonly sort?: unknown;
}

export function typeClassOf(type: string): TypeClass {
  if (INTEGER_TYPES.has(type)) return "integer";
  if (FLOAT_TYPES.has(type)) return "float";
  if (type === "boolean") return "boolean";
  if (type === "date" || type === "date_nanos") return "temporal";
  if (JSON_TYPES.has(type)) return "json";
  return "text";
}

/** The fields a search shows when the request names none (plan 165): all of a narrow mapping, a few of a wide one. */
export function defaultFields(fields: readonly SearchField[], timeField: string | null): string[] {
  const values = valueFields(fields);
  if (values.length <= ALL_FIELDS_LIMIT) return values.map((field) => field.path);
  const chosen: string[] = [];
  const add = (path: string): void => {
    if (!chosen.includes(path) && chosen.length < WIDE_COLUMNS) chosen.push(path);
  };
  if (timeField !== null) add(timeField);
  for (const name of LOG_FIELDS) if (values.some((field) => field.path === name)) add(name);
  for (const field of values) if (field.type === "keyword") add(field.path);
  return chosen;
}

export interface HitColumns {
  readonly columns: readonly Column[];
  readonly fields: readonly string[];
  readonly withIndex: boolean;
  readonly withScore: boolean;
}

export function hitColumns(
  fields: readonly string[],
  mapping: readonly SearchField[],
  withIndex: boolean,
  withScore: boolean,
): HitColumns {
  const byPath = new Map(mapping.map((field) => [field.path, field]));
  const columns: Column[] = [{ name: SEARCH_ID_COLUMN, type: "keyword", typeClass: "text" }];
  if (withIndex) columns.push({ name: SEARCH_INDEX_COLUMN, type: "keyword", typeClass: "text" });
  if (withScore) columns.push({ name: SCORE_COLUMN, type: "float", typeClass: "float" });
  for (const path of fields) {
    const type = byPath.get(path)?.type ?? null;
    columns.push({ name: path, type, typeClass: type === null ? "text" : typeClassOf(type) });
  }
  columns.push({ name: SEARCH_SOURCE_COLUMN, type: "json", typeClass: "json" });
  return { columns, fields, withIndex, withScore };
}

/**
 * The value at a dotted path of a source: nested objects first, then a key that itself holds dots,
 * as both shapes index the same; an array of objects yields the values it holds at the rest.
 */
export function valueAt(source: unknown, path: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as Record<string, unknown>;
  if (path in record) return record[path];
  const parts = path.split(".");
  for (let take = parts.length - 1; take >= 1; take -= 1) {
    const head = parts.slice(0, take).join(".");
    if (!(head in record)) continue;
    const rest = parts.slice(take).join(".");
    const inner = record[head];
    if (Array.isArray(inner)) {
      const values = inner.map((item) => valueAt(item, rest)).filter((value) => value !== undefined);
      return values.length === 0 ? undefined : values;
    }
    return valueAt(inner, rest);
  }
  return undefined;
}

export function cellOf(value: unknown): WireValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return value;
  return { kind: "json", text: JSON.stringify(value) };
}

export function hitRow(hit: Hit, shape: HitColumns): Row {
  const row: WireValue[] = [typeof hit._id === "string" ? hit._id : cellOf(hit._id)];
  if (shape.withIndex) row.push(cellOf(hit._index));
  if (shape.withScore) row.push(typeof hit._score === "number" ? hit._score : null);
  for (const path of shape.fields) row.push(cellOf(valueAt(hit._source, path)));
  row.push(hit._source === undefined ? null : { kind: "json", text: JSON.stringify(hit._source) });
  return row;
}
