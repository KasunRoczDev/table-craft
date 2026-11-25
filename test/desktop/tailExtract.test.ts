import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TailMessage } from "@table-craft/desktop/engine/protocol.js";
import { extractTail, type TailSource } from "@table-craft/desktop/engine/tailExtract.js";

const TARGET = "tail.jsonl";
const EARLIER_EXPORT = "an earlier export\n";

function message(offset: number, value: string): TailMessage {
  return {
    partition: 0,
    offset: String(offset),
    timestamp: null,
    key: null,
    value,
    headers: [],
    size: value.length,
    keySchema: null,
    valueSchema: null,
  };
}

function source(whole: (sequence: string) => Promise<TailMessage | null>): TailSource {
  return {
    find: (sequence) => ({ message: message(Number(sequence), "preview…"), spilled: true }),
    whole,
  };
}

const ROWS = [{ sequence: "1" }, { sequence: "2" }];

describe("tail export file", () => {
  let folder = "";

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "tc-tail-extract-"));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it("givenExport_whenWritten_thenTheTargetAppearsWholeAndNoPartFileStays", async () => {
    const path = join(folder, TARGET);
    const extracted = await extractTail(
      source((sequence) => Promise.resolve(message(Number(sequence), "whole"))),
      { rows: ROWS, path },
    );
    expect(extracted).toMatchObject({ text: null, messages: 2, cut: 0 });
    expect(await readdir(folder)).toEqual([TARGET]);
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines.map((line) => (JSON.parse(line) as TailMessage).value)).toEqual(["whole", "whole"]);
  });

  it("givenWriteFailsMidway_whenExported_thenThePartFileIsDeletedAndTheTargetLeftAsItWas", async () => {
    const path = join(folder, TARGET);
    await writeFile(path, EARLIER_EXPORT);
    const failing = source((sequence) =>
      sequence === "2" ? Promise.reject(new Error("disk gone")) : Promise.resolve(message(1, "whole")),
    );
    await expect(extractTail(failing, { rows: ROWS, path })).rejects.toMatchObject({
      error: { code: "exportFailed" },
    });
    expect(await readdir(folder)).toEqual([TARGET]);
    expect(await readFile(path, "utf8")).toBe(EARLIER_EXPORT);
  });
});
