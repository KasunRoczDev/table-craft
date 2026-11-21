import { SpillFile, type ResultStore, type SpillBudget } from "@table-craft/core";
import type { MessageSpill, Row, SpilledMessage } from "@table-craft/plugin-api";
import { BUG_HINT, EngineFailure } from "@table-craft/desktop/engine/failures.js";

/** The columns a spilled message replaces in its row; mirrors the kafka plugin's names. */
const SPILLED_COLUMNS = ["key", "value", "headers"] as const satisfies readonly (keyof SpilledMessage)[];
const PLACE_COLUMNS = ["partition", "offset", ...SPILLED_COLUMNS] as const;

const spillId = (partition: number, offset: string): string => `${String(partition)}:${offset}`;

type Places = Record<(typeof PLACE_COLUMNS)[number], number>;

function spillReleased(): EngineFailure {
  return new EngineFailure({
    code: "unknownHandle",
    message: "The result was closed before its large messages were read whole.",
    hint: "Read the topic again, then copy or export again.",
  });
}

function columnMissing(name: string): EngineFailure {
  return new EngineFailure({
    code: "internal",
    message: `The result holds large messages but has no ${name} column to put them back in.`,
    hint: BUG_HINT,
  });
}

/** The full cells of a topic read's large messages, on disk, by the result handle that shows their previews. */
export class MessageSpills {
  readonly #files = new Map<string, SpillFile<SpilledMessage>>();
  /** Copies and exports reading a file; a released file closes once the last of them ends. */
  readonly #readers = new Map<SpillFile<SpilledMessage>, number>();
  readonly #released = new Set<SpillFile<SpilledMessage>>();

  constructor(
    private readonly budget: SpillBudget,
    private readonly results: ResultStore,
  ) {}

  /** A file for one read; the caller holds it under the read's handle or closes it. */
  create(): SpillFile<SpilledMessage> {
    return new SpillFile<SpilledMessage>({ budget: this.budget });
  }

  /** What a plugin's read writes through; `SpillFull` and `SpillFailed` messages read as the reason it stopped. */
  static adapter(file: SpillFile<SpilledMessage>): MessageSpill {
    return { put: (partition, offset, message) => file.put(spillId(partition, offset), message) };
  }

  hold(handle: string, file: SpillFile<SpilledMessage>): void {
    const earlier = this.#files.get(handle);
    this.#files.set(handle, file);
    if (earlier !== undefined) void this.#closeWhenRead(earlier);
  }

  holds(handle: string): boolean {
    return this.#files.has(handle);
  }

  release(handle: string): Promise<void> {
    const file = this.#files.get(handle);
    if (file === undefined) return Promise.resolve();
    this.#files.delete(handle);
    return this.#closeWhenRead(file);
  }

  async close(): Promise<void> {
    const files = [...this.#files.values(), ...this.#released];
    this.#files.clear();
    this.#released.clear();
    this.#readers.clear();
    await Promise.allSettled(files.map((file) => file.close()));
  }

  /** The full key, value and headers of one held message, or null when the result does not hold it. */
  async message(handle: string, partition: number, offset: string): Promise<SpilledMessage | null> {
    const spilled = await this.#files.get(handle)?.get(spillId(partition, offset));
    if (spilled !== undefined && spilled !== null) return spilled;
    const places = this.#places(handle);
    const row = this.results
      .rows(handle)
      .find(
        (each) => Number(cellText(each[places.partition])) === partition && cellText(each[places.offset]) === offset,
      );
    if (row === undefined) return null;
    return { key: row[places.key] ?? null, value: row[places.value] ?? null, headers: row[places.headers] ?? null };
  }

  /**
   * The rows with each spilled message's full cells in place of its previews, read one at a time.
   * The file stays open until the rows end, and a result closed before they start fails them
   * rather than letting previews pass for whole messages.
   */
  fullRows(handle: string, rows: AsyncIterable<Row>): AsyncIterable<Row> {
    const file = this.#files.get(handle);
    if (file === undefined) return rows;
    const places = this.#spilledPlaces(handle);
    return this.#whileRead(file, async function* () {
      for await (const row of rows) yield await whole(file, places, row);
    });
  }

  /** `fullRows` for rows already in hand, such as the ones a copy picked. */
  async fullRowsOf(handle: string, rows: readonly Row[]): Promise<readonly Row[]> {
    const file = this.#files.get(handle);
    if (file === undefined) return rows;
    const places = this.#spilledPlaces(handle);
    const read = this.#whileRead(file, async function* () {
      for (const row of rows) yield await whole(file, places, row);
    });
    const full: Row[] = [];
    for await (const row of read) full.push(row);
    return full;
  }

  async *#whileRead(file: SpillFile<SpilledMessage>, read: () => AsyncIterable<Row>): AsyncIterable<Row> {
    this.#readers.set(file, (this.#readers.get(file) ?? 0) + 1);
    try {
      yield* read();
    } finally {
      const left = (this.#readers.get(file) ?? 1) - 1;
      if (left > 0) this.#readers.set(file, left);
      else this.#readers.delete(file);
      if (left <= 0 && this.#released.delete(file)) void file.close();
    }
  }

  #closeWhenRead(file: SpillFile<SpilledMessage>): Promise<void> {
    if (this.#readers.has(file)) {
      this.#released.add(file);
      return Promise.resolve();
    }
    return file.close();
  }

  #places(handle: string): Places {
    const names = this.results.columns(handle).map((column) => column.name);
    return Object.fromEntries(PLACE_COLUMNS.map((name) => [name, names.indexOf(name)])) as Places;
  }

  /** A result that spilled must name every column a spilled message goes back into. */
  #spilledPlaces(handle: string): Places {
    const places = this.#places(handle);
    const missing = PLACE_COLUMNS.find((name) => places[name] < 0);
    if (missing !== undefined) throw columnMissing(missing);
    return places;
  }
}

async function whole(file: SpillFile<SpilledMessage>, places: Places, row: Row): Promise<Row> {
  if (file.closed) throw spillReleased();
  const partition = Number(cellText(row[places.partition]));
  const offset = cellText(row[places.offset]);
  const spilled = offset === null ? null : await file.get(spillId(partition, offset));
  if (spilled === null) {
    if (file.closed) throw spillReleased();
    return row;
  }
  const full = [...row];
  for (const name of SPILLED_COLUMNS) full[places[name]] = spilled[name];
  return full;
}

function cellText(cell: Row[number] | undefined): string | null {
  if (cell === undefined || cell === null) return null;
  if (typeof cell !== "object") return String(cell);
  return cell.kind === "bigint" ? cell.value : null;
}
