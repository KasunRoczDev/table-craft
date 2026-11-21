export const SCHEMA_TYPES = ["AVRO", "PROTOBUF", "JSON"] as const;

export type SchemaType = (typeof SCHEMA_TYPES)[number];

export interface SubjectSummary {
  readonly subject: string;
  readonly latestVersion: number | null;
  readonly type: SchemaType | null;
}

export interface SchemaVersionReference {
  readonly name: string;
  readonly subject: string;
  readonly version: number;
}

export interface SchemaVersion {
  readonly subject: string;
  readonly version: number;
  readonly id: number;
  readonly type: SchemaType;
  /** The schema text as the registry holds it. */
  readonly schema: string;
  readonly references: readonly SchemaVersionReference[];
}

export interface CompatibilityCheck {
  readonly compatible: boolean;
  /** The registry's own reasons when it is not. */
  readonly messages: readonly string[];
}

export interface RegisteredSchema {
  readonly id: number;
  readonly version: number | null;
}

/**
 * The `schemaRegistry` service (plan 164): a Confluent-compatible registry beside the brokers.
 * A plugin declaring it returns the service on every session; without a registry it answers
 * `available: false` with its `reason`, and every other method rejects with `statementFailed`.
 * A write fails as the `topics` service's writes do: `statementFailed` when the registry refused
 * it, with `outcome: "unknown"` when it may have been applied.
 */
export interface SchemaRegistry {
  readonly available: boolean;
  /** Why the registry cannot be used, such as "No Schema Registry URL is set for this data source"; null when available. */
  readonly reason: string | null;
  subjects(glob: string | null): Promise<readonly SubjectSummary[]>;
  versions(subject: string): Promise<readonly number[]>;
  /** A version, or the latest for null. */
  get(subject: string, version: number | null): Promise<SchemaVersion>;
  /** Whether `schema` could be registered as the next version of `subject`. */
  check(subject: string, type: SchemaType, schema: string): Promise<CompatibilityCheck>;
  register(subject: string, type: SchemaType, schema: string): Promise<RegisteredSchema>;
  /** The compatibility level of `subject`, or the global one for null; sets it first when `level` is given. */
  compatibility(subject: string | null, level: string | null): Promise<string>;
  /** Soft-deletes a version, or the subject for a null `version`; `permanent` hard-deletes what is already soft-deleted. Returns the versions deleted. */
  remove(subject: string, version: number | null, permanent: boolean): Promise<readonly number[]>;
}
