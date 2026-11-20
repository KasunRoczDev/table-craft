import type { SchemaType } from "@table-craft/plugin-api";
import type { SchemaLookup } from "./formats.js";
import { errorText } from "./failures.js";
import { avroCodec } from "./avro.js";
import type { RegistryClient, RegistrySchema } from "./registryClient.js";
import type { ReferencedSchema, RegistryCodec } from "./codec.js";
import { jsonSchemaCodec } from "./jsonSchema.js";
import { protobufCodec } from "./protobuf.js";

/** Deep enough for any real chain of references, short enough to stop a cycle. */
const MAX_REFERENCE_DEPTH = 16;

export function codecOf(
  id: number,
  type: SchemaType,
  schema: string,
  references: readonly ReferencedSchema[],
): RegistryCodec {
  switch (type) {
    case "AVRO":
      return avroCodec(id, schema, references);
    case "PROTOBUF":
      return protobufCodec(id, schema, references);
    case "JSON":
      return jsonSchemaCodec(id, schema);
  }
}

/** Schemas by id for one session (decision 8 of plan 164): fetched once, compiled once. */
export class SchemaCache implements SchemaLookup {
  readonly #client: RegistryClient;
  readonly #codecs = new Map<number, RegistryCodec>();
  readonly #failures = new Map<number, string>();

  constructor(client: RegistryClient) {
    this.#client = client;
  }

  codec(id: number): RegistryCodec | null {
    return this.#codecs.get(id) ?? null;
  }

  failure(id: number): string | null {
    return this.#failures.get(id) ?? null;
  }

  /** Fetches and compiles every id not known yet; one that fails is remembered with why. */
  async prepare(ids: Iterable<number>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.#codecs.has(id) && !this.#failures.has(id));
    await Promise.all(
      missing.map(async (id) => {
        try {
          const schema = await this.#client.schemaById(id);
          this.#codecs.set(id, codecOf(id, schema.schemaType, schema.schema, await this.#references(schema, 0)));
        } catch (error) {
          this.#failures.set(id, errorText(error));
        }
      }),
    );
  }

  /** The codec of `subject` at `version` (latest for null), for encoding a produce. */
  async forSubject(subject: string, version: number | null): Promise<RegistryCodec> {
    const found = await this.#client.version(subject, version);
    await this.prepare([found.id]);
    const codec = this.codec(found.id);
    if (codec === null) {
      throw new Error(
        `schema id ${String(found.id)} of ${subject} cannot be used: ${this.failure(found.id) ?? "unknown"}`,
      );
    }
    return codec;
  }

  async #references(schema: RegistrySchema, depth: number): Promise<ReferencedSchema[]> {
    if (schema.references.length === 0 || depth > MAX_REFERENCE_DEPTH) return [];
    const resolved: ReferencedSchema[] = [];
    for (const reference of schema.references) {
      const version = await this.#client.version(reference.subject, reference.version);
      resolved.push(...(await this.#references(version, depth + 1)), {
        name: reference.name,
        schema: version.schema,
      });
    }
    return resolved;
  }
}
