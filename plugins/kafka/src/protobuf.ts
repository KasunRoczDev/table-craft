import protobuf from "protobufjs";
import { labelOf, type ReferencedSchema, type RegistryCodec } from "./codec.js";

const VARINT_PAYLOAD_BITS = 7;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUE = 0x80;
const MAX_VARINT_BYTES = 5;
/** How a decoded message reads as JSON, as Confluent's JSON printer writes it. */
const TO_OBJECT: protobuf.IConversionOptions = { longs: String, enums: String, bytes: String, oneofs: true };

/** Reads one zig-zag varint, as Confluent writes the message indexes, from `bytes` at `offset`. */
function readZigZag(bytes: Buffer, offset: number): { value: number; next: number } {
  let raw = 0;
  let shift = 0;
  let at = offset;
  for (let count = 0; count < MAX_VARINT_BYTES; count += 1) {
    const byte = bytes[at];
    if (byte === undefined) throw new Error("the message indexes after the schema id are cut short");
    at += 1;
    raw |= (byte & VARINT_PAYLOAD_MASK) << shift;
    if ((byte & VARINT_CONTINUE) === 0) return { value: (raw >>> 1) ^ -(raw & 1), next: at };
    shift += VARINT_PAYLOAD_BITS;
  }
  throw new Error("a message index after the schema id is longer than a varint");
}

function writeZigZag(value: number, out: number[]): void {
  let raw = ((value << 1) ^ (value >> 31)) >>> 0;
  while (raw >= VARINT_CONTINUE) {
    out.push((raw & VARINT_PAYLOAD_MASK) | VARINT_CONTINUE);
    raw >>>= VARINT_PAYLOAD_BITS;
  }
  out.push(raw);
}

/**
 * The message indexes Confluent writes after the schema id: the path from the file's top-level
 * messages down through nested ones; `[0]`, the first message, is written as one zero byte.
 */
export function readMessageIndexes(payload: Buffer): { indexes: number[]; next: number } {
  const count = readZigZag(payload, 0);
  if (count.value === 0) return { indexes: [0], next: count.next };
  const indexes: number[] = [];
  let at = count.next;
  for (let index = 0; index < count.value; index += 1) {
    const read = readZigZag(payload, at);
    indexes.push(read.value);
    at = read.next;
  }
  return { indexes, next: at };
}

export function writeMessageIndexes(indexes: readonly number[]): Buffer {
  if (indexes.length === 1 && indexes[0] === 0) return Buffer.from([0]);
  const out: number[] = [];
  writeZigZag(indexes.length, out);
  for (const index of indexes) writeZigZag(index, out);
  return Buffer.from(out);
}

function messagesOf(namespace: protobuf.NamespaceBase): protobuf.Type[] {
  return namespace.nestedArray.filter((nested): nested is protobuf.Type => nested instanceof protobuf.Type);
}

/** The file's top-level messages in declaration order, looking through its package namespaces. */
function topLevelMessages(root: protobuf.Root, packageName: string | undefined): protobuf.Type[] {
  if (packageName === undefined || packageName === "") return messagesOf(root);
  const found = root.lookup(packageName);
  return found instanceof protobuf.Namespace ? messagesOf(found) : [];
}

function messageAt(top: readonly protobuf.Type[], indexes: readonly number[]): protobuf.Type {
  let candidates: readonly protobuf.Type[] = top;
  let message: protobuf.Type | undefined;
  for (const index of indexes) {
    message = candidates[index];
    if (message === undefined) throw new Error(`the schema has no message at index path [${indexes.join(", ")}]`);
    candidates = messagesOf(message);
  }
  if (message === undefined) throw new Error("the message index path is empty");
  return message;
}

/**
 * Google's well-known types a file imports, such as `google/protobuf/timestamp.proto`, which a
 * registry serves without a reference, added to `root` unless a reference brought them.
 */
function addWellKnown(root: protobuf.Root, imports: readonly string[], referenced: ReadonlySet<string>): void {
  for (const file of new Set(imports)) {
    if (referenced.has(file)) continue;
    const json = protobuf.common.get(file);
    if (json?.nested !== undefined) root.addJSON(json.nested);
  }
}

/** Keys of `value` that are no field of `type`, at any depth; `fromObject` would drop them silently. */
function unknownFields(type: protobuf.Type, value: unknown, path: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const where = path === "" ? key : `${path}.${key}`;
    const field = type.fields[key];
    // A read shows which member of a oneof is set under the oneof's own name (`oneofs: true`).
    if (field === undefined && type.oneofs?.[key] !== undefined) return [];
    if (field === undefined) return [`${where}: ${type.name} has no field ${key}`];
    const nested = field.resolvedType;
    if (!(nested instanceof protobuf.Type) || item === null) return [];
    if (field.map) {
      return typeof item === "object"
        ? Object.entries(item as Record<string, unknown>).flatMap(([name, entry]) =>
            unknownFields(nested, entry, `${where}.${name}`),
          )
        : [];
    }
    if (field.repeated && Array.isArray(item)) {
      return item.flatMap((entry: unknown, index) => unknownFields(nested, entry, `${where}[${String(index)}]`));
    }
    return unknownFields(nested, item, where);
  });
}

/**
 * A Protobuf schema from the registry (decision 8 of plan 164). Its message indexes pick the
 * message among the schema's own top-level messages, in the order its file declares them; the
 * types resolve in a root that also holds every reference and the well-known types imported.
 */
export function protobufCodec(id: number, schema: string, references: readonly ReferencedSchema[]): RegistryCodec {
  const root = new protobuf.Root();
  const imports: string[] = [];
  for (const reference of references)
    imports.push(...(protobuf.parse(reference.schema, root, { keepCase: true }).imports ?? []));
  const parsed = protobuf.parse(schema, root, { keepCase: true });
  addWellKnown(root, [...imports, ...(parsed.imports ?? [])], new Set(references.map((reference) => reference.name)));
  root.resolveAll();
  // A reference in the same package shares its namespace, so only the schema's own file says
  // which messages are its top level and in what order.
  const own = protobuf.parse(schema, new protobuf.Root(), { keepCase: true });
  const top = topLevelMessages(own.root, own.package).map((message) => root.lookupType(message.fullName));
  const first = top[0];
  return {
    id,
    type: "PROTOBUF",
    label: labelOf("PROTOBUF", id),
    decode: (payload) => {
      const { indexes, next } = readMessageIndexes(payload);
      const message = messageAt(top, indexes);
      return { ...message.toObject(message.decode(payload.subarray(next)), TO_OBJECT) };
    },
    validate: (value) => {
      if (first === undefined) return ["the schema declares no message"];
      if (typeof value !== "object" || value === null) return ["the value is not a JSON object"];
      const unknown = unknownFields(first, value, "");
      if (unknown.length > 0) return unknown;
      try {
        const problem = first.verify(first.fromObject(value));
        return problem === null ? [] : [problem];
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    },
    encode: (value) => {
      if (first === undefined) throw new Error("the schema declares no message");
      const message = first.fromObject(value as Record<string, unknown>);
      return Buffer.concat([writeMessageIndexes([0]), Buffer.from(first.encode(message).finish())]);
    },
  };
}
