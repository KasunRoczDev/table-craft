import { randomBytes } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import type { TailMessage } from "@table-craft/plugin-api";
import {
  TOPIC_TAIL_COPY_MAX_BYTES,
  type RequestOf,
  type TopicTailExtract,
} from "@table-craft/desktop/engine/protocol.js";
import { EngineFailure } from "@table-craft/desktop/engine/failures.js";

/** Lines go to the file in writes of about this size, so a large export holds one chunk at a time. */
const FLUSH_BYTES = 1_048_576;
const LINE_END = "\n";
const PART_SUFFIX = ".part-";
const PART_RANDOM_BYTES = 6;
const WRITE_HINT = "Choose another folder, or copy the messages as JSON Lines instead.";

/** What the extraction reads a tail's held messages from. */
export interface TailSource {
  /** The held message of a sequence, a preview when `spilled`; null once the ring dropped it. */
  find(sequence: bigint): { readonly message: TailMessage; readonly spilled: boolean } | null;
  /** The whole message behind a spilled preview; null once its file rotated it away. */
  whole(sequence: string): Promise<TailMessage | null>;
}

type Held = { readonly sequence: string; readonly message: TailMessage; readonly spilled: boolean };

/** One line after another, to the file or into the text; the file only fills as far as `FLUSH_BYTES` at a time. */
class Lines {
  readonly #text: string[] = [];
  #pending: string[] = [];
  #pendingBytes = 0;
  bytes = 0;

  constructor(readonly file: FileHandle | null) {}

  async add(line: string): Promise<void> {
    this.bytes += Buffer.byteLength(line) + LINE_END.length;
    if (this.file === null) {
      this.#text.push(line);
      return;
    }
    this.#pending.push(line, LINE_END);
    this.#pendingBytes += line.length + LINE_END.length;
    if (this.#pendingBytes >= FLUSH_BYTES) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.file === null || this.#pending.length === 0) return;
    const chunk = this.#pending.join("");
    this.#pending = [];
    this.#pendingBytes = 0;
    await this.file.write(chunk);
  }

  text(): string | null {
    return this.file === null ? this.#text.join(LINE_END) : null;
  }
}

/**
 * The tail pane's rows as JSON Lines, gaps as `{"dropped": N}`, each large message whole from its
 * file (decision 172). One the file rotated away, or one past `TOPIC_TAIL_COPY_MAX_BYTES` of copied
 * text, is written as its preview and counted in `cut`. Rows the ring no longer holds write nothing.
 */
export async function extractTail(
  source: TailSource,
  request: Pick<RequestOf<"topics.tailExtract">, "rows" | "path">,
): Promise<TopicTailExtract> {
  const rows: (Held | { readonly dropped: string })[] = [];
  let missing = 0;
  for (const row of request.rows) {
    if ("dropped" in row) {
      rows.push(row);
      continue;
    }
    const held = source.find(BigInt(row.sequence));
    if (held === null) missing += 1;
    else rows.push({ sequence: row.sequence, message: held.message, spilled: held.spilled });
  }
  if (missing > 0) return { text: null, messages: 0, cut: 0, missing };
  const part = request.path === null ? null : partPath(request.path);
  const file = part === null ? null : await openFile(part);
  const lines = new Lines(file);
  let messages = 0;
  let cut = 0;
  let written = false;
  try {
    for (const row of rows) {
      if ("dropped" in row) {
        await lines.add(JSON.stringify({ dropped: row.dropped }));
        continue;
      }
      messages += 1;
      const roomy = file !== null || lines.bytes < TOPIC_TAIL_COPY_MAX_BYTES;
      const whole = row.spilled && roomy ? await source.whole(row.sequence) : null;
      if (row.spilled && whole === null) cut += 1;
      await lines.add(JSON.stringify(whole ?? row.message));
    }
    await lines.flush();
    if (file !== null && part !== null && request.path !== null) {
      await file.close();
      await rename(part, request.path);
    }
    written = true;
  } catch (cause) {
    throw writeFailed(cause);
  } finally {
    await file?.close().catch(() => undefined);
    if (!written && part !== null) await rm(part, { force: true }).catch(() => undefined);
  }
  return { text: lines.text(), messages, cut, missing: 0 };
}

/** A name beside the target, so the target only ever appears whole: the file is renamed onto it once written. */
function partPath(path: string): string {
  return `${path}${PART_SUFFIX}${randomBytes(PART_RANDOM_BYTES).toString("hex")}`;
}

async function openFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, "w");
  } catch (cause) {
    throw writeFailed(cause);
  }
}

function writeFailed(cause: unknown): EngineFailure {
  return new EngineFailure({
    code: "exportFailed",
    message: `The messages could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
    hint: WRITE_HINT,
  });
}
