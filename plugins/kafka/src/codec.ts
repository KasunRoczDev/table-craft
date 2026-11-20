import type { SchemaCodec } from "./formats.js";

/** A registry schema that also encodes, for produce. */
export interface RegistryCodec extends SchemaCodec {
  /** What is wrong with `value` for this schema, one line each; empty when it fits. */
  validate(value: unknown): string[];
  /** The bytes after the 5-byte header, Protobuf's message indexes included. */
  encode(value: unknown): Buffer;
}

/** A schema another one references, by the name it is imported or referenced under. */
export interface ReferencedSchema {
  readonly name: string;
  readonly schema: string;
}

export function labelOf(type: string, id: number): string {
  return `${type} id ${String(id)}`;
}
