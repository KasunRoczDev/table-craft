import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ConnectionOptions as TlsOptions } from "node:tls";
import { PluginError, SCHEMA_TYPES, type SchemaType } from "@table-craft/plugin-api";

const CONTENT_TYPE = "application/vnd.schemaregistry.v1+json";
const HTTP_OK_FIRST = 200;
const HTTP_OK_LAST = 299;
const HTTP_NOT_FOUND = 404;
/** Confluent's error codes for a subject or version that does not exist. */
const SUBJECT_NOT_FOUND = 40401;
const VERSION_NOT_FOUND = 40402;
const LATEST = "latest";

export interface RegistryClientOptions {
  readonly url: string;
  /** `user:password` for basic auth; null for none. */
  readonly basicAuth: { readonly user: string; readonly password: string } | null;
  /** For an `https` URL: the connection's CA and verification. */
  readonly tls: TlsOptions | null;
  readonly timeoutMs: number;
}

/** A schema as the registry answers it: by id, or as a subject's version. */
export interface RegistrySchema {
  readonly schema: string;
  readonly schemaType: SchemaType;
  readonly references: readonly { readonly name: string; readonly subject: string; readonly version: number }[];
}

export interface RegistryVersion extends RegistrySchema {
  readonly subject: string;
  readonly version: number;
  readonly id: number;
}

/** A refusal from the registry, with its HTTP status and its own error code. */
export class RegistryError extends PluginError {
  constructor(
    readonly status: number,
    readonly registryCode: number | null,
    message: string,
  ) {
    super("statementFailed", message);
  }
}

interface RawSchema {
  readonly schema?: unknown;
  readonly schemaType?: unknown;
  readonly references?: unknown;
  readonly subject?: unknown;
  readonly version?: unknown;
  readonly id?: unknown;
}

function schemaTypeOf(value: unknown): SchemaType {
  return SCHEMA_TYPES.find((type) => type === value) ?? "AVRO";
}

function referencesOf(value: unknown): RegistrySchema["references"] {
  if (!Array.isArray(value)) return [];
  return (value as { name?: unknown; subject?: unknown; version?: unknown }[]).flatMap((entry) =>
    typeof entry.name === "string" && typeof entry.subject === "string" && typeof entry.version === "number"
      ? [{ name: entry.name, subject: entry.subject, version: entry.version }]
      : [],
  );
}

function schemaOf(raw: RawSchema): RegistrySchema {
  return {
    schema: typeof raw.schema === "string" ? raw.schema : "",
    schemaType: schemaTypeOf(raw.schemaType),
    references: referencesOf(raw.references),
  };
}

function segment(text: string): string {
  return encodeURIComponent(text);
}

/**
 * A small client for the Confluent Schema Registry REST API (decision 8 of plan 164). Node's
 * `http` and `https` rather than `fetch`, because only they take the connection's CA file without
 * a dispatcher from a package Electron does not ship.
 */
export class RegistryClient {
  readonly #options: RegistryClientOptions;
  readonly #base: URL;

  constructor(options: RegistryClientOptions) {
    this.#options = options;
    this.#base = new URL(options.url.endsWith("/") ? options.url : `${options.url}/`);
  }

  get url(): string {
    return this.#options.url;
  }

  async subjects(): Promise<string[]> {
    const answer = await this.#call("GET", "subjects");
    return Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [];
  }

  async versions(subject: string): Promise<number[]> {
    const answer = await this.#call("GET", `subjects/${segment(subject)}/versions`);
    return Array.isArray(answer) ? answer.filter((item): item is number => typeof item === "number") : [];
  }

  async version(subject: string, version: number | null): Promise<RegistryVersion> {
    const raw = (await this.#call(
      "GET",
      `subjects/${segment(subject)}/versions/${version === null ? LATEST : String(version)}`,
    )) as RawSchema;
    return {
      ...schemaOf(raw),
      subject: typeof raw.subject === "string" ? raw.subject : subject,
      version: typeof raw.version === "number" ? raw.version : (version ?? 0),
      id: typeof raw.id === "number" ? raw.id : 0,
    };
  }

  async schemaById(id: number): Promise<RegistrySchema> {
    return schemaOf((await this.#call("GET", `schemas/ids/${String(id)}`)) as RawSchema);
  }

  /** Whether `schema` may follow the latest version of `subject`; a subject without versions takes anything. */
  async check(subject: string, type: SchemaType, schema: string): Promise<{ compatible: boolean; messages: string[] }> {
    try {
      const answer = (await this.#call(
        "POST",
        `compatibility/subjects/${segment(subject)}/versions/${LATEST}?verbose=true`,
        { schema, schemaType: type },
      )) as { is_compatible?: unknown; messages?: unknown };
      const messages = Array.isArray(answer.messages) ? answer.messages.map(String) : [];
      return { compatible: answer.is_compatible === true, messages };
    } catch (error) {
      if (
        error instanceof RegistryError &&
        (error.registryCode === SUBJECT_NOT_FOUND || error.registryCode === VERSION_NOT_FOUND)
      ) {
        return { compatible: true, messages: [] };
      }
      throw error;
    }
  }

  async register(subject: string, type: SchemaType, schema: string): Promise<{ id: number; version: number | null }> {
    const body = { schema, schemaType: type };
    const answer = (await this.#call("POST", `subjects/${segment(subject)}/versions`, body)) as {
      id?: unknown;
      version?: unknown;
    };
    const id = typeof answer.id === "number" ? answer.id : 0;
    if (typeof answer.version === "number") return { id, version: answer.version };
    try {
      const found = (await this.#call("POST", `subjects/${segment(subject)}`, body)) as { version?: unknown };
      return { id, version: typeof found.version === "number" ? found.version : null };
    } catch {
      return { id, version: null };
    }
  }

  /** The compatibility level of `subject` (falling back to the global one), or the global one for null. */
  async compatibility(subject: string | null): Promise<string> {
    const path = subject === null ? "config" : `config/${segment(subject)}?defaultToGlobal=true`;
    try {
      const answer = (await this.#call("GET", path)) as { compatibilityLevel?: unknown; compatibility?: unknown };
      const level = answer.compatibilityLevel ?? answer.compatibility;
      return typeof level === "string" ? level : "";
    } catch (error) {
      // Registries without `defaultToGlobal` answer 404 for a subject with no level of its own.
      if (subject !== null && error instanceof RegistryError && error.status === HTTP_NOT_FOUND) {
        return this.compatibility(null);
      }
      throw error;
    }
  }

  async setCompatibility(subject: string | null, level: string): Promise<string> {
    const path = subject === null ? "config" : `config/${segment(subject)}`;
    const answer = (await this.#call("PUT", path, { compatibility: level })) as { compatibility?: unknown };
    return typeof answer.compatibility === "string" ? answer.compatibility : level;
  }

  /** Deletes a version, or the whole subject for null; answers the versions deleted. */
  async remove(subject: string, version: number | null, permanent: boolean): Promise<number[]> {
    const query = permanent ? "?permanent=true" : "";
    const path =
      version === null
        ? `subjects/${segment(subject)}${query}`
        : `subjects/${segment(subject)}/versions/${String(version)}${query}`;
    const answer = await this.#call("DELETE", path);
    if (Array.isArray(answer)) return answer.filter((item): item is number => typeof item === "number");
    return typeof answer === "number" ? [answer] : [];
  }

  #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.#base);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
    const secure = url.protocol === "https:";
    const auth = this.#options.basicAuth;
    const options: RequestOptions = {
      method,
      timeout: this.#options.timeoutMs,
      headers: {
        Accept: `${CONTENT_TYPE}, application/json`,
        ...(payload === null ? {} : { "Content-Type": CONTENT_TYPE, "Content-Length": String(payload.length) }),
        ...(auth === null
          ? {}
          : { Authorization: `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString("base64")}` }),
      },
      ...(secure && this.#options.tls !== null ? this.#options.tls : {}),
    };
    return new Promise<unknown>((resolve, reject) => {
      const onResponse = (response: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          let parsed: unknown;
          try {
            parsed = text === "" ? null : JSON.parse(text);
          } catch {
            parsed = text;
          }
          if (status >= HTTP_OK_FIRST && status <= HTTP_OK_LAST) {
            resolve(parsed);
            return;
          }
          const fields = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
            error_code?: unknown;
            message?: unknown;
          };
          const code = typeof fields.error_code === "number" ? fields.error_code : null;
          const message = typeof fields.message === "string" ? fields.message : text.slice(0, 200);
          reject(
            new RegistryError(
              status,
              code,
              `The Schema Registry answered ${String(status)}${code === null ? "" : ` (error ${String(code)})`} to ${method} /${path.split("?")[0] ?? path}: ${message}`,
            ),
          );
        });
      };
      const request = secure ? httpsRequest(url, options, onResponse) : httpRequest(url, options, onResponse);
      request.on("timeout", () => {
        request.destroy(new Error(`no answer within ${String(this.#options.timeoutMs)} ms`));
      });
      request.on("error", (cause) => {
        reject(
          new PluginError(
            "statementFailed",
            `Cannot reach the Schema Registry at ${this.#options.url}: ${cause.message}. Check the Schema Registry URL of the datasource.`,
            { cause },
          ),
        );
      });
      if (payload !== null) request.write(payload);
      request.end();
    });
  }
}
