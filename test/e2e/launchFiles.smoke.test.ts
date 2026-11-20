/**
 * Plan 163's live test: SQL files the OS asks TableCraft to open. A file named on the command line
 * (Windows Explorer and Linux file managers pass it so) opens as a file console beside the restored
 * layout, a second launch hands its file to the running window, and macOS's open-file event, which
 * Finder's Open With sends, does the same:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/163 bun run test:smoke:headless test/e2e/launchFiles.smoke.test.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeEditorTab,
  closeApp,
  editorTabs,
  EVIDENCE_WINDOW,
  evidenceFor,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  launchSecondInstance,
  runAllButton,
  SCENARIO_TIMEOUT_MS,
  setWindowSize,
  SMOKE_ENABLED,
  sqlEditor,
  type RunningApp,
} from "./harness.js";

const captureWindow = evidenceFor("163");

const MAC_PLATFORM = "darwin";
/** Bytes that start no UTF-8 sequence, so the file reads but cannot open as text. */
const NOT_UTF8 = Buffer.from([0xff, 0xfe, 0x00, 0x41]);

function editorText(page: Page): Promise<string> {
  return sqlEditor(page)
    .locator(".cm-line")
    .allTextContents()
    .then((lines) => lines.join("\n"));
}

function tabsNamed(page: Page, name: string) {
  return editorTabs(page).filter({ hasText: name });
}

async function expectActive(page: Page, name: string): Promise<void> {
  await expect.poll(() => activeEditorTab(page).getAttribute("title"), { timeout: LAUNCH_TIMEOUT_MS }).toContain(name);
}

describe.runIf(SMOKE_ENABLED)("open SQL files from the OS live test", () => {
  let running: RunningApp | null = null;
  const scratch: string[] = [];

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
    for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  function folder(): string {
    const directory = mkdtempSync(join(tmpdir(), "table-craft-launch-files-"));
    scratch.push(directory);
    return directory;
  }

  function file(directory: string, name: string, content: string | Buffer): string {
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  }

  async function launch(args: readonly string[], userDataDir?: string): Promise<RunningApp> {
    running = await launchApp(undefined, { args, ...(userDataDir === undefined ? {} : { userDataDir }) });
    await setWindowSize(running.app, EVIDENCE_WINDOW);
    return running;
  }

  it(
    "givenSqlFileOnTheCommandLine_whenTheAppStarts_thenItOpensAsAFileConsole",
    async () => {
      const path = file(folder(), "report.sql", "SELECT 41 AS answer;\n");
      const { page } = await launch([path]);

      await expectActive(page, "report.sql");
      await expect.poll(() => editorText(page)).toBe("SELECT 41 AS answer;\n");
      await runAllButton(page).click();
      await page.getByRole("columnheader", { name: /answer/ }).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await captureWindow(page, "02-cold-start-command-line");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenSavedLayout_whenLaunchedWithAFile_thenTheFileTabIsActiveBesideTheRestoredTabs",
    async () => {
      const directory = folder();
      const first = await launch([file(directory, "first.sql", "SELECT 1;\n")]);
      await expectActive(first.page, "first.sql");
      await closeApp(first.app);
      running = null;

      const second = await launch([file(directory, "second.sql", "SELECT 2;\n")], first.userDataDir);

      await expectActive(second.page, "second.sql");
      await expect.poll(() => tabsNamed(second.page, "first.sql").count()).toBe(1);
      await captureWindow(second.page, "03-beside-restored-layout");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRunningApp_whenASecondInstanceNamesAFile_thenTheFirstWindowOpensIt",
    async () => {
      const directory = folder();
      const current = await launch([]);
      await sqlEditor(current.page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      file(directory, "other.sql", "SELECT 'from a second launch' AS source;\n");

      const exitCode = await launchSecondInstance(current.userDataDir, { args: ["other.sql"], cwd: directory });

      expect(exitCode).toBe(0);
      await expectActive(current.page, "other.sql");
      await expect.poll(() => editorText(current.page)).toBe("SELECT 'from a second launch' AS source;\n");
      await captureWindow(current.page, "04-second-instance");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenFileAlreadyOpen_whenNamedAgain_thenItsTabIsFocusedNotDuplicated",
    async () => {
      const directory = folder();
      const path = file(directory, "again.sql", "SELECT 3;\n");
      const current = await launch([path]);
      await expectActive(current.page, "again.sql");
      await launchSecondInstance(current.userDataDir, { args: [file(directory, "other.sql", "SELECT 4;\n")] });
      await expectActive(current.page, "other.sql");

      await launchSecondInstance(current.userDataDir, { args: [path] });

      await expectActive(current.page, "again.sql");
      expect(await tabsNamed(current.page, "again.sql").count()).toBe(1);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenUnreadableFile_whenNamedOnTheCommandLine_thenANoticeSaysWhy",
    async () => {
      const path = file(folder(), "binary.sql", NOT_UTF8);
      const { page } = await launch([path]);

      const notice = page.getByRole("dialog", { name: "Could not open binary.sql" });
      await notice.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await expect(notice.textContent()).resolves.toContain("not UTF-8");
      await captureWindow(page, "05-unreadable-notice");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenRunningApp_whenTheOpenFileEventArrives_thenTheFileOpens",
    async () => {
      const current = await launch([]);
      await sqlEditor(current.page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const path = file(folder(), "finder.sql", "SELECT 'open with' AS source;\n");

      await current.app.evaluate(({ app }, opened) => {
        app.emit("open-file", { preventDefault: () => undefined }, opened);
      }, path);

      await expectActive(current.page, "finder.sql");
      await captureWindow(current.page, "06-open-file-event");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.runIf(process.platform === MAC_PLATFORM)(
    "givenNoWindowOpen_whenTheOpenFileEventArrives_thenANewWindowOpensTheFile",
    async () => {
      const current = await launch([]);
      await sqlEditor(current.page).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      const path = file(folder(), "dock.sql", "SELECT 'no window' AS source;\n");
      await current.app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
      });

      const reopened = current.app.waitForEvent("window");
      await current.app.evaluate(({ app }, opened) => {
        app.emit("open-file", { preventDefault: () => undefined }, opened);
      }, path);
      const page = await reopened;

      await expectActive(page, "dock.sql");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
