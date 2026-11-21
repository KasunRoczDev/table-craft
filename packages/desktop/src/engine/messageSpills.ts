import { SpillFile, type ResultStore, type SpillBudget } from "@table-craft/core";
import type { MessageSpill, Row, SpilledMessage } from "@table-craft/plugin-api";

/** The columns a spilled message replaces in its row; mirrors the kafka plugin's names. */
const SPILLED_COLUMNS = ["key", "value", "headers"] as const;

const spillId = (partition: number, offset: string): string => `${String(partition)}:${offset}`;

/** The full cells of a topic read's large messages, on disk, by the result handle that shows their previews. */
export class MessageSpills {
  readonly #files = new Map<string, SpillFile<SpilledMessage>>();

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
    void this.#files.get(handle)?.close();
    this.#files.set(handle, file);
  }

  holds(handle: string): boolean {
    return this.#files.has(handle);
  }

  release(handle: string): Promise<void> {
    const file = this.#files.get(handle);
    if (file === undefined) return Promise.resolve();
    this.#files.delete(handle);
    return file.close();
  }

  async close(): Promise<void> {
    const files = [...this.#files.values()];
    this.#files.clear();
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

  /** The rows with each spilled message's full cells in place of its previews, read one at a time. */
  async *fullRows(handle: string, rows: AsyncIterable<Row>): AsyncIterable<Row> {
    const file = this.#files.get(handle);
    if (file === undefined) {
      yield* rows;
      return;
    }
    const places = this.#places(handle);
    for await (const row of rows) {
      const partition = Number(cellText(row[places.partition]));
      const offset = cellText(row[places.offset]);
      const spilled = offset === null ? null : await file.get(spillId(partition, offset));
      if (spilled === null) {
        yield row;
        continue;
      }
      const full = [...row];
      for (const name of SPILLED_COLUMNS) {
        const index = places[name];
        if (index >= 0) full[index] = spilled[name];
      }
      yield full;
    }
  }

  #places(handle: string) {
    const names = this.results.columns(handle).map((column) => column.name);
    return {
      partition: names.indexOf("partition"),
      offset: names.indexOf("offset"),
      key: names.indexOf("key"),
      value: names.indexOf("value"),
      headers: names.indexOf("headers"),
    };
  }
}

function cellText(cell: Row[number] | undefined): string | null {
  if (cell === undefined || cell === null) return null;
  if (typeof cell !== "object") return String(cell);
  return cell.kind === "bigint" ? cell.value : null;
}
