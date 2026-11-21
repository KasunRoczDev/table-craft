import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { ConnectionOptions as TlsOptions } from "node:tls";
import { PluginError } from "@table-craft/plugin-api";
import { REPLY_MAX_BYTES } from "./limits.js";

export const HTTP_METHODS = ["GET", "POST", "PUT", "DELETE", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

const JSON_TYPE = "application/json";
const NDJSON_TYPE = "application/x-ndjson";
const USER_AGENT = "TableCraft";
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_ERROR = 400;
const HTTP_GATEWAY_TIMEOUT = 504;
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNABORTED",
]);
const ERROR_PREVIEW_CHARS = 300;
const MIB = 1024 * 1024;
const DOT_SEGMENT = /^\.{1,2}$/;

/** Whether a path holds a `.` or `..` segment, plain or percent-encoded, which a URL would resolve away. */
export function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => {
    try {
      return DOT_SEGMENT.test(decodeURIComponent(segment));
    } catch {
      return DOT_SEGMENT.test(segment);
    }
  });
}

export interface ClientOptions {
  readonly baseUrl: string;
  readonly authorization: string | null;
  readonly tls: TlsOptions | null;
  readonly requestTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly keepAliveInitialDelayMs?: number;
}

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** Sent as is; an object is sent as JSON, a string as NDJSON when `ndjson`. */
  readonly body?: unknown;
  readonly ndjson?: boolean;
  /** Statuses that resolve instead of rejecting, such as 404 for an existence check. */
  readonly accept?: readonly number[];
  /** The largest body read before the reply is dropped; `REPLY_MAX_BYTES` by default. */
  readonly maxBytes?: number;
}

export interface Reply {
  readonly status: number;
  /** The parsed JSON body; the raw text when it is not JSON; null for an empty body. */
  readonly body: unknown;
  readonly text: string;
}

/**
 * An HTTP error Elasticsearch answered with, worded from its own `error.reason`. A 403 means the
 * user lacks a privilege for this one request (plan 165), never that the connection failed.
 */
export class ElasticHttpError extends PluginError {
  constructor(
    readonly status: number,
    readonly type: string | null,
    message: string,
    readonly body: unknown,
  ) {
    super("statementFailed", message);
  }

  get forbidden(): boolean {
    return this.status === HTTP_FORBIDDEN;
  }
}

/** A reply past `REPLY_MAX_BYTES`, dropped unread so its bytes never pile up in the engine. */
export class ReplyTooLargeError extends PluginError {
  readonly tooLarge = true;

  constructor(readonly limit: number) {
    super(
      "statementFailed",
      `The reply passed ${String(Math.round(limit / MIB))} MB and was dropped to keep memory free; ask for fewer hits with "size", or fewer fields with "_source" or "filter_path".`,
    );
  }
}

/** Structural, since an error may cross plugin bundles. */
export function isReplyTooLarge(error: unknown): boolean {
  return error instanceof Error && (error as { tooLarge?: unknown }).tooLarge === true;
}

/** Structural, since an error may cross plugin bundles. */
export function isForbidden(error: unknown): boolean {
  return error instanceof Error && (error as { status?: unknown }).status === HTTP_FORBIDDEN;
}

interface ErrorBody {
  readonly error?: unknown;
  readonly status?: unknown;
}

interface ErrorDetail {
  readonly type?: unknown;
  readonly reason?: unknown;
  readonly root_cause?: unknown;
  readonly caused_by?: unknown;
}

function detailOf(body: unknown): { type: string | null; reason: string | null } {
  if (typeof body !== "object" || body === null) return { type: null, reason: null };
  const error = (body as ErrorBody).error;
  if (typeof error === "string") return { type: null, reason: error };
  if (typeof error !== "object" || error === null) return { type: null, reason: null };
  const detail = error as ErrorDetail;
  const type = typeof detail.type === "string" ? detail.type : null;
  let reason = typeof detail.reason === "string" ? detail.reason : null;
  const caused = detail.caused_by as ErrorDetail | undefined;
  if (typeof caused?.reason === "string" && caused.reason !== reason) {
    reason = reason === null ? caused.reason : `${reason}: ${caused.reason}`;
  }
  return { type, reason };
}

/** What a failed request says, with advice for the statuses that have one. */
export function httpError(status: number, body: unknown, text: string): ElasticHttpError {
  const { type, reason } = detailOf(body);
  const said = reason ?? (text.trim() === "" ? `HTTP ${String(status)}` : text.trim().slice(0, ERROR_PREVIEW_CHARS));
  const typed = type === null ? said : `${said} (${type})`;
  if (status === HTTP_UNAUTHORIZED) {
    return new ElasticHttpError(
      status,
      type,
      `Elasticsearch refused the credentials: ${typed}. Check the authentication settings of the data source.`,
      body,
    );
  }
  if (status === HTTP_FORBIDDEN) {
    return new ElasticHttpError(
      status,
      type,
      `This user is not allowed to do that: ${typed}. Ask a cluster admin for the privilege, or use another view.`,
      body,
    );
  }
  if (status === HTTP_GATEWAY_TIMEOUT) {
    return new ElasticHttpError(status, type, `The request timed out at a gateway: ${typed}.`, body);
  }
  return new ElasticHttpError(status, type, typed, body);
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

export function isNetworkError(error: unknown): boolean {
  const code = codeOf(error);
  return code !== null && NETWORK_CODES.has(code);
}

function parseBody(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function encodeBody(body: unknown, ndjson: boolean): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return ndjson && !body.endsWith("\n") ? `${body}\n` : body;
  return JSON.stringify(body);
}

/** A small Elasticsearch REST client on Node's HTTP stack: no driver, so every version and fork speaks it (decision 173). */
export class ElasticClient {
  readonly #options: ClientOptions;
  readonly #agent: HttpAgent;
  readonly #base: URL;
  #sequence = 0;

  constructor(options: ClientOptions) {
    this.#options = options;
    this.#base = new URL(options.baseUrl);
    const agentOptions = {
      keepAlive: true,
      ...(options.keepAliveInitialDelayMs === undefined ? {} : { keepAliveMsecs: options.keepAliveInitialDelayMs }),
    };
    this.#agent =
      this.#base.protocol === "https:"
        ? new HttpsAgent({ ...agentOptions, ...(options.tls ?? {}) })
        : new HttpAgent(agentOptions);
  }

  get baseUrl(): string {
    return this.#options.baseUrl;
  }

  /** Sends `method path`; rejects with an `ElasticHttpError` for an error status, `connectionLost` when unreachable, `cancelled` when aborted. */
  request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<Reply> {
    const url = this.#urlOf(path);
    if (typeof url === "string") return Promise.reject(new PluginError("statementFailed", url));
    const payload = encodeBody(options.body, options.ndjson === true);
    this.#sequence += 1;
    const headers: Record<string, string> = {
      Accept: JSON_TYPE,
      "User-Agent": USER_AGENT,
      "X-Opaque-Id": `tablecraft-${String(this.#sequence)}`,
    };
    if (this.#options.authorization !== null) headers.Authorization = this.#options.authorization;
    if (payload !== null) {
      headers["Content-Type"] = options.ndjson === true ? NDJSON_TYPE : JSON_TYPE;
      headers["Content-Length"] = String(Buffer.byteLength(payload, "utf8"));
    }
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise<Reply>((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new PluginError("cancelled", "The request was cancelled."));
        return;
      }
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        clearTimeout(timer);
        outcome();
      };
      const maxBytes = options.maxBytes ?? REPLY_MAX_BYTES;
      const request = send(url, { method, headers, agent: this.#agent }, (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const tooLarge = (): void => {
          chunks.length = 0;
          request.destroy();
          finish(() => {
            reject(new ReplyTooLargeError(maxBytes));
          });
        };
        if (Number(response.headers["content-length"] ?? 0) > maxBytes) {
          tooLarge();
          return;
        }
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) tooLarge();
          else chunks.push(chunk);
        });
        response.on("error", (error) => {
          finish(() => {
            reject(new PluginError("connectionLost", `The connection broke while reading the reply: ${error.message}`));
          });
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = response.statusCode ?? 0;
          const body = parseBody(text);
          finish(() => {
            if (status >= HTTP_ERROR && options.accept?.includes(status) !== true)
              reject(httpError(status, body, text));
            else resolve({ status, body, text });
          });
        });
      });
      const onAbort = (): void => {
        request.destroy();
        finish(() => {
          reject(new PluginError("cancelled", "The request was cancelled."));
        });
      };
      const timer = setTimeout(() => {
        request.destroy();
        finish(() => {
          reject(
            new PluginError(
              "statementFailed",
              `Elasticsearch did not answer within ${String(Math.round(this.#options.requestTimeoutMs / 1000))} s; raise the request timeout of the data source or narrow the request.`,
            ),
          );
        });
      }, this.#options.requestTimeoutMs);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      request.setTimeout(this.#options.connectTimeoutMs, () => {
        if (request.socket?.connecting === true)
          request.destroy(Object.assign(new Error("connect timed out"), { code: "ETIMEDOUT" }));
      });
      request.on("error", (error) => {
        finish(() => {
          reject(
            isNetworkError(error)
              ? new PluginError(
                  "connectionLost",
                  `Elasticsearch at ${this.#base.host} cannot be reached: ${error.message}`,
                  { cause: error },
                )
              : new PluginError("connectionFailed", error.message, { cause: error }),
          );
        });
      });
      if (payload !== null) request.write(payload);
      request.end();
    });
  }

  /**
   * The URL of `path` under the base, or why it is refused. Built by setting the pathname, never by
   * resolving the path against the base: `//host/x` would leave for another host with the
   * credentials, and `..` would send another endpoint than the one the console classified.
   */
  #urlOf(path: string): URL | string {
    const queryAt = path.indexOf("?");
    const bare = queryAt === -1 ? path : path.slice(0, queryAt);
    if (hasDotSegment(bare)) {
      return `The path ${bare} has a "." or ".." segment; name the index and endpoint directly.`;
    }
    const url = new URL(this.#base.href);
    url.pathname = `${this.#base.pathname.replace(/\/$/, "")}/${bare.replace(/^\/+/, "")}`;
    url.search = queryAt === -1 ? "" : path.slice(queryAt);
    url.hash = "";
    if (url.origin !== this.#base.origin) return `The path ${bare} leaves ${this.#base.host}; it is not sent.`;
    return url;
  }

  /** A JSON body, or a `statementFailed` saying the reply was something else. */
  async json<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const reply = await this.request(method, path, options);
    if (typeof reply.body !== "object" || reply.body === null) {
      if (reply.status === HTTP_NOT_FOUND && options.accept?.includes(HTTP_NOT_FOUND) === true) return null as T;
      throw new PluginError(
        "statementFailed",
        `Expected JSON from ${method} ${path}, got: ${reply.text.slice(0, ERROR_PREVIEW_CHARS) || "an empty reply"}. Is this an Elasticsearch or OpenSearch endpoint?`,
      );
    }
    return reply.body as T;
  }

  close(): void {
    this.#agent.destroy();
  }
}
