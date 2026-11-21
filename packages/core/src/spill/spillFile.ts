import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, statfs, unlink, type FileHandle } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreError } from "@table-craft/core/errors.js";

/** One segment file of a spill; a full one is closed and the next opens. */
export const SPILL_SEGMENT_BYTES = 67_108_864;
/** What every spill file of one engine process may hold together. */
export const SPILL_TOTAL_BYTES = 2_147_483_648;
/** A new segment opens only while the temporary disk keeps at least this much free. */
export const SPILL_MIN_FREE_BYTES = 1_073_741_824;
/** Records wait in memory up to this much before one write; a read of a waiting one flushes first. */
const SPILL_WRITE_BUFFER_BYTES = 1_048_576;
const SPILL_DIRECTORY_PREFIX = "table-craft-spill-";
const SPILL_DIRECTORY_PATTERN = /^table-craft-spill-(\d+)$/;
const SPILL_SUFFIX = ".spill";
const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;
const BYTES_PER_GB = 1_073_741_824;
const FULL_HINT = "Lower the limit or narrow the filter, or close results that hold large messages.";
const FAILED_HINT = "Check that the temporary folder is writable and has free space, then run it again.";

/** The temporary disk space for spilled records is used up; the caller keeps what it already has. */
export class SpillFull extends CoreError {
  override readonly name = "SpillFull";

  constructor(message: string) {
    super("spillFull", message, FULL_HINT);
  }
}

/** Writing or reading a spill file failed; that spill refuses further records. */
export class SpillFailed extends CoreError {
  override readonly name = "SpillFailed";

  constructor(cause: unknown) {
    super(
      "spillFailed",
      `the temporary file for large messages failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      FAILED_HINT,
    );
  }
}

const gigabytes = (bytes: number): string => `${Math.round(bytes / BYTES_PER_GB)} GB`;

/** Free bytes on the disk holding `path`. */
export type FreeSpace = (path: string) => Promise<number>;

const diskFreeSpace: FreeSpace = async (path) => {
  const stats = await statfs(path);
  return stats.bavail * stats.bsize;
};

export interface SpillBudgetOptions {
  readonly totalBytes?: number;
  readonly minFreeBytes?: number;
  readonly freeSpace?: FreeSpace;
}

/** The disk all spill files of one engine process share: a total cap and a free-space floor. */
export class SpillBudget {
  readonly totalBytes: number;
  readonly minFreeBytes: number;
  readonly #freeSpace: FreeSpace;
  #used = 0;

  constructor(options: SpillBudgetOptions = {}) {
    this.totalBytes = options.totalBytes ?? SPILL_TOTAL_BYTES;
    this.minFreeBytes = options.minFreeBytes ?? SPILL_MIN_FREE_BYTES;
    this.#freeSpace = options.freeSpace ?? diskFreeSpace;
  }

  get used(): number {
    return this.#used;
  }

  reserve(bytes: number): void {
    if (this.#used + bytes > this.totalBytes) {
      throw new SpillFull(`the temporary disk space for large messages is full (${gigabytes(this.totalBytes)})`);
    }
    this.#used += bytes;
  }

  release(bytes: number): void {
    this.#used = Math.max(0, this.#used - bytes);
  }

  async checkFree(directory: string): Promise<void> {
    if ((await this.#freeSpace(directory)) < this.minFreeBytes) {
      throw new SpillFull(`the disk for temporary files has less than ${gigabytes(this.minFreeBytes)} free`);
    }
  }
}

/** The folder of this process's spill files, under the system temporary folder. */
export const spillDirectory = (root: string = tmpdir(), pid: number = process.pid): string =>
  join(root, `${SPILL_DIRECTORY_PREFIX}${String(pid)}`);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Deletes the spill folders of processes that are gone; returns the folders deleted. */
export const sweepSpills = async (root: string = tmpdir()): Promise<string[]> => {
  const entries = await readdir(root).catch(() => [] as string[]);
  const swept: string[] = [];
  for (const entry of entries) {
    const pid = SPILL_DIRECTORY_PATTERN.exec(entry)?.[1];
    if (pid === undefined || Number(pid) === process.pid || alive(Number(pid))) continue;
    const path = join(root, entry);
    await rm(path, { recursive: true, force: true }).catch(() => undefined);
    swept.push(path);
  }
  return swept;
};

/** Deletes this process's spill folder; synchronous so a process `exit` handler can run it. */
export const removeSpillDirectory = (directory: string = spillDirectory()): void => {
  rmSync(directory, { recursive: true, force: true });
};

export interface SpillFileOptions {
  readonly budget: SpillBudget;
  readonly directory?: string;
  readonly segmentBytes?: number;
  /** What this file may hold; past it a put is refused, or with `rotate` the oldest segment goes. */
  readonly maxBytes?: number;
  readonly rotate?: boolean;
}

interface Place {
  readonly segment: number;
  readonly position: number;
  readonly length: number;
}

interface Segment {
  readonly number: number;
  readonly path: string;
  readonly handle: FileHandle;
  readonly ids: string[];
  size: number;
  flushed: number;
  pending: Buffer[];
}

/**
 * An append-only temporary file of JSON records, read back by the id the caller gave. The index
 * stays in memory; the records stay on disk, in segments, so a rotating spill drops whole
 * segments. Calls run one at a time, in order.
 */
export class SpillFile<T> {
  readonly #budget: SpillBudget;
  readonly #directory: string;
  readonly #segmentBytes: number;
  readonly #maxBytes: number;
  readonly #rotate: boolean;
  readonly #name = randomUUID();
  readonly #index = new Map<string, Place>();
  readonly #segments: Segment[] = [];
  #next = 0;
  #held = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #failed: SpillFailed | null = null;
  #closed = false;

  constructor(options: SpillFileOptions) {
    this.#budget = options.budget;
    this.#directory = options.directory ?? spillDirectory();
    this.#segmentBytes = options.segmentBytes ?? SPILL_SEGMENT_BYTES;
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.#rotate = options.rotate ?? false;
  }

  /** Bytes this file holds on disk and in its write buffer. */
  get bytes(): number {
    return this.#held;
  }

  get size(): number {
    return this.#index.size;
  }

  /** The segment files, oldest first; for tests and diagnostics. */
  get paths(): string[] {
    return this.#segments.map((segment) => segment.path);
  }

  has(id: string): boolean {
    return this.#index.has(id);
  }

  /** Rejects with `SpillFull` past a cap, `SpillFailed` when the disk refuses. */
  put(id: string, payload: T): Promise<void> {
    return this.#serial(() => this.#put(id, Buffer.from(JSON.stringify(payload))));
  }

  /** The record, or null when the id is unknown or its segment was rotated away. */
  get(id: string): Promise<T | null> {
    return this.#serial(() => this.#get(id));
  }

  /** Deletes the files; later puts are refused and gets answer null. */
  close(): Promise<void> {
    if (this.#closed) return this.#queue.then(() => undefined);
    this.#closed = true;
    return this.#queue.then(async () => {
      for (const segment of this.#segments.splice(0)) await this.#drop(segment);
      this.#index.clear();
    });
  }

  #serial<R>(work: () => Promise<R>): Promise<R> {
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #put(id: string, record: Buffer): Promise<void> {
    if (this.#closed) throw new SpillFailed(new Error("the spill is closed"));
    if (this.#failed !== null) throw this.#failed;
    const length = record.length;
    while (this.#held + length > this.#maxBytes) {
      if (!this.#rotate || this.#segments.length === 0) {
        throw new SpillFull(`the temporary file for large messages is full (${gigabytes(this.#maxBytes)})`);
      }
      await this.#dropOldest();
    }
    await this.#reserve(length);
    let segment: Segment;
    try {
      segment = await this.#segmentFor(length);
    } catch (cause) {
      this.#budget.release(length);
      throw cause instanceof SpillFull ? cause : this.#fail(cause);
    }
    this.#index.set(id, { segment: segment.number, position: segment.size, length });
    segment.ids.push(id);
    segment.pending.push(record);
    segment.size += length;
    this.#held += length;
    if (segment.size - segment.flushed < SPILL_WRITE_BUFFER_BYTES) return;
    try {
      await this.#flush(segment);
    } catch (cause) {
      throw this.#fail(cause);
    }
  }

  /** A rotating spill gives back its own oldest segments before the shared budget refuses it. */
  async #reserve(length: number): Promise<void> {
    for (;;) {
      try {
        this.#budget.reserve(length);
        return;
      } catch (cause) {
        if (!this.#rotate || this.#segments.length === 0) throw cause;
        await this.#dropOldest();
      }
    }
  }

  async #segmentFor(length: number): Promise<Segment> {
    const current = this.#segments.at(-1);
    if (current !== undefined && (current.size === 0 || current.size + length <= this.#segmentBytes)) return current;
    if (current !== undefined) await this.#flush(current);
    await mkdir(this.#directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY });
    await this.#budget.checkFree(this.#directory);
    const number = this.#next++;
    const path = join(this.#directory, `${this.#name}-${String(number)}${SPILL_SUFFIX}`);
    const handle = await open(path, "w+", OWNER_ONLY_FILE);
    const segment: Segment = { number, path, handle, ids: [], size: 0, flushed: 0, pending: [] };
    this.#segments.push(segment);
    return segment;
  }

  async #flush(segment: Segment): Promise<void> {
    if (segment.pending.length === 0) return;
    const buffer = Buffer.concat(segment.pending);
    await segment.handle.write(buffer, 0, buffer.length, segment.flushed);
    segment.pending = [];
    segment.flushed += buffer.length;
  }

  async #get(id: string): Promise<T | null> {
    const place = this.#index.get(id);
    if (place === undefined || this.#closed) return null;
    const segment = this.#segments.find((each) => each.number === place.segment);
    if (segment === undefined) return null;
    try {
      if (place.position + place.length > segment.flushed) await this.#flush(segment);
      const buffer = Buffer.alloc(place.length);
      await segment.handle.read(buffer, 0, place.length, place.position);
      return JSON.parse(buffer.toString("utf8")) as T;
    } catch (cause) {
      throw this.#fail(cause);
    }
  }

  async #dropOldest(): Promise<void> {
    const oldest = this.#segments.shift();
    if (oldest !== undefined) await this.#drop(oldest);
  }

  async #drop(segment: Segment): Promise<void> {
    for (const id of segment.ids) {
      if (this.#index.get(id)?.segment === segment.number) this.#index.delete(id);
    }
    this.#held -= segment.size;
    this.#budget.release(segment.size);
    segment.pending = [];
    await segment.handle.close().catch(() => undefined);
    await unlink(segment.path).catch(() => undefined);
  }

  #fail(cause: unknown): SpillFailed {
    this.#failed ??= cause instanceof SpillFailed ? cause : new SpillFailed(cause);
    return this.#failed;
  }
}
