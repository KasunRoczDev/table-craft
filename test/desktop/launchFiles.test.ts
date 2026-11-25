import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLaunchFiles, launchPathsOf } from "@table-craft/desktop/main/launchFiles.js";

const DESKTOP_ROOT = join(import.meta.dirname, "..", "..", "packages", "desktop");
const BUILDER_CONFIG = join(DESKTOP_ROOT, "electron-builder.yml");
/** `yaml` is the desktop package's own dependency, so it resolves from there, not from the root. */
const { parse } = createRequire(join(DESKTOP_ROOT, "package.json"))("yaml") as {
  readonly parse: (text: string) => unknown;
};
const PACKAGED = { defaultApp: false } as const;
const DEVELOPMENT = { defaultApp: true } as const;

let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "tc-launch-files-"));
});

afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function fileIn(name: string): Promise<string> {
  const path = join(folder, name);
  await writeFile(path, "select 1;\n");
  return path;
}

describe("launch paths", () => {
  it("givenPackagedArgvWithAbsoluteFile_whenParsed_thenReturnsThePath", async () => {
    const path = await fileIn("report.sql");

    expect(await launchPathsOf(["C:\\TableCraft\\TableCraft.exe", path], { ...PACKAGED, cwd: folder })).toEqual([path]);
  });

  it("givenDevelopmentArgv_whenParsed_thenSkipsTheEntryScript", async () => {
    const entry = await fileIn("main.js");
    const path = await fileIn("report.sql");

    expect(await launchPathsOf(["/electron", "--inspect=0", entry, path], { ...DEVELOPMENT, cwd: folder })).toEqual([
      path,
    ]);
  });

  it("givenRelativePath_whenParsed_thenResolvesAgainstTheWorkingDirectory", async () => {
    const path = await fileIn("report.sql");

    expect(await launchPathsOf(["/table-craft", "report.sql"], { ...PACKAGED, cwd: folder })).toEqual([path]);
  });

  it("givenFlagsAndProcessSerialNumber_whenParsed_thenSkipsThem", async () => {
    const path = await fileIn("report.sql");
    const argv = ["/TableCraft", "-psn_0_12345", "--use-mock-keychain", "--remote-debugging-port=0", path];

    expect(await launchPathsOf(argv, { ...PACKAGED, cwd: folder })).toEqual([path]);
  });

  it("givenDirectoryOrMissingPath_whenParsed_thenSkipsIt", async () => {
    const directory = join(folder, "scripts");
    await mkdir(directory);

    expect(
      await launchPathsOf(["/TableCraft", directory, join(folder, "gone.sql")], { ...PACKAGED, cwd: folder }),
    ).toEqual([]);
  });

  it("givenRepeatedPath_whenParsed_thenReturnsItOnce", async () => {
    const path = await fileIn("report.sql");

    expect(await launchPathsOf(["/TableCraft", path, "report.sql"], { ...PACKAGED, cwd: folder })).toEqual([path]);
  });
});

describe("launch files", () => {
  it("givenArrivalsBeforeTake_whenTaken_thenReturnsThemInOrder", () => {
    const pushed: (readonly string[])[] = [];
    const files = createLaunchFiles((paths) => pushed.push(paths) > 0);

    files.arrive(["/a.sql"]);
    files.arrive(["/b.sql", "/a.sql"]);

    expect(files.take()).toEqual(["/a.sql", "/b.sql"]);
    expect(files.take()).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("givenTaken_whenAPathArrives_thenPushesIt", () => {
    const pushed: (readonly string[])[] = [];
    const files = createLaunchFiles((paths) => pushed.push(paths) > 0);
    files.take();

    files.arrive(["/a.sql"]);

    expect(pushed).toEqual([["/a.sql"]]);
    expect(files.take()).toEqual([]);
  });

  it("givenNewWindowAfterTake_whenAPathArrives_thenQueuesUntilTheNextTake", () => {
    const pushed: (readonly string[])[] = [];
    const files = createLaunchFiles((paths) => pushed.push(paths) > 0);
    files.take();
    files.rendererLoading();

    files.arrive(["/a.sql"]);

    expect(pushed).toEqual([]);
    expect(files.take()).toEqual(["/a.sql"]);
  });

  it("givenNoWindowToPushTo_whenAPathArrives_thenHoldsItForTheNextWindow", () => {
    const files = createLaunchFiles(() => false);
    files.take();

    files.arrive(["/a.sql"]);

    expect(files.take()).toEqual(["/a.sql"]);
  });
});

interface BuilderConfig {
  readonly mac: { readonly extendInfo: { readonly CFBundleDocumentTypes: readonly Record<string, unknown>[] } };
  readonly nsis: { readonly include: string };
  readonly linux: { readonly fileAssociations: readonly Record<string, unknown>[] };
  readonly fileAssociations?: unknown;
}

describe("sql file association", () => {
  it("givenBuilderConfig_whenRead_thenSqlIsAnAlternateHandlerOnEveryPlatform", async () => {
    const config = parse(await readFile(BUILDER_CONFIG, "utf8")) as BuilderConfig;

    expect(config.fileAssociations).toBeUndefined();
    expect(config.mac.extendInfo.CFBundleDocumentTypes).toEqual([
      expect.objectContaining({
        CFBundleTypeRole: "Editor",
        LSHandlerRank: "Alternate",
        LSItemContentTypes: ["org.iso.sql"],
        CFBundleTypeExtensions: ["sql"],
      }),
    ]);
    expect(config.nsis.include).toBe("build/installer.nsh");
    expect(config.linux.fileAssociations).toEqual([
      expect.objectContaining({ ext: "sql", mimeType: "application/sql" }),
    ]);
  });
});
