import avro from "avsc";
import { labelOf, type ReferencedSchema, type RegistryCodec } from "./codec.js";

const PATH_SEPARATOR = ".";
/** JSON has no bytes: a `bytes` or `fixed` field arrives as a string, as Avro's JSON encoding writes it. */
const FROM_JSON = { coerceBuffers: true } as const;

function problemsOf(type: avro.Type, value: unknown): string[] {
  const problems: string[] = [];
  type.isValid(value, {
    errorHook: (path: string[], found: unknown, expected: avro.Type) => {
      const where = path.length === 0 ? "the value" : path.join(PATH_SEPARATOR);
      problems.push(`${where}: ${JSON.stringify(found) ?? "undefined"} is not ${expected.typeName ?? "valid"}`);
    },
  });
  return problems;
}

/**
 * An Avro schema from the registry (decision 8 of plan 164). Referenced schemas are parsed first
 * into the same registry of names, as Confluent's serializer resolves them.
 */
export function avroCodec(id: number, schema: string, references: readonly ReferencedSchema[]): RegistryCodec {
  const registry: Record<string, avro.Type> = {};
  const options: Partial<avro.ForSchemaOptions> = { registry, wrapUnions: "auto" };
  for (const reference of references) avro.Type.forSchema(JSON.parse(reference.schema) as avro.Schema, options);
  const type = avro.Type.forSchema(JSON.parse(schema) as avro.Schema, options);
  const native = (value: unknown): unknown => type.clone(value, FROM_JSON);
  return {
    id,
    type: "AVRO",
    label: labelOf("AVRO", id),
    decode: (payload) => type.fromBuffer(payload) as unknown,
    validate: (value) => {
      try {
        return problemsOf(type, native(value));
      } catch (error) {
        const problems = problemsOf(type, value);
        return problems.length > 0 ? problems : [error instanceof Error ? error.message : String(error)];
      }
    },
    encode: (value) => type.toBuffer(native(value)),
  };
}
