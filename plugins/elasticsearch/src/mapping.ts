import type { SearchField } from "@table-craft/plugin-api";

interface Property {
  readonly type?: unknown;
  readonly properties?: unknown;
  readonly fields?: unknown;
  readonly analyzer?: unknown;
  readonly doc_values?: unknown;
}

/** The field a document's time is read from when it has one; Elastic's own conventions name it so. */
export const TIME_FIELD = "@timestamp";
const DATE_TYPES = new Set(["date", "date_nanos"]);
/** Types without doc values by design: they cannot be sorted or aggregated on. */
const UNSORTABLE = new Set(["text", "match_only_text", "object", "nested", "binary", "annotated_text"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOf(property: Property): string {
  if (typeof property.type === "string") return property.type;
  return isRecord(property.properties) ? "object" : "object";
}

function walk(properties: Readonly<Record<string, unknown>>, prefix: string, out: Map<string, SearchField>): void {
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue;
    const property = raw as Property;
    const path = prefix === "" ? name : `${prefix}.${name}`;
    const type = typeOf(property);
    if (!out.has(path)) {
      out.set(path, {
        path,
        type,
        multiOf: null,
        analyzer: typeof property.analyzer === "string" ? property.analyzer : null,
        aggregatable: !UNSORTABLE.has(type) && property.doc_values !== false,
      });
    }
    if (isRecord(property.properties)) walk(property.properties, path, out);
    if (isRecord(property.fields)) {
      for (const [sub, rawSub] of Object.entries(property.fields)) {
        if (!isRecord(rawSub)) continue;
        const subProperty = rawSub as Property;
        const subPath = `${path}.${sub}`;
        if (out.has(subPath)) continue;
        const subType = typeOf(subProperty);
        out.set(subPath, {
          path: subPath,
          type: subType,
          multiOf: path,
          analyzer: typeof subProperty.analyzer === "string" ? subProperty.analyzer : null,
          aggregatable: !UNSORTABLE.has(subType) && subProperty.doc_values !== false,
        });
      }
    }
  }
}

export interface ParsedMapping {
  readonly fields: SearchField[];
  /** The 6.x type name the first index keeps its mapping under; null from 7.0. */
  readonly mappingType: string | null;
}

/**
 * The fields of every index in a `GET <target>/_mapping` reply, merged by path, the first index's
 * type winning a conflict. On 6.x each index nests its properties under one mapping type.
 */
export function parseMapping(reply: unknown, mappingTypes: boolean): ParsedMapping {
  const out = new Map<string, SearchField>();
  let mappingType: string | null = null;
  if (!isRecord(reply)) return { fields: [], mappingType };
  for (const index of Object.values(reply)) {
    if (!isRecord(index) || !isRecord(index.mappings)) continue;
    let mappings: Readonly<Record<string, unknown>> = index.mappings;
    if (mappingTypes && !isRecord(mappings.properties)) {
      const typed = Object.entries(mappings).find(([, value]) => isRecord(value) && isRecord(value.properties));
      if (typed === undefined) continue;
      mappingType ??= typed[0];
      mappings = typed[1] as Readonly<Record<string, unknown>>;
    }
    if (isRecord(mappings.properties)) walk(mappings.properties, "", out);
  }
  return { fields: [...out.values()], mappingType };
}

/** A field documents are best read by time with: `@timestamp` when it is a date; null otherwise. */
export function timeFieldOf(fields: readonly SearchField[]): string | null {
  const field = fields.find((candidate) => candidate.path === TIME_FIELD);
  return field !== undefined && DATE_TYPES.has(field.type) ? field.path : null;
}

export function isDateType(type: string): boolean {
  return DATE_TYPES.has(type);
}

/** Leaves that hold values a column can show: not objects, not multi-fields. */
export function valueFields(fields: readonly SearchField[]): SearchField[] {
  return fields.filter((field) => field.multiOf === null && field.type !== "object" && field.type !== "nested");
}
