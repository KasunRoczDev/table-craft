import { dotEnv } from "../db/tidbTarget.js";
import { ELASTICSEARCH_REMOTE_ENV } from "./databases.js";

/**
 * Puts the remote cluster of the checkout's `.env` into the environment the suites' workers
 * inherit: Vitest runs under Node, which does not load `.env` by itself.
 */
export function setup(): void {
  const value = dotEnv(ELASTICSEARCH_REMOTE_ENV)[ELASTICSEARCH_REMOTE_ENV];
  if (value !== undefined && value !== "" && (process.env[ELASTICSEARCH_REMOTE_ENV] ?? "") === "") {
    process.env[ELASTICSEARCH_REMOTE_ENV] = value;
  }
}
