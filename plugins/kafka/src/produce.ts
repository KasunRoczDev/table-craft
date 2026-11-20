import { Producer, ProduceAcks, type BaseOptions } from "@platformatic/kafka";
import type { MessageFormat, ProduceRecord, ProduceResult, SchemaReference } from "@table-craft/plugin-api";
import { CONFLUENT_HEADER_BYTES, CONFLUENT_MAGIC, encodePlain, schemaTypeOfFormat } from "./formats.js";
import { errorText, refused, statementFailure } from "./failures.js";
import { guardInternal, guardWrite } from "./readOnly.js";
import type { SchemaCache } from "./schemaCache.js";

const SCHEMA_ID_OFFSET = 1;
const EMPTY = Buffer.alloc(0);

/** Confluent's 5-byte header: the magic byte and the schema id. */
export function confluentHeader(id: number): Buffer {
  const header = Buffer.alloc(CONFLUENT_HEADER_BYTES);
  header.writeUInt8(CONFLUENT_MAGIC, 0);
  header.writeInt32BE(id, SCHEMA_ID_OFFSET);
  return header;
}

/** Text in a registry format as framed bytes, refused before anything is sent when it does not fit. */
export async function encodeWithSchema(
  cache: SchemaCache,
  subject: string,
  version: number | null,
  format: MessageFormat,
  text: string,
): Promise<Buffer> {
  const wanted = schemaTypeOfFormat(format);
  let codec;
  try {
    codec = await cache.forSubject(subject, version);
  } catch (error) {
    throw refused(`Cannot use subject ${subject}: ${errorText(error)}`);
  }
  if (wanted !== null && codec.type !== wanted) {
    throw refused(`Subject ${subject} holds a ${codec.type} schema, not ${format}; pick the matching format.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw refused(`Write the ${format} value as JSON; ${subject} encodes it from there.`);
  }
  const problems = codec.validate(value);
  if (problems.length > 0) {
    throw refused(`The value does not fit ${subject} (${codec.label}): ${problems.join("; ")}. Nothing was sent.`);
  }
  try {
    return Buffer.concat([confluentHeader(codec.id), codec.encode(value)]);
  } catch (error) {
    throw refused(`The value does not encode with ${subject} (${codec.label}): ${errorText(error)}. Nothing was sent.`);
  }
}

/** Sends single records (Phase 4 of plan 164) through one producer per session, never retried. */
export class KafkaProduce {
  readonly #options: BaseOptions;
  readonly #registry: SchemaCache | null;
  readonly #readOnly: boolean;
  #producer: Producer | null = null;

  constructor(options: BaseOptions, registry: SchemaCache | null, readOnly: boolean) {
    this.#options = options;
    this.#registry = registry;
    this.#readOnly = readOnly;
  }

  async #encode(
    text: string | null,
    format: MessageFormat,
    reference: SchemaReference | null,
    topic: string,
    part: "key" | "value",
  ): Promise<Buffer | undefined> {
    if (text === null) return undefined;
    if (schemaTypeOfFormat(format) !== null) {
      if (this.#registry === null) {
        throw refused(`The ${format} format needs a Schema Registry; set its URL on the datasource.`);
      }
      return encodeWithSchema(
        this.#registry,
        reference?.subject ?? `${topic}-${part}`,
        reference?.version ?? null,
        format,
        text,
      );
    }
    try {
      return encodePlain(text, format);
    } catch (error) {
      throw refused(`The ${part} is not ${format}: ${errorText(error)}. Nothing was sent.`);
    }
  }

  async produce(record: ProduceRecord): Promise<ProduceResult> {
    guardWrite(this.#readOnly, `producing to ${record.topic}`);
    guardInternal(record.topic, "producing to it");
    if (record.partition !== null && (!Number.isInteger(record.partition) || record.partition < 0)) {
      throw refused(`Partition ${String(record.partition)} is not a partition number.`);
    }
    const key = await this.#encode(record.key, record.keyFormat, record.keySchema, record.topic, "key");
    const value = await this.#encode(record.value, record.valueFormat, record.valueSchema, record.topic, "value");
    const headers = new Map<Buffer, Buffer>(
      record.headers.map((header) => [
        Buffer.from(header.name, "utf8"),
        header.value === null ? EMPTY : Buffer.from(header.value, "utf8"),
      ]),
    );
    this.#producer ??= new Producer({ ...this.#options, retries: 0, acks: ProduceAcks.ALL, idempotent: false });
    const producer = this.#producer;
    let result;
    try {
      result = await producer.send({
        messages: [
          {
            topic: record.topic,
            ...(key === undefined ? {} : { key }),
            ...(value === undefined ? {} : { value }),
            ...(record.partition === null ? {} : { partition: record.partition }),
            headers,
          },
        ],
      });
    } catch (cause) {
      throw statementFailure(cause, `Kafka refused the record for ${record.topic}: `);
    }
    const written = result.offsets?.[0];
    return {
      partition: written?.partition ?? record.partition ?? 0,
      offset: written === undefined ? null : written.offset.toString(),
    };
  }

  async close(): Promise<void> {
    await this.#producer?.close().catch(() => undefined);
  }
}
