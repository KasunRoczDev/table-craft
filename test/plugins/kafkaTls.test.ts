import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectionSchema, MAX_REQUEST_TIMEOUT_SECONDS } from "@table-craft/plugin-kafka/config";
import { clientOptions } from "@table-craft/plugin-kafka/connect";

const TLS_DIR = join(import.meta.dirname, "../db/tls");
const CA = join(TLS_DIR, "ca.crt");
const CERT = join(TLS_DIR, "client.crt");
const KEY = join(TLS_DIR, "client.key");
const BOOTSTRAP = "broker:9093";

function optionsOf(config: Record<string, unknown>): ReturnType<typeof clientOptions> {
  return clientOptions(connectionSchema.parse({ bootstrapServers: BOOTSTRAP, ...config }), { readOnly: true });
}

describe("kafka client options", () => {
  it("givenPlaintext_whenOptions_thenNoTlsAndNoSasl", async () => {
    const options = await optionsOf({ security: "PLAINTEXT" });
    expect(options.tls).toBeUndefined();
    expect(options.sasl).toBeUndefined();
  });

  it("givenSslDefault_whenOptions_thenVerifiesCertificateAndHostname", async () => {
    const options = await optionsOf({ security: "SSL", tlsCa: CA });
    expect(options.tls?.rejectUnauthorized).toBe(true);
    expect(options.tls?.checkServerIdentity).toBeUndefined();
    expect(String(options.tls?.ca)).toContain("BEGIN CERTIFICATE");
  });

  it("givenVerifyCa_whenOptions_thenVerifiesCertificateButNotHostname", async () => {
    const options = await optionsOf({ security: "SSL", tlsMode: "verify-ca", tlsCa: CA });
    expect(options.tls?.rejectUnauthorized).toBe(true);
    expect(options.tls?.checkServerIdentity?.("other", {} as never)).toBeUndefined();
  });

  it("givenRequire_whenOptions_thenEncryptsWithoutVerifying", async () => {
    const options = await optionsOf({ security: "SSL", tlsMode: "require" });
    expect(options.tls?.rejectUnauthorized).toBe(false);
  });

  it("givenClientCertificate_whenOptions_thenMutualTls", async () => {
    const options = await optionsOf({ security: "SSL", tlsCa: CA, tlsCert: CERT, tlsKey: KEY });
    expect(String(options.tls?.cert as Buffer)).toContain("BEGIN CERTIFICATE");
    expect(String(options.tls?.key as Buffer)).toContain("PRIVATE KEY");
    expect(options.tls?.rejectUnauthorized).toBe(true);
  });

  it("givenCertificateWithoutKey_whenOptions_thenRefusedNamingBoth", async () => {
    await expect(optionsOf({ security: "SSL", tlsCert: CERT })).rejects.toThrow(/Client certificate and Client key/);
  });

  it("givenMissingCaFile_whenOptions_thenRefusedNamingTheField", async () => {
    await expect(optionsOf({ security: "SSL", tlsCa: join(TLS_DIR, "absent.crt") })).rejects.toThrow(/CA certificate/);
  });

  it.each(["SCRAM-SHA-256", "SCRAM-SHA-512", "PLAIN"])(
    "givenSaslSsl%s_whenOptions_thenSaslAndVerifyingTls",
    async (mechanism) => {
      const options = await optionsOf({ security: "SASL_SSL", saslMechanism: mechanism, user: "u", password: "p" });
      expect(options.sasl).toEqual({ mechanism, username: "u", password: "p" });
      expect(options.tls?.rejectUnauthorized).toBe(true);
    },
  );

  it("givenSaslPlaintext_whenOptions_thenSaslWithoutTls", async () => {
    const options = await optionsOf({ security: "SASL_PLAINTEXT", user: "u", password: "p" });
    expect(options.sasl?.mechanism).toBe("SCRAM-SHA-512");
    expect(options.tls).toBeUndefined();
  });

  it("givenRequestTimeoutAboveMax_whenParsed_thenRefused", () => {
    expect(connectionSchema.safeParse({ requestTimeout: MAX_REQUEST_TIMEOUT_SECONDS + 1 }).success).toBe(false);
    expect(connectionSchema.safeParse({ requestTimeout: MAX_REQUEST_TIMEOUT_SECONDS }).success).toBe(true);
  });

  it("givenRegistryUrlWithPassword_whenParsed_thenRefusedAskingForBasicAuth", () => {
    const parsed = connectionSchema.safeParse({ registryUrl: "https://user:secret@registry:8081" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message).join(" ")).toMatch(/basic authentication/);
    expect(connectionSchema.safeParse({ registryUrl: "https://registry:8081" }).success).toBe(true);
  });
});
