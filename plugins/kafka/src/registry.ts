import {
  PluginError,
  type CompatibilityCheck,
  type RegisteredSchema,
  type SchemaRegistry,
  type SchemaType,
  type SchemaVersion,
  type SubjectSummary,
} from "@table-craft/plugin-api";
import { guardWrite } from "./readOnly.js";
import { globMatcher } from "./glob.js";
import { mapLimited } from "./limited.js";
import { SchemaCache } from "./schemaCache.js";
import { type RegistryClient } from "./registryClient.js";

export const NO_REGISTRY_REASON = "No Schema Registry URL is set for this data source";
/** Subjects described at once when listing, so a registry with thousands is not flooded. */
const DESCRIBE_CONCURRENCY = 8;

/** The service of a session without a registry URL: present, and saying why it cannot be used. */
export class UnavailableRegistry implements SchemaRegistry {
  readonly available = false;
  readonly reason = NO_REGISTRY_REASON;

  #refuse(): Promise<never> {
    return Promise.reject(
      new PluginError("statementFailed", `${NO_REGISTRY_REASON}; set it in the datasource's Schema Registry fields.`),
    );
  }

  subjects(): Promise<readonly SubjectSummary[]> {
    return this.#refuse();
  }
  versions(): Promise<readonly number[]> {
    return this.#refuse();
  }
  get(): Promise<SchemaVersion> {
    return this.#refuse();
  }
  check(): Promise<CompatibilityCheck> {
    return this.#refuse();
  }
  register(): Promise<RegisteredSchema> {
    return this.#refuse();
  }
  compatibility(): Promise<string> {
    return this.#refuse();
  }
  remove(): Promise<readonly number[]> {
    return this.#refuse();
  }
}

/** The `schemaRegistry` service over the datasource's registry (decision 8 of plan 164). */
export class KafkaSchemaRegistry implements SchemaRegistry {
  readonly available = true;
  readonly reason = null;
  readonly cache: SchemaCache;
  readonly #client: RegistryClient;
  readonly #readOnly: boolean;
  readonly #listed: (name: string) => boolean;

  constructor(client: RegistryClient, readOnly: boolean, listed: (name: string) => boolean = () => true) {
    this.#client = client;
    this.cache = new SchemaCache(client);
    this.#readOnly = readOnly;
    this.#listed = listed;
  }

  async subjects(glob: string | null): Promise<readonly SubjectSummary[]> {
    const matches = globMatcher(glob);
    const names = (await this.#client.subjects()).filter((subject) => matches(subject) && this.#listed(subject)).sort();
    return mapLimited(names, DESCRIBE_CONCURRENCY, async (subject) => {
      try {
        const latest = await this.#client.version(subject, null);
        return { subject, latestVersion: latest.version, type: latest.schemaType };
      } catch {
        return { subject, latestVersion: null, type: null };
      }
    });
  }

  /** Every subject's name, without describing each, for completion. */
  subjectNames(): Promise<string[]> {
    return this.#client.subjects();
  }

  async versions(subject: string): Promise<readonly number[]> {
    return (await this.#client.versions(subject)).sort((a, b) => a - b);
  }

  async get(subject: string, version: number | null): Promise<SchemaVersion> {
    const found = await this.#client.version(subject, version);
    return {
      subject: found.subject,
      version: found.version,
      id: found.id,
      type: found.schemaType,
      schema: found.schema,
      references: found.references,
    };
  }

  check(subject: string, type: SchemaType, schema: string): Promise<CompatibilityCheck> {
    return this.#client.check(subject, type, schema);
  }

  register(subject: string, type: SchemaType, schema: string): Promise<RegisteredSchema> {
    guardWrite(this.#readOnly, `registering a schema under ${subject}`);
    return this.#client.register(subject, type, schema);
  }

  compatibility(subject: string | null, level: string | null): Promise<string> {
    if (level === null) return this.#client.compatibility(subject);
    guardWrite(this.#readOnly, "changing a compatibility level");
    return this.#client.setCompatibility(subject, level.toUpperCase());
  }

  remove(subject: string, version: number | null, permanent: boolean): Promise<readonly number[]> {
    guardWrite(this.#readOnly, `deleting ${version === null ? "subject" : "a version of"} ${subject}`);
    return this.#client.remove(subject, version, permanent);
  }
}
