import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * An in-process stand-in for the Confluent Schema Registry REST API (plan 164), enough for the
 * Kafka plugin's client, cache and codecs: subjects and versions, schemas by id, registration,
 * compatibility checks and levels, and soft and permanent deletes. Avro BACKWARD compatibility is
 * checked the way that matters for tests: a field the new schema adds needs a default.
 */

export type MockSchemaType = "AVRO" | "PROTOBUF" | "JSON";

interface StoredSchema {
  readonly id: number;
  readonly schema: string;
  readonly schemaType: MockSchemaType;
  readonly references: readonly { name: string; subject: string; version: number }[];
}

interface StoredVersion {
  readonly version: number;
  readonly id: number;
  deleted: boolean;
}

export interface SchemaRegistryMock {
  readonly url: string;
  /** Registers directly, skipping compatibility; answers the id and version. */
  register(
    subject: string,
    schemaType: MockSchemaType,
    schema: string,
    references?: StoredSchema["references"],
  ): { id: number; version: number };
  /** Every request as `METHOD /path`, in order. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

const NOT_FOUND = 404;
const CONFLICT = 409;
const UNPROCESSABLE = 422;
const SUBJECT_NOT_FOUND = 40401;
const VERSION_NOT_FOUND = 40402;
const SCHEMA_NOT_FOUND = 40403;
const INVALID_SCHEMA = 42201;
const DEFAULT_LEVEL = "BACKWARD";
const FIRST_ID = 1;
const CONTENT_TYPE = "application/vnd.schemaregistry.v1+json";

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

interface AvroRecord {
  readonly type?: unknown;
  readonly fields?: readonly { readonly name: string; readonly default?: unknown }[];
}

function avroProblems(previous: string, next: string): string[] {
  const old = JSON.parse(previous) as AvroRecord;
  const fresh = JSON.parse(next) as AvroRecord;
  if (old.type !== "record" || fresh.type !== "record") return [];
  const oldNames = new Set((old.fields ?? []).map((field) => field.name));
  return (fresh.fields ?? [])
    .filter((field) => !oldNames.has(field.name) && !("default" in field))
    .map((field) => `READER_FIELD_MISSING_DEFAULT_VALUE: field '${field.name}' has no default value`);
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

export async function startSchemaRegistryMock(): Promise<SchemaRegistryMock> {
  const schemas = new Map<number, StoredSchema>();
  const subjects = new Map<string, StoredVersion[]>();
  const levels = new Map<string, string>();
  const requests: string[] = [];
  let globalLevel = DEFAULT_LEVEL;
  let nextId = FIRST_ID;

  function idFor(schemaType: MockSchemaType, schema: string, references: StoredSchema["references"]): number {
    for (const stored of schemas.values()) {
      if (stored.schema === schema && stored.schemaType === schemaType) return stored.id;
    }
    const id = nextId;
    nextId += 1;
    schemas.set(id, { id, schema, schemaType, references });
    return id;
  }

  function live(subject: string): StoredVersion[] {
    const versions = (subjects.get(subject) ?? []).filter((version) => !version.deleted);
    if (versions.length === 0) throw new HttpError(NOT_FOUND, SUBJECT_NOT_FOUND, `Subject '${subject}' not found.`);
    return versions;
  }

  function versionOf(subject: string, version: string): StoredVersion {
    const versions = live(subject);
    const found = version === "latest" ? versions.at(-1) : versions.find((entry) => String(entry.version) === version);
    if (found === undefined) throw new HttpError(NOT_FOUND, VERSION_NOT_FOUND, `Version ${version} not found.`);
    return found;
  }

  function schemaJson(stored: StoredSchema): Record<string, unknown> {
    return {
      schema: stored.schema,
      ...(stored.schemaType === "AVRO" ? {} : { schemaType: stored.schemaType }),
      ...(stored.references.length === 0 ? {} : { references: stored.references }),
    };
  }

  function addVersion(subject: string, id: number): number {
    const versions = subjects.get(subject) ?? [];
    const existing = versions.find((version) => version.id === id && !version.deleted);
    if (existing !== undefined) return existing.version;
    const version = (versions.at(-1)?.version ?? 0) + 1;
    subjects.set(subject, [...versions, { version, id, deleted: false }]);
    return version;
  }

  function levelOf(subject: string | null): string {
    return subject === null ? globalLevel : (levels.get(subject) ?? globalLevel);
  }

  function problems(subject: string, schemaType: MockSchemaType, schema: string): string[] {
    const latest = (subjects.get(subject) ?? []).filter((version) => !version.deleted).at(-1);
    if (latest === undefined || levelOf(subject) === "NONE") return [];
    const previous = schemas.get(latest.id);
    if (previous === undefined || previous.schemaType !== "AVRO" || schemaType !== "AVRO") return [];
    return avroProblems(previous.schema, schema);
  }

  function parsedSchema(body: Record<string, unknown>): { schemaType: MockSchemaType; schema: string } {
    const schema = typeof body.schema === "string" ? body.schema : "";
    const schemaType = (typeof body.schemaType === "string" ? body.schemaType : "AVRO") as MockSchemaType;
    if (schemaType !== "PROTOBUF") {
      try {
        JSON.parse(schema);
      } catch {
        throw new HttpError(UNPROCESSABLE, INVALID_SCHEMA, "Invalid schema: not JSON.");
      }
    }
    return { schemaType, schema };
  }

  async function route(request: IncomingMessage): Promise<unknown> {
    const url = new URL(request.url ?? "/", "http://mock");
    const parts = url.pathname
      .split("/")
      .filter((part) => part !== "")
      .map(decodeURIComponent);
    const method = request.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const permanent = url.searchParams.get("permanent") === "true";
    const [head, second, third, fourth, fifth] = parts;
    if (head === "subjects" && second === undefined && method === "GET") {
      return [...subjects.entries()].filter(([, versions]) => versions.some((v) => !v.deleted)).map(([name]) => name);
    }
    if (head === "subjects" && second !== undefined) {
      if (third === undefined && method === "POST") {
        const { schemaType, schema } = parsedSchema(await bodyOf(request));
        const found = live(second).find((version) => {
          const stored = schemas.get(version.id);
          return stored?.schema === schema && stored.schemaType === schemaType;
        });
        if (found === undefined) throw new HttpError(NOT_FOUND, SCHEMA_NOT_FOUND, "Schema not found.");
        return { subject: second, id: found.id, version: found.version, schema };
      }
      if (third === undefined && method === "DELETE") {
        const versions = live(second);
        for (const version of versions) version.deleted = true;
        if (permanent) subjects.delete(second);
        return versions.map((version) => version.version);
      }
      if (third === "versions" && fourth === undefined && method === "GET") return live(second).map((v) => v.version);
      if (third === "versions" && fourth === undefined && method === "POST") {
        const body = await bodyOf(request);
        const { schemaType, schema } = parsedSchema(body);
        const found = problems(second, schemaType, schema);
        if (found.length > 0) {
          throw new HttpError(
            CONFLICT,
            CONFLICT,
            `Schema being registered is incompatible with an earlier schema: ${found.join("; ")}`,
          );
        }
        const references = Array.isArray(body.references) ? (body.references as StoredSchema["references"]) : [];
        const id = idFor(schemaType, schema, references);
        addVersion(second, id);
        return { id };
      }
      if (third === "versions" && fourth !== undefined && method === "GET") {
        const version = versionOf(second, fourth);
        const stored = schemas.get(version.id);
        if (stored === undefined) throw new HttpError(NOT_FOUND, SCHEMA_NOT_FOUND, "Schema not found.");
        return { subject: second, version: version.version, id: version.id, ...schemaJson(stored) };
      }
      if (third === "versions" && fourth !== undefined && method === "DELETE") {
        const version = versionOf(second, fourth);
        version.deleted = true;
        if (permanent)
          subjects.set(
            second,
            (subjects.get(second) ?? []).filter((entry) => entry !== version),
          );
        return version.version;
      }
    }
    if (head === "schemas" && second === "ids" && third !== undefined && method === "GET") {
      const stored = schemas.get(Number(third));
      if (stored === undefined) throw new HttpError(NOT_FOUND, SCHEMA_NOT_FOUND, `Schema ${third} not found.`);
      return schemaJson(stored);
    }
    if (
      head === "compatibility" &&
      second === "subjects" &&
      third !== undefined &&
      fourth === "versions" &&
      fifth !== undefined
    ) {
      versionOf(third, fifth);
      const { schemaType, schema } = parsedSchema(await bodyOf(request));
      const found = problems(third, schemaType, schema);
      return {
        is_compatible: found.length === 0,
        ...(url.searchParams.get("verbose") === "true" ? { messages: found } : {}),
      };
    }
    if (head === "config") {
      if (method === "GET") return { compatibilityLevel: levelOf(second ?? null) };
      if (method === "PUT") {
        const body = await bodyOf(request);
        const level = String(body.compatibility);
        if (second === undefined) globalLevel = level;
        else levels.set(second, level);
        return { compatibility: level };
      }
    }
    throw new HttpError(NOT_FOUND, NOT_FOUND, `No route for ${method} ${url.pathname}.`);
  }

  function respond(response: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    response.writeHead(status, { "Content-Type": CONTENT_TYPE, "Content-Length": Buffer.byteLength(text) });
    response.end(text);
  }

  const server = createServer((request, response) => {
    route(request).then(
      (body) => {
        respond(response, 200, body);
      },
      (error: unknown) => {
        if (error instanceof HttpError)
          respond(response, error.status, { error_code: error.code, message: error.message });
        else respond(response, 500, { error_code: 50001, message: String(error) });
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    register: (subject, schemaType, schema, references = []) => {
      const id = idFor(schemaType, schema, references);
      return { id, version: addVersion(subject, id) };
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
}
