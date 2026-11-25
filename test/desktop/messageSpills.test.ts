import { describe, expect, it } from "vitest";
import { SpillBudget, type ResultStore } from "@table-craft/core";
import type { Row } from "@table-craft/plugin-api";
import { MessageSpills } from "@table-craft/desktop/engine/messageSpills.js";

const FULL_VALUE = "v".repeat(5_000);
const PREVIEW_VALUE = `${FULL_VALUE.slice(0, 1_024)}…`;
const VALUE_COLUMN = 3;
const SPILLED_ROW: Row = [0, { kind: "bigint", value: "7" }, "k", PREVIEW_VALUE, null];
const HANDLE = "r1";

function resultsWith(names: readonly string[]): ResultStore {
  return {
    columns: () => names.map((name) => ({ name, type: null })),
    rows: () => [],
  } as unknown as ResultStore;
}

async function spilled(names: readonly string[] = ["partition", "offset", "key", "value", "headers"]) {
  const spills = new MessageSpills(new SpillBudget({ minFreeBytes: 0 }), resultsWith(names));
  const file = spills.create();
  await MessageSpills.adapter(file).put(0, "7", { key: "k", value: FULL_VALUE, headers: null });
  spills.hold(HANDLE, file);
  return { spills, file };
}

function gated(rows: readonly Row[]) {
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  async function* source(): AsyncIterable<Row> {
    await gate;
    yield* rows;
  }
  return { rows: source(), open };
}

async function all(rows: AsyncIterable<Row>): Promise<Row[]> {
  const collected: Row[] = [];
  for await (const row of rows) collected.push(row);
  return collected;
}

describe("message spills", () => {
  it("givenExportReading_whenResultReleased_thenRowsStayWholeAndTheFileClosesAfter", async () => {
    const { spills, file } = await spilled();
    const source = gated([SPILLED_ROW]);
    const iterator = spills.fullRows(HANDLE, source.rows)[Symbol.asyncIterator]();
    const first = iterator.next();
    await Promise.resolve();

    await spills.release(HANDLE);
    expect(file.closed).toBe(false);
    source.open();

    const head = await first;
    expect(head.done === true ? null : head.value[VALUE_COLUMN]).toBe(FULL_VALUE);
    expect((await iterator.next()).done).toBe(true);
    expect(file.closed).toBe(true);
  });

  it("givenResultReleasedBeforeTheExportStarts_whenRowsRead_thenFailsRatherThanWritingPreviews", async () => {
    const { spills } = await spilled();
    const source = gated([SPILLED_ROW]);
    const rows = spills.fullRows(HANDLE, source.rows);

    await spills.release(HANDLE);
    source.open();

    await expect(all(rows)).rejects.toThrow("closed before its large messages were read whole");
  });

  it("givenSpilledResultWithoutAValueColumn_whenCopied_thenFailsNamingIt", async () => {
    const { spills } = await spilled(["partition", "offset", "key", "headers"]);

    await expect(spills.fullRowsOf(HANDLE, [SPILLED_ROW])).rejects.toThrow("no value column");
    await spills.close();
  });

  it("givenResultWithoutSpill_whenRowsRead_thenTheyPassUnchanged", async () => {
    const spills = new MessageSpills(new SpillBudget({ minFreeBytes: 0 }), resultsWith(["value"]));
    const rows: Row[] = [["plain"]];

    await expect(spills.fullRowsOf(HANDLE, rows)).resolves.toBe(rows);
  });
});
