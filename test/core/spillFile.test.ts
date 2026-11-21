import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SpillBudget,
  SpillFile,
  SpillFull,
  removeSpillDirectory,
  spillDirectory,
  sweepSpills,
} from "@table-craft/core";

const PLENTY_FREE = 1_000_000_000_000;
const SMALL_SEGMENT = 1_000;
const RECORD_TEXT = "x".repeat(400);
const OWNER_ONLY_FILE = 0o600;
const PERMISSION_BITS = 0o777;

let root: string;
const budget = (options: { totalBytes?: number; free?: number } = {}): SpillBudget =>
  new SpillBudget({
    totalBytes: options.totalBytes ?? PLENTY_FREE,
    minFreeBytes: 1,
    freeSpace: () => Promise.resolve(options.free ?? PLENTY_FREE),
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "spill-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("SpillFile", () => {
  it("givenRecords_whenPutThenGet_thenReturnsEachByIdAndNullForUnknown", async () => {
    const spill = new SpillFile<{ text: string }>({ budget: budget(), directory: join(root, "s") });
    await spill.put("0:1", { text: "first" });
    await spill.put("0:2", { text: RECORD_TEXT });

    await expect(spill.get("0:1")).resolves.toEqual({ text: "first" });
    await expect(spill.get("0:2")).resolves.toEqual({ text: RECORD_TEXT });
    await expect(spill.get("0:3")).resolves.toBeNull();
    expect(statSync(spill.paths[0] ?? "").mode & PERMISSION_BITS).toBe(OWNER_ONLY_FILE);
    await spill.close();
  });

  it("givenRotatingSpill_whenPastItsCap_thenDropsTheOldestSegment", async () => {
    const spill = new SpillFile<string>({
      budget: budget(),
      directory: join(root, "s"),
      segmentBytes: SMALL_SEGMENT,
      maxBytes: 3 * SMALL_SEGMENT,
      rotate: true,
    });
    for (let n = 0; n < 20; n += 1) await spill.put(String(n), RECORD_TEXT);

    await expect(spill.get("0")).resolves.toBeNull();
    await expect(spill.get("19")).resolves.toBe(RECORD_TEXT);
    expect(spill.bytes).toBeLessThanOrEqual(3 * SMALL_SEGMENT);
    expect(spill.paths.length).toBeLessThanOrEqual(3);
    await spill.close();
  });

  it("givenCappedSpill_whenPastItsCap_thenRejectsWithSpillFullAndKeepsWhatItHas", async () => {
    const spill = new SpillFile<string>({ budget: budget(), directory: join(root, "s"), maxBytes: SMALL_SEGMENT });
    await spill.put("a", RECORD_TEXT);
    await spill.put("b", RECORD_TEXT);

    await expect(spill.put("c", RECORD_TEXT)).rejects.toBeInstanceOf(SpillFull);
    await expect(spill.get("a")).resolves.toBe(RECORD_TEXT);
    await spill.close();
  });

  it("givenSharedBudget_whenTwoFilesFillIt_thenTheSecondIsRefusedUntilTheFirstCloses", async () => {
    const shared = budget({ totalBytes: SMALL_SEGMENT });
    const first = new SpillFile<string>({ budget: shared, directory: join(root, "s") });
    const second = new SpillFile<string>({ budget: shared, directory: join(root, "s") });
    await first.put("a", RECORD_TEXT);
    await second.put("a", RECORD_TEXT);

    await expect(second.put("b", RECORD_TEXT)).rejects.toBeInstanceOf(SpillFull);
    await first.close();
    await expect(second.put("b", RECORD_TEXT)).resolves.toBeUndefined();
    await second.close();
    expect(shared.used).toBe(0);
  });

  it("givenLowFreeSpace_whenASegmentOpens_thenRejectsWithSpillFull", async () => {
    const tight = new SpillBudget({ minFreeBytes: 2, freeSpace: () => Promise.resolve(1) });
    const spill = new SpillFile<string>({ budget: tight, directory: join(root, "s") });

    await expect(spill.put("a", RECORD_TEXT)).rejects.toBeInstanceOf(SpillFull);
    expect(tight.used).toBe(0);
    await spill.close();
  });

  it("givenRecords_whenClosed_thenDeletesItsFilesAndAnswersNull", async () => {
    const spill = new SpillFile<string>({ budget: budget(), directory: join(root, "s"), segmentBytes: SMALL_SEGMENT });
    for (let n = 0; n < 5; n += 1) await spill.put(String(n), RECORD_TEXT);
    const paths = spill.paths;
    expect(paths.length).toBeGreaterThan(1);

    await spill.close();

    expect(paths.some((path) => existsSync(path))).toBe(false);
    await expect(spill.get("1")).resolves.toBeNull();
  });
});

describe("sweepSpills", () => {
  it("givenFoldersOfDeadAndLivePids_whenSwept_thenRemovesOnlyTheDeadOnes", async () => {
    const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid ?? 0;
    const deadFolder = spillDirectory(root, dead);
    const liveFolder = spillDirectory(root, process.ppid);
    const ownFolder = spillDirectory(root);
    const other = join(root, "unrelated");
    for (const folder of [deadFolder, liveFolder, ownFolder, other]) mkdirSync(folder);

    const swept = await sweepSpills(root);

    expect(swept).toEqual([deadFolder]);
    expect([liveFolder, ownFolder, other].every((folder) => existsSync(folder))).toBe(true);
    removeSpillDirectory(ownFolder);
    expect(existsSync(ownFolder)).toBe(false);
  });
});
