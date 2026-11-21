import avro from "avsc";
import { labelOf, type ReferencedSchema, type RegistryCodec } from "./codec.js";

const PATH_SEPARATOR = ".";
/** JSON has no bytes: a `bytes` or `fixed` field arrives as base64 text, as a read shows it. */
const FROM_JSON = { coerceBuffers: true } as const;
/**
 * Array and map items of no bytes, such as `null`, a decode may produce beyond one per payload
 * byte. Every other item takes at least a byte, so the payload bounds them.
 */
const ZERO_WIDTH_ITEMS = 10_000;
const INT64_BYTES = 8;
/** avsc names a custom long `abstract:long`; a problem calls it `long`, as the schema does. */
const ABSTRACT_PREFIX = /^abstract:/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** The part of avsc's `Tap` the bounded readers use. */
interface Tap {
  readLong(): number;
  skipLong(): void;
  readString(): string;
  isValid(): boolean;
}

interface Reader {
  _read(tap: Tap): unknown;
}

/** Items a decode may still read; reset per payload. */
interface ItemBudget {
  left: number;
}

/**
 * The item count of the next array or map block. avsc trusts it, allocating and looping that many
 * times before it notices the payload ran out, so six bytes could freeze or exhaust the engine.
 */
function blockCount(tap: Tap, budget: ItemBudget): number {
  let count = tap.readLong();
  if (count < 0) {
    count = -count;
    tap.skipLong();
  }
  if (!tap.isValid() || !Number.isSafeInteger(count) || count > budget.left) {
    throw new Error("an array or map names more items than the message holds");
  }
  budget.left -= count;
  return count;
}

function boundedTypes(budget: ItemBudget): { array: typeof avro.types.ArrayType; map: typeof avro.types.MapType } {
  class BoundedArray extends avro.types.ArrayType {
    _read(tap: Tap): unknown[] {
      const items = this.itemsType as unknown as Reader;
      const values: unknown[] = [];
      for (let count = blockCount(tap, budget); count > 0; count = blockCount(tap, budget)) {
        for (let index = 0; index < count; index += 1) values.push(items._read(tap));
      }
      return values;
    }
  }
  class BoundedMap extends avro.types.MapType {
    _read(tap: Tap): Record<string, unknown> {
      const values = this.valuesType as unknown as Reader;
      const entries: Record<string, unknown> = {};
      for (let count = blockCount(tap, budget); count > 0; count = blockCount(tap, budget)) {
        for (let index = 0; index < count; index += 1) entries[tap.readString()] = values._read(tap);
      }
      return entries;
    }
  }
  return { array: BoundedArray, map: BoundedMap };
}

interface Copier {
  _copy(value: unknown, options: unknown): unknown;
  _check(value: unknown, flags: unknown, hook: unknown): boolean;
}

/**
 * A `_copy` that also takes base64 text, the way a read shows `bytes` and `fixed`, so a message
 * copied from the grid produces again.
 */
function base64Copy(base: Copier, self: unknown, value: unknown, options: unknown): unknown {
  if (typeof value !== "string") return base._copy.call(self, value, options);
  return base._copy.call(self, Buffer.from(value, "base64"), { ...(options as object), coerce: 0 });
}

class Base64Bytes extends avro.types.BytesType {
  _copy(value: unknown, options: unknown): unknown {
    return base64Copy(avro.types.BytesType.prototype as unknown as Copier, this, value, options);
  }

  _check(value: unknown, flags: unknown, hook: unknown): boolean {
    const base = avro.types.BytesType.prototype as unknown as Copier;
    return base._check.call(this, typeof value === "string" ? Buffer.from(value, "base64") : value, flags, hook);
  }
}

class Base64Fixed extends avro.types.FixedType {
  _copy(value: unknown, options: unknown): unknown {
    return base64Copy(avro.types.FixedType.prototype as unknown as Copier, this, value, options);
  }

  _check(value: unknown, flags: unknown, hook: unknown): boolean {
    const base = avro.types.FixedType.prototype as unknown as Copier;
    return base._check.call(this, typeof value === "string" ? Buffer.from(value, "base64") : value, flags, hook);
  }
}

/** Avro `long` as a bigint, so a value past 2^53 shows exactly instead of failing the whole record. */
const BIGINT_LONG = avro.types.LongType.__with({
  fromBuffer: (bytes: Buffer) => bytes.readBigInt64LE(),
  toBuffer: (value: bigint | number) => {
    const bytes = Buffer.alloc(INT64_BYTES);
    bytes.writeBigInt64LE(BigInt(value));
    return bytes;
  },
  fromJSON: (value: unknown) => BigInt(value as bigint | number | string),
  toJSON: (value: bigint) => value,
  isValid: (value: unknown) =>
    (typeof value === "bigint" && value >= INT64_MIN && value <= INT64_MAX) || Number.isSafeInteger(value),
  compare: (left: bigint, right: bigint) => (left === right ? 0 : left < right ? -1 : 1),
});

/** avsc's union bucket of a branch, with the bigint `long` counted as a number as avsc counts its own. */
function bucketOf(type: avro.Type): string {
  const name = type.typeName;
  if (["double", "float", "int", "long", "abstract:long"].includes(name)) return "number";
  if (name === "bytes" || name === "fixed") return "buffer";
  if (name === "enum") return "string";
  if (name === "map" || name === "error" || name === "record") return "object";
  return name;
}

/**
 * The union `wrapUnions: "auto"` would build with avsc's own `long`: wrapped when two branches
 * share a bucket. avsc puts a custom long in a bucket of its own, which would unwrap `["int", "long"]`.
 */
function unionOf(branches: readonly avro.Type[], options: Partial<avro.ForSchemaOptions>): avro.Type {
  const buckets = branches.map(bucketOf);
  const ambiguous = new Set(buckets).size < buckets.length;
  return ambiguous
    ? new avro.types.WrappedUnionType(branches as unknown as avro.Schema, options)
    : new avro.types.UnwrappedUnionType(branches as unknown as avro.Schema, options);
}

function isLong(schema: avro.Schema): boolean {
  return schema === "long" || (typeof schema === "object" && (schema as { type?: unknown }).type === "long");
}

function typeNameOf(schema: avro.Schema): unknown {
  return typeof schema === "object" && !Array.isArray(schema) ? (schema as { type?: unknown }).type : null;
}

function problemsOf(type: avro.Type, value: unknown): string[] {
  const problems: string[] = [];
  type.isValid(value, {
    errorHook: (path: string[], found: unknown, expected: avro.Type) => {
      const where = path.length === 0 ? "the value" : path.join(PATH_SEPARATOR);
      const shown = typeof found === "bigint" ? found.toString() : (JSON.stringify(found) ?? "undefined");
      problems.push(`${where}: ${shown} is not ${expected.typeName.replace(ABSTRACT_PREFIX, "")}`);
    },
  });
  return problems;
}

/**
 * An Avro schema from the registry (decision 8 of plan 164). Referenced schemas are parsed first
 * into the same registry of names, as Confluent's serializer resolves them.
 */
export function avroCodec(id: number, schema: string, references: readonly ReferencedSchema[]): RegistryCodec {
  const budget: ItemBudget = { left: 0 };
  const bounded = boundedTypes(budget);
  const registry: Record<string, avro.Type> = {};
  const options: Partial<avro.ForSchemaOptions> = {
    registry,
    wrapUnions: "auto",
    typeHook: (attrs, hookOptions) => {
      if (isLong(attrs)) return BIGINT_LONG;
      if (Array.isArray(attrs)) {
        return unionOf(
          attrs.map((branch: avro.Schema) => avro.Type.forSchema(branch, hookOptions)),
          hookOptions,
        );
      }
      const name = typeNameOf(attrs);
      if (name === "array") return new bounded.array(attrs, hookOptions);
      if (name === "map") return new bounded.map(attrs, hookOptions);
      if (attrs === "bytes" || name === "bytes") return new Base64Bytes();
      if (name === "fixed") return new Base64Fixed(attrs, hookOptions);
      return undefined;
    },
  };
  for (const reference of references) avro.Type.forSchema(JSON.parse(reference.schema) as avro.Schema, options);
  const type = avro.Type.forSchema(JSON.parse(schema) as avro.Schema, options);
  const native = (value: unknown): unknown => type.clone(value, FROM_JSON);
  return {
    id,
    type: "AVRO",
    label: labelOf("AVRO", id),
    decode: (payload) => {
      budget.left = payload.length + ZERO_WIDTH_ITEMS;
      return type.fromBuffer(payload) as unknown;
    },
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
