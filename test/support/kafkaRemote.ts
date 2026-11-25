import { dotEnv } from "../db/tidbTarget.js";
import { KAFKA_REMOTE_ENV } from "./databases.js";

/**
 * Puts the remote Kafka of the checkout's `.env` into the environment the suites' workers inherit:
 * Bun loads `.env` for `test/db/up.ts`, which then starts no Kafka container, but Vitest runs under
 * Node and would otherwise point the suites at that missing container.
 */
export function setup(): void {
  const value = dotEnv(KAFKA_REMOTE_ENV)[KAFKA_REMOTE_ENV];
  if (value !== undefined && value !== "" && (process.env[KAFKA_REMOTE_ENV] ?? "") === "") {
    process.env[KAFKA_REMOTE_ENV] = value;
  }
}
