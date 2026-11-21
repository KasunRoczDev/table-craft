import { labelOf, type RegistryCodec } from "./codec.js";

/** The JSON Schema keywords checked before a produce; the rest are left to consumers. */
type JsonSchema = Readonly<{
  type?: string | readonly string[];
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  anyOf?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
}>;

const ROOT = "the value";

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, wanted: string): boolean {
  const actual = typeOf(value);
  return actual === wanted || (wanted === "number" && actual === "integer");
}

function where(path: string, key: string): string {
  return path === ROOT ? key : `${path}.${key}`;
}

function check(schema: JsonSchema | boolean, value: unknown, path: string, problems: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    problems.push(`${path} is not allowed`);
    return;
  }
  const types = schema.type === undefined ? [] : typeof schema.type === "string" ? [schema.type] : schema.type;
  if (types.length > 0 && !types.some((wanted) => matchesType(value, wanted))) {
    problems.push(`${path} is ${typeOf(value)}, not ${types.join(" or ")}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
    problems.push(`${path} is not one of ${JSON.stringify(schema.enum)}`);
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value))
    problems.push(`${path} is not ${JSON.stringify(schema.const)}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      problems.push(`${path} is below ${String(schema.minimum)}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      problems.push(`${path} is above ${String(schema.maximum)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      problems.push(`${path} is shorter than ${String(schema.minLength)}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      problems.push(`${path} is longer than ${String(schema.maxLength)}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      problems.push(`${path} does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) => {
      check(schema.items ?? true, item, `${path}[${String(index)}]`, problems);
    });
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) problems.push(`${where(path, key)} is required`);
    }
    for (const [key, item] of Object.entries(record)) {
      const property = schema.properties?.[key];
      if (property !== undefined) check(property, item, where(path, key), problems);
      else if (schema.additionalProperties !== undefined)
        check(schema.additionalProperties, item, where(path, key), problems);
    }
  }
  for (const part of schema.allOf ?? []) check(part, value, path, problems);
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives !== undefined) {
    const fits = alternatives.filter((option) => {
      const nested: string[] = [];
      check(option, value, path, nested);
      return nested.length === 0;
    }).length;
    if (fits === 0 || (schema.oneOf !== undefined && fits > 1))
      problems.push(`${path} matches ${String(fits)} of the ${schema.oneOf === undefined ? "anyOf" : "oneOf"} schemas`);
  }
}

/**
 * Problems of `value` against a JSON Schema, for the keywords above; `$ref` and the rest pass
 * unchecked, since the registry and its consumers check them anyway.
 */
export function jsonSchemaProblems(schema: string, value: unknown): string[] {
  const problems: string[] = [];
  check(JSON.parse(schema) as JsonSchema | boolean, value, ROOT, problems);
  return problems;
}

/** A JSON Schema from the registry: the payload is the JSON text itself. */
export function jsonSchemaCodec(id: number, schema: string): RegistryCodec {
  JSON.parse(schema);
  return {
    id,
    type: "JSON",
    label: labelOf("JSON", id),
    decode: (payload) => JSON.parse(payload.toString("utf8")) as unknown,
    decodeText: (payload) => {
      const text = payload.toString("utf8");
      JSON.parse(text);
      return text;
    },
    validate: (value) => jsonSchemaProblems(schema, value),
    encode: (value) => Buffer.from(JSON.stringify(value), "utf8"),
    encodeText: (text) => Buffer.from(text.trim(), "utf8"),
  };
}
