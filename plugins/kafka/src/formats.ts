import {
  toBytesValue,
  toWireInteger,
  type MessageFormat,
  type SchemaType,
  type WireValue,
} from "@table-craft/plugin-api";

/** Confluent's wire format: a zero magic byte, then the schema id as a big-endian int32. */
export const CONFLUENT_MAGIC = 0x00;
export const CONFLUENT_HEADER_BYTES = 5;
const INT32_BYTES = 4;
const INT64_BYTES = 8;
const DOUBLE_BYTES = 8;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

/** The formats each schema type decodes under. */
const REGISTRY_FORMATS: Readonly<Record<SchemaType, MessageFormat>> = {
  AVRO: "avro",
  PROTOBUF: "protobuf",
  JSON: "jsonSchema",
};

/** A registry schema ready to turn bytes after the Confluent header into a value, and back. */
export interface SchemaCodec {
  readonly id: number;
  readonly type: SchemaType;
  /** What the `keySchema` and `valueSchema` columns show, such as `AVRO id 12`. */
  readonly label: string;
  /** The value of `payload`, the bytes after the 5-byte header; throws when they do not fit. */
  decode(payload: Buffer): unknown;
  /** The payload as display text, for a codec whose payload already is JSON. */
  decodeText?(payload: Buffer): string;
}

/** Schemas already fetched, looked up without waiting; a read fetches every id it meets first. */
export interface SchemaLookup {
  codec(id: number): SchemaCodec | null;
  /** Why `id` has no codec, such as the registry's refusal; null when it was never asked for. */
  failure(id: number): string | null;
}

/** One key or value as a cell, the text the filter matches, and what went wrong if anything. */
export interface Decoded {
  readonly cell: WireValue;
  /** Null for a null key or value. */
  readonly text: string | null;
  readonly schema: string | null;
  /** Why the chosen format did not fit; the cell then holds the bytes. */
  readonly warning: string | null;
}

export interface DecodeOptions {
  readonly lookup: SchemaLookup | null;
  /** Ship every byte of a value shown as bytes (`ExecuteOptions.fullBytes`). */
  readonly fullBytes: boolean;
}

/** The schema id of Confluent-framed bytes, or null when they are not framed. */
export function schemaIdOf(bytes: Uint8Array | null): number | null {
  if (bytes === null || bytes.length < CONFLUENT_HEADER_BYTES || bytes[0] !== CONFLUENT_MAGIC) return null;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).readInt32BE(1);
}

/**
 * A decoded value as plain JSON data. This walk runs before `JSON.stringify`, because a Buffer's
 * own `toJSON` would turn it into `{"type":"Buffer",…}` before a replacer saw it.
 */
function plainJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
  }
  if (value instanceof Uint8Array)
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
  if (Array.isArray(value)) return value.map(plainJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, plainJson(item)]));
}

/**
 * JSON text of a decoded value: bytes as base64, 64-bit integers as numbers where JavaScript holds
 * them exactly and as decimal strings past that.
 */
export function jsonText(value: unknown): string {
  return JSON.stringify(plainJson(value));
}

/** The bytes as text when they are valid UTF-8 without control characters but tab and line breaks. */
export function readableText(bytes: Uint8Array): string | null {
  for (const byte of bytes) {
    if ((byte < FIRST_PRINTABLE && byte !== TAB && byte !== LINE_FEED && byte !== CARRIAGE_RETURN) || byte === DELETE)
      return null;
  }
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

function asBytes(bytes: Uint8Array, options: DecodeOptions, warning: string | null): Decoded {
  return { cell: toBytesValue(bytes, { fullBytes: options.fullBytes }), text: hexOf(bytes), schema: null, warning };
}

function shownAs(cell: WireValue, text: string, schema: string | null = null): Decoded {
  return { cell, text, schema, warning: null };
}

function parsedJson(text: string): Decoded | null {
  try {
    JSON.parse(text);
    return shownAs({ kind: "json", text }, text);
  } catch {
    return null;
  }
}

function registryDecoded(bytes: Buffer, format: MessageFormat, options: DecodeOptions): Decoded {
  const id = schemaIdOf(bytes);
  if (id === null) {
    return asBytes(
      bytes,
      options,
      `has no Schema Registry header (magic byte 0 and a schema id), so it is not ${format}`,
    );
  }
  if (options.lookup === null)
    return asBytes(bytes, options, `names schema id ${String(id)}, but no Schema Registry is set`);
  const codec = options.lookup.codec(id);
  if (codec === null) {
    const why = options.lookup.failure(id);
    return asBytes(
      bytes,
      options,
      `names schema id ${String(id)}, which cannot be used${why === null ? "" : `: ${why}`}`,
    );
  }
  if (format !== "auto" && REGISTRY_FORMATS[codec.type] !== format) {
    return asBytes(bytes, options, `names schema id ${String(id)}, a ${codec.type} schema, not ${format}`);
  }
  try {
    const payload = bytes.subarray(CONFLUENT_HEADER_BYTES);
    const text = codec.decodeText?.(payload) ?? jsonText(codec.decode(payload));
    return shownAs({ kind: "json", text }, text, codec.label);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return asBytes(bytes, options, `does not decode with schema id ${String(id)} (${codec.type}): ${reason}`);
  }
}

function sized(bytes: Buffer, width: number, format: MessageFormat, options: DecodeOptions): Decoded | null {
  if (bytes.length === width) return null;
  return asBytes(bytes, options, `is ${String(bytes.length)} bytes, not the ${String(width)} of ${format}`);
}

function automatic(bytes: Buffer, options: DecodeOptions): Decoded {
  const id = schemaIdOf(bytes);
  const codec = id === null ? null : (options.lookup?.codec(id) ?? null);
  if (codec !== null) return registryDecoded(bytes, "auto", options);
  const text = readableText(bytes);
  if (text === null) return asBytes(bytes, options, null);
  return parsedJson(text) ?? shownAs(text, text);
}

/**
 * Bytes as `format` shows them (decision 7). Auto tries a registry schema, then JSON, then UTF-8
 * text, then bytes; an explicit format that does not fit shows the bytes with a warning, and the
 * row stays.
 */
export function decode(bytes: Buffer | null, format: MessageFormat, options: DecodeOptions): Decoded {
  if (bytes === null) return { cell: null, text: null, schema: null, warning: null };
  switch (format) {
    case "auto":
      return automatic(bytes, options);
    case "string": {
      const text = readableText(bytes) ?? utf8OrNull(bytes);
      return text === null ? asBytes(bytes, options, "is not valid UTF-8") : shownAs(text, text);
    }
    case "json": {
      const text = utf8OrNull(bytes);
      return (text === null ? null : parsedJson(text)) ?? asBytes(bytes, options, "is not valid JSON");
    }
    case "avro":
    case "protobuf":
    case "jsonSchema":
      return registryDecoded(bytes, format, options);
    case "hex": {
      const text = hexOf(bytes);
      return shownAs(text, text);
    }
    case "base64": {
      const text = bytes.toString("base64");
      return shownAs(text, text);
    }
    case "int32":
      return sized(bytes, INT32_BYTES, format, options) ?? number(bytes.readInt32BE(0));
    case "int64": {
      const wrong = sized(bytes, INT64_BYTES, format, options);
      if (wrong !== null) return wrong;
      const value = bytes.readBigInt64BE(0);
      return shownAs(toWireInteger(value), value.toString());
    }
    case "double":
      return sized(bytes, DOUBLE_BYTES, format, options) ?? number(bytes.readDoubleBE(0));
  }
}

function number(value: number): Decoded {
  return shownAs(value, String(value));
}

function utf8OrNull(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/** A number's text without surrounding space; empty text is refused rather than read as 0. */
function numeral(text: string, format: MessageFormat): string {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error(`${format} takes a number; the text is empty`);
  return trimmed;
}

/** Text in `format` as the bytes a producer sends; the registry formats go through `produce.ts`. */
export function encodePlain(text: string, format: MessageFormat): Buffer {
  switch (format) {
    case "auto":
    case "string":
      return Buffer.from(text, "utf8");
    case "json":
      JSON.parse(text);
      return Buffer.from(text, "utf8");
    case "hex": {
      const digits = text.replace(/^0x/i, "").replace(/\s+/g, "");
      if (!/^(?:[0-9a-f]{2})*$/i.test(digits)) throw new Error("hex takes pairs of hex digits, such as 0a1b");
      return Buffer.from(digits, "hex");
    }
    case "base64":
      return Buffer.from(text.trim(), "base64");
    case "int32": {
      const value = Number(numeral(text, format));
      if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
        throw new Error(`${text} is not a whole number from ${String(INT32_MIN)} to ${String(INT32_MAX)}`);
      }
      const bytes = Buffer.alloc(INT32_BYTES);
      bytes.writeInt32BE(value, 0);
      return bytes;
    }
    case "int64": {
      const bytes = Buffer.alloc(INT64_BYTES);
      bytes.writeBigInt64BE(BigInt(numeral(text, format)), 0);
      return bytes;
    }
    case "double": {
      const trimmed = numeral(text, format);
      const value = Number(trimmed);
      if (Number.isNaN(value) && trimmed !== "NaN") throw new Error(`${text} is not a number`);
      const bytes = Buffer.alloc(DOUBLE_BYTES);
      bytes.writeDoubleBE(value, 0);
      return bytes;
    }
    case "avro":
    case "protobuf":
    case "jsonSchema":
      throw new Error(`${format} encodes through the Schema Registry`);
  }
}

/** The format a registry schema type decodes under. */
export function formatOfSchemaType(type: SchemaType): MessageFormat {
  return REGISTRY_FORMATS[type];
}

/** The schema type a registry format needs; null for the formats without a registry. */
export function schemaTypeOfFormat(format: MessageFormat): SchemaType | null {
  switch (format) {
    case "avro":
      return "AVRO";
    case "protobuf":
      return "PROTOBUF";
    case "jsonSchema":
      return "JSON";
    default:
      return null;
  }
}
