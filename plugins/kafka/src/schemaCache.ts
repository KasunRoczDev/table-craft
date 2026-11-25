import type { SchemaType } from "@table-craft/plugin-api";
import type { SchemaLookup } from "./formats.js";
import { errorText } from "./failures.js";
import { avroCodec } from "./avro.js";
import { RegistryError, type RegistryClient, type RegistrySchema } from "./registryClient.js";
import type { ReferencedSchema, RegistryCodec } from "./codec.js";
import { jsonSchemaCodec } from "./jsonSchema.js";
import { mapLimited } from "./limited.js";
import { protobufCodec } from "./protobuf.js";

/** Deep enough for any real chain of references, short enough to stop a cycle. */
const MAX_REFERENCE_DEPTH = 16;
const HTTP_NOT_FOUND = 404;
/** How long a schema that failed for a passing reason, such as a timeout, waits before it is asked for again. */
export const RETRY_AFTER_MS = 30_000;
/** Schema ids one batch of messages may fetch; the rest wait for a later batch. */
export const MAX_IDS_PER_PREPARE = 32;
const FETCH_CONCURRENCY = 4;
const TOO_MANY_IDS = "the batch named more schema ids than one fetch looks up";

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

/** Whether the registry said the schema does not exist, which asking again will not change. */
function isDefinite(error: unknown): boolean {
  return error instanceof RegistryError && error.status === HTTP_NOT_FOUND;
}

/**
 * Schemas by id for one session (decision 8 of plan 164): fetched once, compiled once. A schema
 * the registry does not have, or that does not compile, is remembered for good; a timeout, a 5xx
 * or a refused login only until `RETRY_AFTER_MS` has passed.
 */
export class SchemaCache implements SchemaLookup {
  readonly #client: RegistryClient;
  readonly #codecs = new Map<number, RegistryCodec>();
  readonly #failures = new Map<number, string>();
  readonly #transient = new Map<number, { readonly why: string; readonly at: number }>();
  readonly #now: () => number;

  constructor(client: RegistryClient, now: () => number = Date.now) {
    this.#client = client;
    this.#now = now;
  }

  codec(id: number): RegistryCodec | null {
    return this.#codecs.get(id) ?? null;
  }

  failure(id: number): string | null {
    return this.#failures.get(id) ?? this.#transient.get(id)?.why ?? null;
  }

  #due(id: number): boolean {
    if (this.#codecs.has(id) || this.#failures.has(id)) return false;
    const transient = this.#transient.get(id);
    return transient === undefined || this.#now() - transient.at >= RETRY_AFTER_MS;
  }

  /**
   * Fetches and compiles the ids not known yet, a few at a time and at most `MAX_IDS_PER_PREPARE`
   * per call, so a batch naming thousands of ids does not flood the registry.
   */
  async prepare(ids: Iterable<number>): Promise<void> {
    const due = [...new Set(ids)].filter((id) => this.#due(id));
    // Said as the reason, yet due again at the next batch.
    for (const id of due.slice(MAX_IDS_PER_PREPARE)) {
      this.#transient.set(id, { why: TOO_MANY_IDS, at: Number.NEGATIVE_INFINITY });
    }
    await mapLimited(due.slice(0, MAX_IDS_PER_PREPARE), FETCH_CONCURRENCY, async (id) => {
      let schema: RegistrySchema;
      let references: ReferencedSchema[];
      try {
        schema = await this.#client.schemaById(id);
        references = await this.#references(schema, 0);
      } catch (error) {
        if (isDefinite(error)) this.#failures.set(id, errorText(error));
        else this.#transient.set(id, { why: errorText(error), at: this.#now() });
        return;
      }
      try {
        this.#codecs.set(id, codecOf(id, schema.schemaType, schema.schema, references));
        this.#transient.delete(id);
      } catch (error) {
        this.#failures.set(id, errorText(error));
      }
    });
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
