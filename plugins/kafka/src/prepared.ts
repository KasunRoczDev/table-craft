import { randomUUID } from "node:crypto";
import { refused } from "./failures.js";

/** Previews kept at most per session; the oldest goes first. */
const MAX_PREPARED = 64;

/**
 * Previews waiting for their apply (decision 137's prepare and apply): a token applies exactly
 * what was shown, once, and dies with the session.
 */
export class PreparedStore {
  readonly #entries = new Map<string, { readonly kind: string; readonly value: unknown }>();

  put(kind: string, value: unknown): string {
    const token = randomUUID();
    this.#entries.set(token, { kind, value });
    if (this.#entries.size > MAX_PREPARED) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) this.#entries.delete(oldest);
    }
    return token;
  }

  take<T>(kind: string, token: string): T {
    const entry = this.#entries.get(token);
    if (entry?.kind !== kind) {
      throw refused(
        "This preview is no longer valid: it was applied, replaced or its session ended. Prepare it again.",
      );
    }
    this.#entries.delete(token);
    return entry.value as T;
  }

  clear(): void {
    this.#entries.clear();
  }
}
