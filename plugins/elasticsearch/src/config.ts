import { z } from "@table-craft/plugin-api";

export const TLS_MODES = ["disable", "require", "verify-ca", "verify-full"] as const;
export const AUTH_MODES = ["none", "basic", "apiKey", "bearer"] as const;

export type TlsMode = (typeof TLS_MODES)[number];
export type AuthMode = (typeof AUTH_MODES)[number];

const DEFAULT_HOST = "localhost";
const DEFAULT_PORT = 9200;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;
/** Ten minutes: past it a hung node would hold a search open for good. */
export const MAX_REQUEST_TIMEOUT_SECONDS = 600;
const MAX_PORT = 65_535;
const PATH_PREFIX = /^(?:\/[^/?#\s]+)*\/?$/;

export const connectionSchema = z
  .strictObject({
    host: z.string().trim().min(1).default(DEFAULT_HOST),
    port: z.number().int().min(1).max(MAX_PORT).default(DEFAULT_PORT),
    pathPrefix: z.string().trim().default(""),
    authMode: z.enum(AUTH_MODES).default("none"),
    user: z.string().default(""),
    password: z.string().default(""),
    apiKey: z.string().default(""),
    token: z.string().default(""),
    tlsMode: z.enum(TLS_MODES).default("disable"),
    tlsCa: z.string().default(""),
    tlsCert: z.string().default(""),
    tlsKey: z.string().default(""),
    tlsKeyPassphrase: z.string().default(""),
    indexFilter: z.string().default(""),
    requestTimeout: z.number().positive().max(MAX_REQUEST_TIMEOUT_SECONDS).default(DEFAULT_REQUEST_TIMEOUT_SECONDS),
    connectTimeout: z.number().positive().max(MAX_REQUEST_TIMEOUT_SECONDS).default(DEFAULT_CONNECT_TIMEOUT_SECONDS),
  })
  .superRefine((value, context) => {
    if (!PATH_PREFIX.test(value.pathPrefix)) {
      context.addIssue({
        code: "custom",
        path: ["pathPrefix"],
        message: "Write the path prefix as /path, such as /elasticsearch, or leave it blank.",
      });
    }
    if (value.authMode === "basic" && value.user.trim() === "") {
      context.addIssue({ code: "custom", path: ["user"], message: "Enter the username." });
    }
    if (value.authMode === "apiKey" && value.apiKey.trim() === "") {
      context.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "Enter the API key, as Elasticsearch encodes it.",
      });
    }
    if (value.authMode === "bearer" && value.token.trim() === "") {
      context.addIssue({ code: "custom", path: ["token"], message: "Enter the bearer token." });
    }
  });

export type ElasticConfig = z.infer<typeof connectionSchema>;

/** `http://host:port/prefix` without a trailing slash, the base every request path joins. */
export function baseUrl(config: Pick<ElasticConfig, "host" | "port" | "pathPrefix" | "tlsMode">): string {
  const scheme = config.tlsMode === "disable" ? "http" : "https";
  const host = config.host.includes(":") && !config.host.startsWith("[") ? `[${config.host}]` : config.host;
  const prefix = config.pathPrefix.replace(/\/+$/, "");
  return `${scheme}://${host}:${String(config.port)}${prefix}`;
}

/** The `Authorization` header the configured authentication sends; null for none. */
export function authorization(config: ElasticConfig): string | null {
  switch (config.authMode) {
    case "none":
      return null;
    case "basic":
      return `Basic ${Buffer.from(`${config.user}:${config.password}`, "utf8").toString("base64")}`;
    case "apiKey":
      return `ApiKey ${config.apiKey.trim()}`;
    case "bearer":
      return `Bearer ${config.token.trim()}`;
  }
}
