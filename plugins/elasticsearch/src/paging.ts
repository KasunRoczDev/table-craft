import {
  isForbidden,
  isReplyTooLarge,
  requestJson,
  statusOf,
  type CursorIds,
  type ElasticTransport,
} from "./client.js";
import { CURSOR_KEEP_ALIVE, type Dialect, type PointInTime } from "./dialect.js";
import type { Hit } from "./hits.js";

/** How much smaller a page gets each time its reply is too large to read. */
export const PAGE_SHRINK = 10;
const HTTP_NOT_FOUND = 404;
/** A point in time the server cannot open or sort as asked: the pages go on by scroll instead. */
const POINT_IN_TIME_UNSUPPORTED = new Set([400, 404, 405, 501]);
/** The sort value of a hit missing a numeric field, as `_last` and `_first` write it: past what a double keeps exact. */
const LONG_MAX = "9223372036854775807";
const LONG_MIN = "-9223372036854775808";

interface PageReply {
  readonly _scroll_id?: unknown;
  readonly pit_id?: unknown;
  readonly id?: unknown;
  readonly hits?: { readonly hits?: readonly Hit[] };
}

/**
 * Runs one request of the service with a signal the session's cancel aborts; the default runs it
 * with a signal nothing aborts.
 */
export type TrackRequest = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/** One sort clause as the search body writes it: `{ field: { order } }`. */
export type SortClause = Readonly<Record<string, unknown>>;

/** Where page one stopped, and what page two goes on with. */
export interface Continuation {
  /** The target as it goes in a path, already encoded. */
  readonly target: string;
  readonly query: unknown;
  readonly sort: readonly SortClause[];
  readonly size: number;
  readonly timeout: string;
  /** The sort values of page one's last hit; null when page one was not sorted. */
  readonly after: readonly unknown[] | null;
  /** Every hit page one showed, by `hitKey`. */
  readonly seen: ReadonlySet<string>;
}

export function hitKey(hit: Hit): string {
  return `${String(hit._index)}\u0000${String(hit._id)}`;
}

function orderOf(clause: SortClause): "asc" | "desc" {
  const value = Object.values(clause)[0];
  if (value === "desc") return "desc";
  return typeof value === "object" && value !== null && (value as { order?: unknown }).order === "desc"
    ? "desc"
    : "asc";
}

function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index]?.codePointAt(0) ?? 0) - (right[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function compareValue(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return compareCodePoints(a, b);
  return compareCodePoints(String(a), String(b));
}

/**
 * How hit sort values `a` stand to `b` under `sort`, as the server orders them: below zero sorts
 * first. A missing value (null) sorts last either way, as `missing: _last` does; keywords compare
 * by code point, as their UTF-8 bytes do.
 */
export function compareSortValues(a: readonly unknown[], b: readonly unknown[], sort: readonly SortClause[]): number {
  for (let index = 0; index < sort.length; index += 1) {
    const left = a[index] ?? null;
    const right = b[index] ?? null;
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1;
      continue;
    }
    const difference = compareValue(left, right);
    if (difference !== 0) return Math.sign(difference) * (orderOf(sort[index] ?? {}) === "desc" ? -1 : 1);
  }
  return 0;
}

/**
 * A sort value as `search_after` takes it back. A missing numeric field sorts at the long limits,
 * which JSON parsing rounds past them, and the server refuses the rounded number.
 */
export function afterValue(value: unknown): unknown {
  if (typeof value !== "number" || Number.isSafeInteger(value) || !Number.isInteger(value)) return value;
  if (value >= Number(LONG_MAX)) return LONG_MAX;
  if (value <= Number(LONG_MIN)) return LONG_MIN;
  return value;
}

function sortValuesOf(hit: Hit | undefined): readonly unknown[] | null {
  return Array.isArray(hit?.sort) ? (hit.sort as unknown[]) : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The point in time and scroll ids a session holds, and their release: through the transport when
 * it can, else by the server's own `DELETE`. A release the server refuses is said once, as a
 * warning; the keep-alive ends the cursor anyway.
 */
export class Cursors {
  readonly #transport: ElasticTransport;
  readonly #pointInTime: PointInTime | null;
  readonly #scrolls = new Set<string>();
  readonly #pits = new Set<string>();
  #warning: string | null = null;
  #warned = false;

  constructor(transport: ElasticTransport, dialect: Dialect) {
    this.#transport = transport;
    this.#pointInTime = dialect.pointInTime;
  }

  holdScroll(id: string, replaces: string | null = null): void {
    if (replaces !== null) this.#scrolls.delete(replaces);
    this.#scrolls.add(id);
  }

  holdPit(id: string, replaces: string | null = null): void {
    if (replaces !== null) this.#pits.delete(replaces);
    this.#pits.add(id);
  }

  /** Cursors still held, for a test that checks every one was released. */
  get open(): number {
    return this.#scrolls.size + this.#pits.size;
  }

  /** The refused release, once per session, for the next search to say. */
  takeWarning(): string | null {
    const warning = this.#warning;
    this.#warning = null;
    return warning;
  }

  async release(cursors: CursorIds): Promise<void> {
    const scrollIds = (cursors.scrollIds ?? []).filter((id) => this.#scrolls.delete(id));
    const pitIds = (cursors.pitIds ?? []).filter((id) => this.#pits.delete(id));
    await this.#send(scrollIds, pitIds);
  }

  async releaseAll(): Promise<void> {
    const scrollIds = [...this.#scrolls];
    const pitIds = [...this.#pits];
    this.#scrolls.clear();
    this.#pits.clear();
    await this.#send(scrollIds, pitIds);
  }

  async #send(scrollIds: readonly string[], pitIds: readonly string[]): Promise<void> {
    if (scrollIds.length === 0 && pitIds.length === 0) return;
    const sent: Promise<unknown>[] = [];
    if (this.#transport.releaseCursors !== undefined) {
      sent.push(
        this.#transport.releaseCursors({
          ...(scrollIds.length === 0 ? {} : { scrollIds }),
          ...(pitIds.length === 0 ? {} : { pitIds }),
        }),
      );
    } else {
      if (scrollIds.length > 0) sent.push(this.#delete("/_search/scroll", { scroll_id: scrollIds }));
      const pit = this.#pointInTime;
      if (pit !== null && pitIds.length > 0) {
        if (pit.closesMany) sent.push(this.#delete(pit.close, { pit_id: pitIds }));
        else sent.push(...pitIds.map((id) => this.#delete(pit.close, { id })));
      }
    }
    await Promise.all(sent.map((request) => request.catch((error: unknown) => this.#refused(error))));
  }

  #delete(path: string, body: unknown): Promise<unknown> {
    return this.#transport.request("DELETE", path, { body, accept: [HTTP_NOT_FOUND] });
  }

  #refused(error: unknown): void {
    if (!isForbidden(error) || this.#warned) return;
    this.#warned = true;
    const reason = error instanceof Error ? error.message : String(error);
    this.#warning = `The cluster refused to free a search cursor, so it lasts until its ${CURSOR_KEEP_ALIVE} keep-alive ends: ${reason}`;
  }
}

/** Sends a page of `size` hits, a tenth as large each time the reply is too large to read. */
export async function shrinking<T>(
  track: TrackRequest,
  send: (size: number, signal: AbortSignal) => Promise<T>,
  size: number,
): Promise<{ reply: T; size: number }> {
  let current = size;
  for (;;) {
    try {
      const at = current;
      return { reply: await track((signal) => send(at, signal)), size: current };
    } catch (error) {
      if (!isReplyTooLarge(error) || current === 1) throw error;
      current = Math.max(1, Math.floor(current / PAGE_SHRINK));
    }
  }
}

/**
 * The pages after page one, each without the hits page one showed. A server with point in time
 * reads them from one, by `search_after` from page one's last sort values plus the tiebreakers;
 * an older one, or one that refuses the point in time, re-reads the search by scroll and drops
 * what sorts before that hit. Either way the cursor is released when the pages run out or the
 * reader stops.
 */
export async function* laterPages(
  transport: ElasticTransport,
  dialect: Dialect,
  cursors: Cursors,
  track: TrackRequest,
  from: Continuation,
): AsyncGenerator<readonly Hit[]> {
  const pit = dialect.pointInTime;
  if (pit !== null) {
    const pages = pointInTimePages(transport, pit, cursors, track, from);
    let first = true;
    try {
      for await (const page of pages) {
        first = false;
        yield page;
      }
      return;
    } catch (error) {
      const status = statusOf(error);
      if (!first || status === null || !POINT_IN_TIME_UNSUPPORTED.has(status)) throw error;
    }
  }
  yield* scrollPages(transport, cursors, track, from);
}

async function* pointInTimePages(
  transport: ElasticTransport,
  pit: PointInTime,
  cursors: Cursors,
  track: TrackRequest,
  from: Continuation,
): AsyncGenerator<readonly Hit[]> {
  const opened = await track((signal) =>
    requestJson<PageReply>(transport, "POST", `/${from.target}/${pit.open}?keep_alive=${CURSOR_KEEP_ALIVE}`, {
      signal,
    }),
  );
  let id = textOf(opened.id) ?? textOf(opened.pit_id);
  if (id === null) throw new Error("The server opened a point in time without an id.");
  cursors.holdPit(id);
  const sort = [...from.sort, ...pit.tiebreakers.map((tiebreaker) => ({ [tiebreaker.field]: { order: "asc" } }))];
  let after: readonly unknown[] | null =
    from.after === null
      ? null
      : [...from.after.map(afterValue), ...pit.tiebreakers.map((tiebreaker) => tiebreaker.first)];
  let size = from.size;
  try {
    for (;;) {
      const pitId = id;
      const sent = after;
      const read = await shrinking(
        track,
        (at, signal) =>
          requestJson<PageReply>(transport, "POST", "/_search", {
            body: {
              size: at,
              query: from.query,
              timeout: from.timeout,
              track_total_hits: false,
              sort,
              pit: { id: pitId, keep_alive: CURSOR_KEEP_ALIVE },
              ...(sent === null ? {} : { search_after: sent }),
            },
            signal,
          }),
        size,
      );
      size = read.size;
      const next = textOf(read.reply.pit_id);
      if (next !== null && next !== id) {
        cursors.holdPit(next, id);
        id = next;
      }
      const hits = read.reply.hits?.hits ?? [];
      if (hits.length === 0) return;
      after = sortValuesOf(hits[hits.length - 1])?.map(afterValue) ?? null;
      yield hits.filter((hit) => !from.seen.has(hitKey(hit)));
      if (hits.length < size || after === null) return;
    }
  } finally {
    await cursors.release({ pitIds: [id] });
  }
}

async function* scrollPages(
  transport: ElasticTransport,
  cursors: Cursors,
  track: TrackRequest,
  from: Continuation,
): AsyncGenerator<readonly Hit[]> {
  const read = await shrinking(
    track,
    (size, signal) =>
      requestJson<PageReply>(transport, "POST", `/${from.target}/_search?scroll=${CURSOR_KEEP_ALIVE}`, {
        body: {
          size,
          query: from.query,
          timeout: from.timeout,
          ...(from.sort.length === 0 ? {} : { sort: from.sort }),
        },
        signal,
      }),
    from.size,
  );
  let id = textOf(read.reply._scroll_id);
  if (id !== null) cursors.holdScroll(id);
  let passed = from.after === null;
  let page = read.reply.hits?.hits ?? [];
  try {
    while (page.length > 0) {
      const kept: Hit[] = [];
      for (const hit of page) {
        if (from.seen.has(hitKey(hit))) continue;
        if (!passed && from.after !== null) {
          const order = compareSortValues(sortValuesOf(hit) ?? [], from.after, from.sort);
          if (order < 0) continue;
          if (order > 0) passed = true;
        }
        kept.push(hit);
      }
      yield kept;
      if (id === null) return;
      const scrollId = id;
      const reply = await track((signal) =>
        requestJson<PageReply>(transport, "POST", "/_search/scroll", {
          body: { scroll: CURSOR_KEEP_ALIVE, scroll_id: scrollId },
          signal,
        }),
      );
      const next = textOf(reply._scroll_id);
      if (next !== null && next !== id) {
        cursors.holdScroll(next, id);
        id = next;
      }
      page = reply.hits?.hits ?? [];
    }
  } finally {
    if (id !== null) await cursors.release({ scrollIds: [id] });
  }
}
