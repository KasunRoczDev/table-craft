import { Consumer, type BaseOptions } from "@platformatic/kafka";
import type { TailMessage, TopicTail, TopicTailBatch, TopicTailRequest, TopicTailState } from "@table-craft/plugin-api";
import { isInternalTopic, type KafkaAdmin } from "./admin.js";
import { errorText } from "./failures.js";
import { fetchRound, FETCH_ERRORS, recoveredPosition, UNJOINED_GROUP_ID, type FetchSizes } from "./fetch.js";
import { decodeAll, layoutOf } from "./read.js";
import { checkStart, compareMessages, startOffset, timestampMillis } from "./readPlan.js";
import type { SchemaCache } from "./schemaCache.js";
import { headersOf, isoOf, type DecodedMessage } from "./results.js";

/** A tail waits at most this long per Fetch, so `close` is never held up for long. */
const MAX_WAIT_MS = 1000;
const TAIL_SIZES: Omit<FetchSizes, "maxWaitMs"> = { maxBytes: 4 * 1024 * 1024, partitionMaxBytes: 1024 * 1024 };
/** Messages held between two `next` calls; past it the tail stops fetching until the engine drains it. */
const MAX_BUFFERED = 10_000;
/**
 * The decoded text held between two `next` calls. A count alone does not bound it: a hex value
 * is about four bytes of UTF-16 per raw byte, so 500 messages of 1 MB would hold 2 GB.
 */
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MESSAGE_OVERHEAD_BYTES = 256;
const UTF16_BYTES = 2;

function tailMessage(message: DecodedMessage): TailMessage {
  return {
    partition: message.partition,
    offset: message.offset.toString(),
    timestamp: isoOf(message.timestamp),
    key: message.decodedKey.text,
    value: message.decodedValue.text,
    headers: headersOf(message),
    size: message.size,
    keySchema: message.decodedKey.schema,
    valueSchema: message.decodedValue.schema,
  };
}

/** About the memory a buffered message takes: its text as UTF-16, and the rest. */
export function tailMessageBytes(message: TailMessage): number {
  const headers = message.headers.reduce((sum, header) => sum + header.name.length + (header.value?.length ?? 0), 0);
  return MESSAGE_OVERHEAD_BYTES + UTF16_BYTES * ((message.key?.length ?? 0) + (message.value?.length ?? 0) + headers);
}

/**
 * A live read on its own consumer (decision 14 of plan 164): group-less like every read, it
 * fetches from each partition's position, decodes and hands over batches; it never commits.
 */
class KafkaTail implements TopicTail {
  readonly #consumer: Consumer;
  readonly #request: TopicTailRequest;
  readonly #registry: SchemaCache | null;
  readonly #admin: KafkaAdmin;
  readonly #positions: Map<number, bigint>;
  #layout: Awaited<ReturnType<typeof layoutOf>>;
  #buffer: TailMessage[] = [];
  #bufferedBytes = 0;
  #state: TopicTailState = "live";
  #error: string | null = null;
  #closed = false;

  constructor(
    consumer: Consumer,
    admin: KafkaAdmin,
    request: TopicTailRequest,
    registry: SchemaCache | null,
    layout: Awaited<ReturnType<typeof layoutOf>>,
    positions: Map<number, bigint>,
  ) {
    this.#consumer = consumer;
    this.#admin = admin;
    this.#request = request;
    this.#registry = registry;
    this.#layout = layout;
    this.#positions = positions;
  }

  #take(count: number, maxBytes: number): TailMessage[] {
    let bytes = 0;
    let taken = 0;
    while (taken < this.#buffer.length && taken < count) {
      const size = this.#buffer[taken]?.size ?? 0;
      if (taken > 0 && bytes + size > maxBytes) break;
      bytes += size;
      taken += 1;
    }
    const messages = this.#buffer.splice(0, taken);
    this.#bufferedBytes -= messages.reduce((sum, message) => sum + tailMessageBytes(message), 0);
    return messages;
  }

  #batch(messages: TailMessage[]): TopicTailBatch {
    return { messages, state: this.#closed ? "stopped" : this.#state, error: this.#closed ? null : this.#error };
  }

  async #fetch(waitMs: number): Promise<void> {
    if (this.#state === "reconnecting")
      this.#layout = await layoutOf(this.#consumer, this.#admin, this.#request.topic, this.#request.partitions);
    const targets = [...this.#positions.entries()].map(([partition, position]) => ({ partition, position }));
    const answers = await fetchRound(this.#consumer, this.#layout.id, this.#layout.leaders, targets, {
      ...TAIL_SIZES,
      maxWaitMs: waitMs,
    });
    const fetched = [];
    let stale = false;
    for (const answer of answers) {
      const position = this.#positions.get(answer.partition);
      if (position === undefined) continue;
      if (answer.errorCode === FETCH_ERRORS.offsetOutOfRange) {
        this.#positions.set(answer.partition, recoveredPosition(position, answer));
        continue;
      }
      if (answer.errorCode !== FETCH_ERRORS.none) {
        stale = true;
        continue;
      }
      fetched.push(...answer.messages);
      if (answer.next !== null) this.#positions.set(answer.partition, answer.next);
    }
    const decoded = await decodeAll(fetched.sort(compareMessages), this.#request, this.#registry, false);
    for (const message of decoded) {
      const tailed = tailMessage(message);
      this.#buffer.push(tailed);
      this.#bufferedBytes += tailMessageBytes(tailed);
    }
    this.#state = stale ? "reconnecting" : "live";
    this.#error = stale ? "A partition leader moved or did not answer; the tail looks it up again." : null;
    // Without a leader nothing waited on the broker, so wait here rather than spin.
    if (stale && fetched.length === 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  async next(request: {
    readonly count: number;
    readonly maxBytes: number;
    readonly timeoutMs: number;
  }): Promise<TopicTailBatch> {
    if (this.#closed) return this.#batch([]);
    if (
      this.#buffer.length < request.count &&
      this.#buffer.length < MAX_BUFFERED &&
      this.#bufferedBytes < MAX_BUFFERED_BYTES
    ) {
      try {
        await this.#fetch(Math.max(0, Math.min(request.timeoutMs, MAX_WAIT_MS)));
      } catch (cause) {
        this.#state = "reconnecting";
        this.#error = errorText(cause);
      }
    }
    return this.#batch(this.#take(Math.max(1, request.count), request.maxBytes));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = [];
    this.#bufferedBytes = 0;
    await this.#consumer.close().catch(() => undefined);
  }
}

/** Opens a tail on its own consumer, starting where the request says: latest unless told otherwise. */
export async function openTail(
  options: BaseOptions,
  admin: KafkaAdmin,
  registry: SchemaCache | null,
  request: TopicTailRequest,
): Promise<TopicTail> {
  const from = request.from;
  checkStart(from);
  const consumer = new Consumer({ ...options, groupId: UNJOINED_GROUP_ID });
  try {
    // The tail's consumer is its own, so the topic stays tracked until it closes.
    if (!isInternalTopic(request.topic)) consumer.topics.track(request.topic);
    const layout = await layoutOf(consumer, admin, request.topic, request.partitions);
    const marks = await admin.topicWatermarks(request.topic, layout.partitions);
    let resolved = new Map<number, bigint>();
    if (from.kind === "timestamp") {
      resolved =
        (await admin.offsetsAt(new Map([[request.topic, layout.partitions]]), timestampMillis(from.timestamp))).get(
          request.topic,
        ) ?? resolved;
    } else if (from.kind === "group") {
      resolved = await admin.committed(from.group, request.topic, layout.partitions);
    }
    const positions = new Map<number, bigint>();
    for (const partition of layout.partitions) {
      const mark = marks.get(partition);
      if (mark !== undefined) positions.set(partition, startOffset(from, mark, resolved.get(partition)));
    }
    return new KafkaTail(consumer, admin, request, registry, layout, positions);
  } catch (cause) {
    await consumer.close().catch(() => undefined);
    throw cause;
  }
}
