import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createSecureContext, type ConnectionOptions as TlsOptions } from "node:tls";
import {
  homeExpanded,
  type PluginError,
  TlsSettingsError,
  tlsFailureMessage,
  tlsFileMessage,
  tlsKeyIsEncrypted,
  tlsKeyMessage,
} from "@table-craft/plugin-api";
import type { TlsMode } from "./config.js";

/** The manifest's labels, so a message names the field the user filled in. */
const LABELS = {
  tlsCa: "CA certificate",
  tlsCert: "Client certificate",
  tlsKey: "Client key",
} as const;

export interface TlsConfig {
  readonly tlsMode: TlsMode;
  readonly tlsCa: string;
  readonly tlsCert: string;
  readonly tlsKey: string;
  readonly tlsKeyPassphrase: string;
}

type FileKey = keyof typeof LABELS;

async function readTlsFile(config: TlsConfig, key: FileKey): Promise<string | undefined> {
  const path = config[key];
  if (path === "") return undefined;
  try {
    return await readFile(homeExpanded(path, homedir()), "utf8");
  } catch (cause) {
    throw new TlsSettingsError(tlsFileMessage(LABELS[key], path, cause), { cause });
  }
}

/** Parses each file before the driver sees it, so a bad one is named instead of failing the handshake. */
function checked<T>(config: TlsConfig, key: FileKey, use: () => T, encrypted = false): T {
  try {
    return use();
  } catch (cause) {
    throw new TlsSettingsError(tlsKeyMessage(LABELS[key], config[key], cause, encrypted), { cause });
  }
}

/** Node TLS options from the form's files, read now so a rotated certificate is picked up. */
export async function tlsOptions(config: TlsConfig): Promise<TlsOptions> {
  const [ca, cert, key] = await Promise.all([
    readTlsFile(config, "tlsCa"),
    readTlsFile(config, "tlsCert"),
    readTlsFile(config, "tlsKey"),
  ]);
  if ((cert === undefined) !== (key === undefined)) {
    throw new TlsSettingsError(`${LABELS.tlsCert} and ${LABELS.tlsKey} go together: fill in both, or neither.`);
  }
  const passphrase = config.tlsKeyPassphrase === "" ? undefined : config.tlsKeyPassphrase;
  if (cert !== undefined) checked(config, "tlsCert", () => new X509Certificate(cert));
  if (key !== undefined) {
    checked(config, "tlsKey", () => createPrivateKey({ key, passphrase }), tlsKeyIsEncrypted(key));
  }
  const files: TlsOptions = {
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(passphrase === undefined ? {} : { passphrase }),
  };
  checked(config, cert === undefined ? "tlsKey" : "tlsCert", () => createSecureContext(files));
  switch (config.tlsMode) {
    case "require":
      return { ...files, rejectUnauthorized: false, checkServerIdentity: () => undefined };
    case "verify-ca":
      return { ...files, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case "verify-full":
      return { ...files, rejectUnauthorized: true };
  }
}

/** A `TlsSettingsError` saying what a verifying handshake did not match, or null when `cause` is not one. */
export function tlsFailure(config: TlsConfig, host: string, cause: unknown): PluginError | null {
  if (config.tlsMode === "require") return null;
  const message = tlsFailureMessage(cause, {
    caLabel: LABELS.tlsCa,
    caPath: config.tlsCa === "" ? null : config.tlsCa,
    host,
  });
  return message === null ? null : new TlsSettingsError(message, { cause });
}
