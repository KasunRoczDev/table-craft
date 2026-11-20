import { z } from "@table-craft/plugin-api";

export const SECURITY_PROTOCOLS = ["PLAINTEXT", "SSL", "SASL_PLAINTEXT", "SASL_SSL"] as const;
export const SASL_MECHANISMS = ["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"] as const;
export const TLS_MODES = ["verify-full", "verify-ca", "require"] as const;
export const REGISTRY_AUTH_MODES = ["none", "basic"] as const;

export type SecurityProtocol = (typeof SECURITY_PROTOCOLS)[number];
export type TlsMode = (typeof TLS_MODES)[number];

const DEFAULT_BOOTSTRAP = "localhost:9092";
const DEFAULT_CLIENT_ID = "TableCraft";
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
const DEFAULT_MAX_SCAN = 100_000;
const DEFAULT_LAG_WARNING = 10_000;
const MAX_PORT = 65_535;
const ENTRY_SEPARATOR = /[,\s]+/;
const HOST_PORT = /^(?:\[([^\]]+)\]|([^:\s[\]]+)):(\d+)$/;

export interface BootstrapBroker {
  readonly host: string;
  readonly port: number;
}

/** A bootstrap list problem, worded for the form: it names the entry. */
export class BootstrapError extends Error {
  override readonly name = "BootstrapError";
}

/** `host:port` entries separated by commas or blanks, IPv6 in brackets; each needs its port. */
export function parseBootstrap(text: string): BootstrapBroker[] {
  const entries = text
    .split(ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0) throw new BootstrapError("Enter at least one bootstrap server as host:port.");
  return entries.map((entry) => {
    const match = HOST_PORT.exec(entry);
    const host = match?.[1] ?? match?.[2];
    if (match === null || host === undefined) {
      throw new BootstrapError(
        `Bootstrap server "${entry}" has no port; write it as host:port, such as ${entry}:9092.`,
      );
    }
    const port = Number(match[3]);
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
      throw new BootstrapError(
        `Bootstrap server "${entry}" has port ${match[3] ?? ""}, outside 1-${String(MAX_PORT)}.`,
      );
    }
    return { host, port };
  });
}

export const connectionSchema = z
  .strictObject({
    bootstrapServers: z
      .string()
      .default(DEFAULT_BOOTSTRAP)
      .superRefine((value, context) => {
        try {
          parseBootstrap(value);
        } catch (error) {
          context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
        }
      }),
    security: z.enum(SECURITY_PROTOCOLS).default("PLAINTEXT"),
    saslMechanism: z.enum(SASL_MECHANISMS).default("SCRAM-SHA-512"),
    user: z.string().default(""),
    password: z.string().default(""),
    tlsMode: z.enum(TLS_MODES).default("verify-full"),
    tlsCa: z.string().default(""),
    tlsCert: z.string().default(""),
    tlsKey: z.string().default(""),
    tlsKeyPassphrase: z.string().default(""),
    registryUrl: z.string().default(""),
    registryAuth: z.enum(REGISTRY_AUTH_MODES).default("none"),
    registryUser: z.string().default(""),
    registryPassword: z.string().default(""),
    clientId: z.string().min(1).default(DEFAULT_CLIENT_ID),
    requestTimeout: z.number().positive().default(DEFAULT_REQUEST_TIMEOUT_SECONDS),
    maxScan: z.number().int().positive().default(DEFAULT_MAX_SCAN),
    lagWarning: z.number().int().nonnegative().default(DEFAULT_LAG_WARNING),
  })
  .superRefine((value, context) => {
    if (usesSasl(value.security) && value.user.trim() === "") {
      context.addIssue({ code: "custom", path: ["user"], message: "Enter the SASL username." });
    }
    if (value.registryUrl.trim() !== "" && !/^https?:\/\//i.test(value.registryUrl.trim())) {
      context.addIssue({
        code: "custom",
        path: ["registryUrl"],
        message: "Write the Schema Registry URL with http:// or https://, such as http://localhost:8081.",
      });
    }
    if (value.registryAuth === "basic" && value.registryUser.trim() === "") {
      context.addIssue({ code: "custom", path: ["registryUser"], message: "Enter the Schema Registry username." });
    }
  });

export type KafkaConfig = z.infer<typeof connectionSchema>;

export function usesSasl(security: SecurityProtocol): boolean {
  return security === "SASL_PLAINTEXT" || security === "SASL_SSL";
}

export function usesTls(security: SecurityProtocol): boolean {
  return security === "SSL" || security === "SASL_SSL";
}
