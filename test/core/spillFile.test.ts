import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SpillBudget,
  SpillFailed,
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
const OWNER_ONLY_FOLDER = 0o700;
const GROUP_READABLE_FOLDER = 0o750;

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
    expect(spill.closed).toBe(true);
  });

  it.skipIf(process.getuid === undefined)(
    "givenFolderOpenToOtherUsers_whenASegmentOpens_thenRejectsWithSpillFailed",
    async () => {
      const shared = join(root, "s");
      mkdirSync(shared);
      chmodSync(shared, GROUP_READABLE_FOLDER);
      const spill = new SpillFile<string>({ budget: budget(), directory: shared });

      await expect(spill.put("a", RECORD_TEXT)).rejects.toBeInstanceOf(SpillFailed);
      expect(readdirSync(shared)).toEqual([]);
      await spill.close();
    },
  );

  it("givenLinkInPlaceOfTheFolder_whenASegmentOpens_thenRejectsWithSpillFailedAndWritesNothing", async () => {
    const target = join(root, "elsewhere");
    mkdirSync(target, { mode: OWNER_ONLY_FOLDER });
    symlinkSync(target, join(root, "s"));
    const spill = new SpillFile<string>({ budget: budget(), directory: join(root, "s") });

    await expect(spill.put("a", RECORD_TEXT)).rejects.toBeInstanceOf(SpillFailed);
    await expect(spill.put("b", RECORD_TEXT)).rejects.toBeInstanceOf(SpillFailed);
    expect(readdirSync(target)).toEqual([]);
    await spill.close();
  });

  it("givenFolderThatIsAFile_whenPut_thenRejectsWithSpillFailedAndGivesTheBudgetBack", async () => {
    const shared = budget();
    writeFileSync(join(root, "s"), "");
    const spill = new SpillFile<string>({ budget: shared, directory: join(root, "s") });

    await expect(spill.put("a", RECORD_TEXT)).rejects.toBeInstanceOf(SpillFailed);
    expect(shared.used).toBe(0);
    await spill.close();
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

  it("givenLinkNamedLikeADeadSpill_whenSwept_thenLeavesItAndItsTargetAlone", async () => {
    const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid ?? 0;
    const target = join(root, "kept");
    mkdirSync(target);
    writeFileSync(join(target, "data"), "kept");
    symlinkSync(target, spillDirectory(root, dead));

    const swept = await sweepSpills(root);

    expect(swept).toEqual([]);
    expect(existsSync(join(target, "data"))).toBe(true);
  });
});
