import type { PluginError } from "@table-craft/plugin-api";
import { refused } from "./failures.js";

/** The refusal of a write on a read-only datasource (decision 011), said before anything is sent. */
export function readOnlyRefusal(what: string): PluginError {
  return refused(`The datasource is read-only, so ${what} is refused. Turn off Read-only on the datasource to run it.`);
}

/** Kafka writes its internal topics itself; a client write there corrupts consumer groups or transactions. */
export function guardInternal(topic: string, what: string): void {
  if (topic.startsWith("__")) {
    throw refused(`${topic} is a topic Kafka manages itself, so ${what} is refused.`);
  }
}

/** Throws the refusal when the session is read-only; every write calls it first. */
export function guardWrite(readOnly: boolean, what: string): void {
  if (readOnly) throw readOnlyRefusal(what);
}
