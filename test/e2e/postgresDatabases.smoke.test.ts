/**
 * PostgreSQL discovery against the existing table_craft and postgres databases; no database writes.
 * Run against a fresh app build and the already-running PostgreSQL fixture (PowerShell):
 * $env:TABLE_CRAFT_SMOKE='1'; $env:TABLE_CRAFT_DATABASES='postgres'; $env:TABLE_CRAFT_PG_PORT='55532'
 * $env:TABLE_CRAFT_EVIDENCE_DIR='docs/evidence/pg-fix'
 * bun run test test/e2e/postgresDatabases.smoke.test.ts
 */
import { afterEach, describe, expect, it } from "vitest";
import { databaseEnabled, POSTGRES_CONFIG } from "../support/databases.js";
import {
  answerSecretPrompt,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  editorTabs,
  findAction,
  EVIDENCE_WINDOW,
  evidenceFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  readProfileFile,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  SMOKE_ENABLED,
  treeNode,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";

const SOURCE_NAME = "Postgres discovery";
const SIBLING_DATABASE = "postgres";
const SIBLING_NAME = `${SOURCE_NAME} / ${SIBLING_DATABASE}`;
const SESSION_MARKER = "original-session";
const SESSION_VALUE =
  "current_database() || ':' || pg_backend_pid()::text || ':' || " +
  "COALESCE(current_setting('tablecraft.smoke_database', true), 'unset')";
const captureWindow = evidenceFor("pg-fix");

describe.runIf(SMOKE_ENABLED && databaseEnabled("postgres"))("PostgreSQL database discovery", () => {
  let running: RunningApp | null = null;

  afterEach(async () => {
    const current = running;
    running = null;
    await closeApp(current?.app);
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenConnectedPostgres_whenDiscoveredSiblingIsQueried_thenDatabaseAndOriginalSessionStayIndependent",
    async () => {
      const userDataDir = newProfile();
      const { password, ...config } = POSTGRES_CONFIG;
      seedDatasources(userDataDir, [
        {
          id: "pg-discovery",
          name: SOURCE_NAME,
          pluginId: "postgres",
          config,
          secretModes: { password: "untilRestart" },
        },
      ]);
      running = await launchApp(null, { userDataDir });
      const { app, page } = running;
      await setWindowSize(app, EVIDENCE_WINDOW);
      await openConsoleOn(page, SOURCE_NAME);
      await answerSecretPrompt(page, SOURCE_NAME, password);
      await waitUntilReady(page);

      // Discovery belongs to the original connection's Manage Shown Schemas picker.
      await treeNode(page, SIBLING_DATABASE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      expect(await treeNode(page, SOURCE_NAME).count()).toBe(1);
      expect(await treeNode(page, SIBLING_NAME).count()).toBe(0);
      await treeNode(page, SOURCE_NAME).click();
      await findAction(page, "Manage Shown Schemas");
      const dialog = page.getByRole("dialog", { name: `Manage Shown Databases — ${SOURCE_NAME}` });
      expect(await dialog.getByRole("checkbox", { name: SIBLING_DATABASE }).isChecked()).toBe(true);
      await dialog.getByRole("checkbox", { name: "All databases" }).uncheck();
      await dialog.getByRole("checkbox", { name: SIBLING_DATABASE }).uncheck();
      await dialog.getByRole("button", { name: "OK" }).click();
      await expect.poll(() => treeNode(page, SIBLING_DATABASE).count()).toBe(0);
      await treeNode(page, SOURCE_NAME).click();
      await findAction(page, "Manage Shown Schemas");
      const reopened = page.getByRole("dialog", { name: `Manage Shown Databases — ${SOURCE_NAME}` });
      await reopened.getByRole("checkbox", { name: SIBLING_DATABASE }).check();
      await reopened.getByRole("button", { name: "OK" }).click();
      await treeNode(page, SIBLING_DATABASE).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await runStatement(page, `SELECT set_config('tablecraft.smoke_database', '${SESSION_MARKER}', false)`);
      await runStatement(page, `SELECT ${SESSION_VALUE} AS original_session`);
      await expect
        .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([expect.stringMatching(/^table_craft:\d+:original-session$/)]);
      const [originalSession] = (await gridText(page)).cells;
      expect(originalSession).toBeDefined();

      await openConsoleOn(page, SIBLING_DATABASE);
      await expect.poll(() => editorTabs(page).count(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(2);
      await waitUntilReady(page);
      await runStatement(page, `SELECT ${SESSION_VALUE} AS sibling_session`);
      await expect
        .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([expect.stringMatching(/^postgres:\d+:unset$/)]);
      const [siblingSession] = (await gridText(page)).cells;
      expect(siblingSession?.split(":")[1]).not.toBe(originalSession?.split(":")[1]);
      expect(await editorTabs(page).count()).toBe(2);
      await captureWindow(page, "postgres-databases-sibling-query");

      await editorTabs(page)
        .filter({ hasText: `console [${SOURCE_NAME}]` })
        .click();
      await waitUntilReady(page);
      await runStatement(page, `SELECT ${SESSION_VALUE} || ':after' AS original_after`);
      await expect
        .poll(async () => (await gridText(page)).cells, { timeout: LAUNCH_TIMEOUT_MS })
        .toEqual([`${originalSession}:after`]);
      await expect.poll(() => treeNode(page, SOURCE_NAME).getAttribute("data-state")).toBe("connected");
      await expect.poll(() => treeNode(page, SIBLING_DATABASE).count()).toBe(1);

      const saved = JSON.parse(readProfileFile(userDataDir, "datasources.json") ?? "null") as {
        datasources: { id: string; name: string; config: { database: string } }[];
      };
      expect(saved.datasources.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: "pg-discovery", name: SOURCE_NAME },
      ]);
      expect(saved.datasources[0]?.config.database).toBe(POSTGRES_CONFIG.database);
      await captureWindow(page, "postgres-databases-original-session");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
