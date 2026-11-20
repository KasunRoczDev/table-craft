/** Mirrors `SCHEMA_TYPES` in plugin-api (plan 164). */
export const SCHEMA_TYPES = ["AVRO", "PROTOBUF", "JSON"] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];

/** Mirrors `SubjectSummary` in plugin-api. */
export interface SubjectSummary {
  readonly subject: string;
  readonly latestVersion: number | null;
  readonly type: SchemaType | null;
}

/** Mirrors `SchemaVersionReference` in plugin-api. */
export interface SchemaVersionReference {
  readonly name: string;
  readonly subject: string;
  readonly version: number;
}

/** Mirrors `SchemaVersion` in plugin-api. */
export interface SchemaVersion {
  readonly subject: string;
  readonly version: number;
  readonly id: number;
  readonly type: SchemaType;
  readonly schema: string;
  readonly references: readonly SchemaVersionReference[];
}

/** Mirrors `CompatibilityCheck` in plugin-api. */
export interface CompatibilityCheck {
  readonly compatible: boolean;
  readonly messages: readonly string[];
}

/** Mirrors `RegisteredSchema` in plugin-api. */
export interface RegisteredSchema {
  readonly id: number;
  readonly version: number | null;
}

/** Whether the datasource's Schema Registry can be used; `reason` says why not. */
export interface SchemaRegistryStatus {
  readonly available: boolean;
  readonly reason: string | null;
}
