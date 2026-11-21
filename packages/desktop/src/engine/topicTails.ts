import { SpillFile, type SpillBudget } from "@table-craft/core";
import type { MessageHeader, Session, TailMessage, TopicTail, TopicTailRequest } from "@table-craft/plugin-api";
import {
  MESSAGE_PREVIEW_CHARS,
  TOPIC_TAIL_SPILL_BYTES,
  type RequestOf,
  type TopicTailRow,
  type TopicTailSummary,
  type TopicTailWindow,
} from "@table-craft/desktop/engine/protocol.js";
import { serviceOf } from "@table-craft/desktop/engine/services.js";
import {
  type KeyOperationScope,
  KEY_RESOURCE_LIMIT,
  invalidOperation,
  quietClose,
} from "@table-craft/desktop/engine/keyOperations/scope.js";
import { messageOf } from "@table-craft/desktop/engine/failures.js";

/** One pull of a tail: enough to keep up with a busy topic without holding the plugin long. */
const PULL_MESSAGES = 500;
const PULL_BYTES = 1_048_576;
const PULL_TIMEOUT_MS = 1_000;
/** The pause after an empty batch, so a plugin that answers at once is not spun on. */
const IDLE_PAUSE_MS = 10;
const PREVIEW_END = "…";

interface HeldMessage {
  readonly sequence: bigint;
  readonly message: TailMessage;
  readonly bytes: number;
  /** The message is a preview; the full one is in the tail's spill. */
  readonly spilled: boolean;
}

const cut = (text: string | null): string | null =>
  text === null || text.length <= MESSAGE_PREVIEW_CHARS
    ? text
    : `${text.slice(0, MESSAGE_PREVIEW_CHARS)}${PREVIEW_END}`;

/** Headers up to the preview's length, each value cut to it; the rest go. */
function headerPreview(headers: readonly MessageHeader[]): MessageHeader[] {
  const kept: MessageHeader[] = [];
  let length = 0;
  for (const header of headers) {
    if (length >= MESSAGE_PREVIEW_CHARS) break;
    const value = cut(header.value);
    kept.push({ name: header.name, value });
    length += header.name.length + (value?.length ?? 0);
  }
  return kept;
}

/** A large message's preview, as the ring holds it (decision 172); null when the message is small enough to hold whole. */
export function tailPreview(message: TailMessage): TailMessage | null {
  const headerLength = message.headers.reduce(
    (sum, header) => sum + header.name.length + (header.value?.length ?? 0),
    0,
  );
  const large =
    (message.key?.length ?? 0) > MESSAGE_PREVIEW_CHARS ||
    (message.value?.length ?? 0) > MESSAGE_PREVIEW_CHARS ||
    headerLength > MESSAGE_PREVIEW_CHARS;
  if (!large) return null;
  return { ...message, key: cut(message.key), value: cut(message.value), headers: headerPreview(message.headers) };
}

/**
 * A tail's messages bounded by count and bytes, the oldest dropped past either (plan 164). Every
 * message takes a sequence on arrival, held or not, so a window can say how many it missed.
 */
export class TopicTailRing {
  private rows: HeldMessage[] = [];
  private head = 0;
  private bytes = 0;
  private next = 1n;
  private dropped = 0n;
  /** The last sequence a clear removed; what it removed is never reported as skipped. */
  private clearedThrough = 0n;

  constructor(
    readonly maxMessages: number,
    readonly maxBytes: number,
  ) {}

  /** Holds the message under the next sequence and returns it; `spilled` marks a preview of a message on disk. */
  append(message: TailMessage, spilled = false): bigint {
    const sequence = this.next++;
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > this.maxBytes) {
      this.dropped += 1n;
      return sequence;
    }
    this.rows.push({ sequence, message, bytes, spilled });
    this.bytes += bytes;
    while (this.rows.length - this.head > this.maxMessages || this.bytes > this.maxBytes) {
      const oldest = this.rows[this.head++];
      if (oldest !== undefined) this.bytes -= oldest.bytes;
      this.dropped += 1n;
    }
    // Dropped messages stay referenced until the array is cut, so cut once they are half of it:
    // past the byte cap a few large messages a second would otherwise pile up unbounded.
    if (this.head > 0 && this.head * 2 >= this.rows.length) {
      this.rows = this.rows.slice(this.head);
      this.head = 0;
    }
    return sequence;
  }

  /** The held message of `sequence`, by binary search: sequences only grow along the ring. */
  find(sequence: bigint): { readonly message: TailMessage; readonly spilled: boolean } | null {
    let low = this.head;
    let high = this.rows.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const row = this.rows[middle];
      if (row === undefined) return null;
      if (row.sequence === sequence) return row;
      if (row.sequence < sequence) low = middle + 1;
      else high = middle - 1;
    }
    return null;
  }

  clear(): void {
    this.rows = [];
    this.head = 0;
    this.bytes = 0;
    this.clearedThrough = this.next - 1n;
  }

  /** Messages the ring still references, dropped ones not yet cut included. */
  referenced(): number {
    return this.rows.length;
  }

  droppedTotal(): string {
    return String(this.dropped);
  }

  window(after: string | null, count: number, maxBytes: number) {
    const from = after === null ? this.clearedThrough : BigInt(after);
    const start = from > this.clearedThrough ? from : this.clearedThrough;
    const rows: TopicTailRow[] = [];
    let bytes = 0;
    let last: bigint | null = null;
    for (let index = this.head; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      if (row === undefined || row.sequence <= start) continue;
      if (rows.length >= count || (rows.length > 0 && bytes + row.bytes > maxBytes)) break;
      rows.push({ sequence: String(row.sequence), message: row.message });
      bytes += row.bytes;
      last = row.sequence;
    }
    const newest = this.next - 1n;
    // Every held row in (start, last] was returned, so what that span lacks was dropped.
    const through = last ?? (newest > start ? newest : start);
    const skipped = through - start - BigInt(rows.length);
    return {
      rows,
      skipped: String(skipped > 0n ? skipped : 0n),
      through: through === 0n ? null : String(through),
    };
  }
}

interface RunningTail {
  readonly id: string;
  readonly request: TopicTailRequest;
  readonly ring: TopicTailRing;
  readonly session: Session;
  readonly tail: TopicTail;
  /** Full large messages by sequence; null when the tail was started with `spill: false`. */
  spill: SpillFile<TailMessage> | null;
  state: TopicTailSummary["state"];
  error: string | null;
  closed: boolean;
  closing: Promise<void> | null;
}

/** The live tails of one port, each on a dedicated session, closed with the port (plan 164). */
export class TopicTails {
  private readonly tails = new Map<string, RunningTail>();

  constructor(
    private readonly scope: KeyOperationScope,
    private readonly budget: SpillBudget,
  ) {
    scope.register(() => this.close());
  }

  private newSpill(): SpillFile<TailMessage> {
    return new SpillFile<TailMessage>({ budget: this.budget, maxBytes: TOPIC_TAIL_SPILL_BYTES, rotate: true });
  }

  private summary(open: RunningTail): TopicTailSummary {
    return {
      tailId: open.id,
      request: open.request,
      state: open.state,
      error: open.error,
      dropped: open.ring.droppedTotal(),
    };
  }

  private find(id: string): RunningTail {
    this.scope.capability("topics");
    const open = this.tails.get(id);
    if (open === undefined) throw invalidOperation("No tail with this ID belongs to this connection.");
    return open;
  }

  async start(request: RequestOf<"topics.tailStart">): Promise<TopicTailSummary> {
    this.scope.capability("topics");
    if (this.tails.size >= KEY_RESOURCE_LIMIT) {
      const stopped = [...this.tails.values()].find((entry) => entry.closed);
      if (stopped === undefined) throw invalidOperation("Too many tails; stop a tail first.");
      this.tails.delete(stopped.id);
      void stopped.spill?.close();
    }
    const session = await this.scope.open("topics");
    let tail: TopicTail | undefined;
    try {
      const spec: TopicTailRequest = {
        topic: request.topic,
        partitions: request.partitions,
        from: request.from,
        keyFormat: request.keyFormat,
        valueFormat: request.valueFormat,
      };
      tail = await serviceOf(session, "topics").tail(spec);
      this.scope.live();
      const held: RunningTail = {
        id: this.scope.id(),
        request: spec,
        ring: new TopicTailRing(request.maxMessages, request.maxBytes),
        session,
        tail,
        spill: request.spill === false ? null : this.newSpill(),
        state: "live",
        error: null,
        closed: false,
        closing: null,
      };
      this.tails.set(held.id, held);
      void this.pull(held);
      return this.summary(held);
    } catch (cause) {
      if (tail !== undefined) await quietClose(tail);
      await this.scope.release(session);
      throw cause;
    }
  }

  private async pull(open: RunningTail): Promise<void> {
    try {
      while (!open.closed) {
        const batch = await open.tail.next({ count: PULL_MESSAGES, maxBytes: PULL_BYTES, timeoutMs: PULL_TIMEOUT_MS });
        if (open.closed) break;
        for (const message of batch.messages) this.hold(open, message);
        open.state = batch.state;
        open.error = batch.error;
        if (batch.state === "stopped") break;
        if (batch.messages.length === 0) await new Promise<void>((resolve) => setTimeout(resolve, IDLE_PAUSE_MS));
      }
    } catch (cause) {
      if (!open.closed) open.error = messageOf(cause);
    } finally {
      await this.stopOpen(open);
    }
  }

  /** A spill the disk refused leaves the preview alone; `topics.tailMessage` then answers null. */
  private hold(open: RunningTail, message: TailMessage): void {
    const preview = open.spill === null ? null : tailPreview(message);
    if (preview === null) {
      open.ring.append(message);
      return;
    }
    const sequence = open.ring.append(preview, true);
    open.spill?.put(String(sequence), message).catch(() => undefined);
  }

  private stopOpen(open: RunningTail): Promise<void> {
    if (open.closing !== null) return open.closing;
    open.closed = true;
    open.state = "stopped";
    open.closing = quietClose(open.tail).then(() => this.scope.release(open.session));
    return open.closing;
  }

  window(request: RequestOf<"topics.tailWindow">): TopicTailWindow {
    const open = this.find(request.tailId);
    return { ...this.summary(open), ...open.ring.window(request.after, request.count, request.maxBytes) };
  }

  list(): readonly TopicTailSummary[] {
    this.scope.capability("topics");
    return [...this.tails.values()].map((entry) => this.summary(entry));
  }

  async stop(id: string): Promise<void> {
    await this.stopOpen(this.find(id));
  }

  /** The full message of `sequence`, from the ring or the tail's spill; null once either dropped it. */
  async message(id: string, sequence: string): Promise<TailMessage | null> {
    const open = this.find(id);
    const held = open.ring.find(BigInt(sequence));
    if (held === null) return null;
    if (!held.spilled) return held.message;
    return (await open.spill?.get(sequence)) ?? null;
  }

  /** Empties the ring and deletes its spill; a running tail spills into a new one. */
  clear(id: string): void {
    const open = this.find(id);
    open.ring.clear();
    if (open.spill === null) return;
    void open.spill.close();
    open.spill = open.closed ? null : this.newSpill();
  }

  async close(): Promise<void> {
    const tails = [...this.tails.values()];
    this.tails.clear();
    await Promise.allSettled(
      tails.map(async (entry) => {
        await this.stopOpen(entry);
        await entry.spill?.close();
      }),
    );
  }
}
