import { create } from "zustand";
import {
  TOPIC_TAIL_MAX_MESSAGES,
  TOPIC_TAIL_MAX_RING_BYTES,
  type TailMessage,
  type TopicTailRequest,
  type TopicTailSummary,
  type TopicTailWindow,
} from "@table-craft/desktop/engine/protocol.js";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { currentSpill } from "@table-craft/desktop/renderer/state/settings.js";

/** One poll asks for at most this many messages and bytes. */
export const TAIL_WINDOW_COUNT = 500;
export const TAIL_WINDOW_BYTES = 1_048_576;
/** The pane keeps the newest this many rows; the engine's ring holds more (`TOPIC_TAIL_MAX_MESSAGES`). */
export const TAIL_DISPLAY_ROWS = 10_000;
/** And at most this much message data, so a topic of large messages cannot fill the window's memory. */
export const TAIL_DISPLAY_BYTES = 33_554_432;

/** A received message, or the gap row that stands where the ring dropped some before they were read. */
export type TailRow =
  | { readonly kind: "message"; readonly sequence: string; readonly message: TailMessage }
  | { readonly kind: "gap"; readonly sequence: string; readonly dropped: string };

export interface TailEntry {
  readonly datasourceId: string;
  readonly summary: TopicTailSummary;
  /** What the pane shows; frozen while paused. */
  readonly rows: readonly TailRow[];
  /** Everything received, newest last. */
  readonly retained: readonly TailRow[];
  /** The `after` of the next window. */
  readonly through: string | null;
  readonly paused: boolean;
  /** Messages received while paused. */
  readonly pending: number;
  readonly error: string | null;
}

/**
 * `rows` with a window's rows after them: first a gap row when the ring dropped messages before
 * they were read (plan 164 decision 14), then each message not already held, the newest `limit` kept.
 */
export function appendTailWindow(
  rows: readonly TailRow[],
  window: Pick<TopicTailWindow, "rows" | "skipped" | "through">,
  limit: number,
  maxBytes: number = TAIL_DISPLAY_BYTES,
): readonly TailRow[] {
  const seen = new Set(rows.filter((row) => row.kind === "message").map((row) => row.sequence));
  const added: TailRow[] = [];
  if (/^\d+$/.test(window.skipped) && BigInt(window.skipped) > 0n) {
    const before = window.rows[0]?.sequence ?? window.through ?? "";
    added.push({ kind: "gap", sequence: `gap-${before}`, dropped: window.skipped });
  }
  for (const row of window.rows) {
    if (seen.has(row.sequence)) continue;
    seen.add(row.sequence);
    added.push({ kind: "message", sequence: row.sequence, message: row.message });
  }
  return added.length === 0 ? rows : newest([...rows, ...added], limit, maxBytes);
}

/** The newest rows within `limit` rows and `maxBytes` of message size; the newest row is always kept. */
function newest(rows: readonly TailRow[], limit: number, maxBytes: number): readonly TailRow[] {
  let bytes = 0;
  let start = rows.length;
  while (start > 0 && rows.length - start < limit) {
    const row = rows[start - 1];
    const size = row?.kind === "message" ? row.message.size : 0;
    if (start < rows.length && bytes + size > maxBytes) break;
    bytes += size;
    start -= 1;
  }
  return start === 0 ? rows : rows.slice(start);
}

/** The messages a tail's rows hold, gaps left out. */
export function tailMessages(rows: readonly TailRow[]): number {
  return rows.filter((row) => row.kind === "message").length;
}

/** The pane's filter as a test: `/regex/` as the read bar takes it, else case-blind text; null when the regex is bad. */
export function tailMatcher(filter: string): ((text: string) => boolean) | null {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(filter);
  if (regex === null) {
    const needle = filter.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }
  try {
    const pattern = new RegExp(regex[1] ?? "", regex[2]);
    return (text) => pattern.test(text);
  } catch {
    return null;
  }
}

/** Whether a row matches the pane's filter in its key, value or headers; gaps always show. */
export function tailRowMatches(row: TailRow, filter: string): boolean {
  if (filter === "" || row.kind === "gap") return true;
  const matches = tailMatcher(filter);
  if (matches === null) return true;
  const { key, value, headers } = row.message;
  return (
    matches(key ?? "") ||
    matches(value ?? "") ||
    headers.some((header) => matches(`${header.name}=${header.value ?? ""}`))
  );
}

/** The pane draws at most this many of the newest rows; the store keeps `TAIL_DISPLAY_ROWS` (audit M11). */
export const TAIL_DRAWN_ROWS = 1_000;

/** The rows the pane draws: those matching `filter`, the newest `TAIL_DRAWN_ROWS`, and how many older ones match but are not drawn. */
export function drawnTailRows(
  rows: readonly TailRow[],
  filter: string,
): { readonly rows: readonly TailRow[]; readonly hidden: number } {
  const matching = filter === "" ? rows : rows.filter((row) => tailRowMatches(row, filter));
  const hidden = Math.max(0, matching.length - TAIL_DRAWN_ROWS);
  return { rows: hidden === 0 ? matching : matching.slice(hidden), hidden };
}

/** A message timestamp as the grid shows dates: `YYYY-MM-DD HH:mm:ss.SSS`, UTC. */
export function tailTimestamp(timestamp: string | null): string {
  if (timestamp === null) return "";
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? timestamp : new Date(time).toISOString().replace("T", " ").replace("Z", "");
}

function messagesText(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "message" : "messages"}`;
}

/** The pane's status line: state or paused with what arrived since, messages held, messages dropped. */
export function tailStatus(entry: Pick<TailEntry, "paused" | "pending" | "retained" | "summary">): string {
  const parts = [
    entry.paused && entry.summary.state !== "stopped"
      ? `Paused · ${entry.pending.toLocaleString("en-US")} new (tail still running)`
      : entry.summary.state === "live"
        ? "Live"
        : entry.summary.state === "reconnecting"
          ? "Reconnecting"
          : "Stopped",
    messagesText(tailMessages(entry.retained)),
  ];
  if (/^\d+$/.test(entry.summary.dropped) && BigInt(entry.summary.dropped) > 0n)
    parts.push(`${BigInt(entry.summary.dropped).toLocaleString("en-US")} dropped`);
  return parts.join(" · ");
}

/** The held messages as JSON Lines, one record a line, gaps as `{"dropped": N}`. */
export function tailJsonLines(rows: readonly TailRow[]): string {
  return rows.map((row) => JSON.stringify(row.kind === "gap" ? { dropped: row.dropped } : row.message)).join("\n");
}

interface TailState {
  readonly entries: Readonly<Record<string, TailEntry>>;
  readonly activeId: string | null;
  readonly start: (datasourceId: string, request: TopicTailRequest) => Promise<void>;
  readonly poll: (id: string) => Promise<void>;
  readonly select: (id: string) => void;
  readonly pause: (id: string) => void;
  readonly clear: (id: string) => Promise<void>;
  readonly stop: (id: string, close?: boolean) => Promise<void>;
  readonly detach: (datasourceId: string) => void;
  /** The whole message behind a row's preview (decision 172); null once the tail no longer keeps it. */
  readonly message: (id: string, sequence: string) => Promise<TailMessage | null>;
}

/** `spill` is `data.spillMessages`, read at each start. */
export function createTailStore(connect: (id: string) => Promise<EngineClient>, spill: () => boolean = () => true) {
  const busy = new Set<string>();
  const generations = new Map<string, number>();
  /** Bumped by a clear, so a window read before it is dropped. */
  const epochs = new Map<string, number>();
  const detached = new Set<string>();
  return create<TailState>()((set, get) => {
    const patch = (id: string, change: Partial<TailEntry>) => {
      const entry = get().entries[id];
      if (entry !== undefined) set({ entries: { ...get().entries, [id]: { ...entry, ...change } } });
    };
    return {
      entries: {},
      activeId: null,

      async start(datasourceId, request) {
        const generation = generations.get(datasourceId) ?? 0;
        const client = await connect(datasourceId);
        const summary = await client.call("topics.tailStart", {
          ...request,
          maxMessages: TOPIC_TAIL_MAX_MESSAGES,
          maxBytes: TOPIC_TAIL_MAX_RING_BYTES,
          spill: spill(),
        });
        if ((generations.get(datasourceId) ?? 0) !== generation) {
          await client.call("topics.tailStop", { tailId: summary.tailId });
          return;
        }
        const entry: TailEntry = {
          datasourceId,
          summary,
          rows: [],
          retained: [],
          through: null,
          paused: false,
          pending: 0,
          error: null,
        };
        set({ activeId: summary.tailId, entries: { ...get().entries, [summary.tailId]: entry } });
        await get().poll(summary.tailId);
      },

      async poll(id) {
        const entry = get().entries[id];
        if (entry === undefined || busy.has(id)) return;
        busy.add(id);
        const epoch = epochs.get(id) ?? 0;
        try {
          const client = await connect(entry.datasourceId);
          const window = await client.call("topics.tailWindow", {
            tailId: id,
            after: entry.through,
            count: TAIL_WINDOW_COUNT,
            maxBytes: TAIL_WINDOW_BYTES,
          });
          const current = get().entries[id];
          if (current === undefined || (epochs.get(id) ?? 0) !== epoch) return;
          const retained = appendTailWindow(current.retained, window, TAIL_DISPLAY_ROWS);
          const { rows: _rows, skipped: _skipped, through, ...summary } = window;
          patch(id, {
            summary,
            retained,
            rows: current.paused ? current.rows : retained,
            pending: current.paused ? current.pending + window.rows.length : 0,
            through: through ?? current.through,
            error: summary.error,
          });
        } catch (cause) {
          patch(id, { error: cause instanceof Error ? cause.message : String(cause) });
        } finally {
          busy.delete(id);
        }
      },

      select: (id) => set({ activeId: id }),

      pause(id) {
        const entry = get().entries[id];
        if (entry !== undefined) patch(id, { paused: !entry.paused, rows: entry.retained, pending: 0 });
      },

      async clear(id) {
        const entry = get().entries[id];
        if (entry === undefined) return;
        await (await connect(entry.datasourceId)).call("topics.tailClear", { tailId: id });
        epochs.set(id, (epochs.get(id) ?? 0) + 1);
        patch(id, { rows: [], retained: [], pending: 0 });
      },

      async stop(id, close = false) {
        const entry = get().entries[id];
        if (entry === undefined) return;
        if (entry.summary.state !== "stopped")
          await (await connect(entry.datasourceId)).call("topics.tailStop", { tailId: id }).catch(() => null);
        if (!close) {
          patch(id, { summary: { ...entry.summary, state: "stopped" } });
          return;
        }
        // A stopped tail keeps its messages, and their temporary file, until it is cleared; a
        // detached one went with its engine, and connecting again only to clear it would reconnect.
        if (!detached.delete(id))
          await (await connect(entry.datasourceId)).call("topics.tailClear", { tailId: id }).catch(() => null);
        const { [id]: _gone, ...entries } = get().entries;
        set({ entries, activeId: get().activeId === id ? (Object.keys(entries).at(-1) ?? null) : get().activeId });
      },

      detach(datasourceId) {
        generations.set(datasourceId, (generations.get(datasourceId) ?? 0) + 1);
        for (const [id, entry] of Object.entries(get().entries))
          if (entry.datasourceId === datasourceId) {
            detached.add(id);
            patch(id, {
              summary: { ...entry.summary, state: "stopped" },
              error: "Disconnected. This tail stopped; start a new one after reconnecting.",
            });
          }
      },

      async message(id, sequence) {
        const entry = get().entries[id];
        if (entry === undefined || detached.has(id)) return null;
        return (await connect(entry.datasourceId)).call("topics.tailMessage", { tailId: id, sequence });
      },
    };
  });
}

export const useTail = createTailStore((id) => useDatasources.getState().connect(id), currentSpill);
