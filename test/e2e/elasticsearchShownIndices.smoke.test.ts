/**
 * Plan 169's live test: Manage Shown Indices on a saved Elasticsearch and OpenSearch datasource,
 * against the compose `elasticsearch` and `opensearch` services. Gated, because it needs a display,
 * a fresh build and the servers:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/169 bun run test:smoke:db:headless:elasticsearch test/e2e/elasticsearchShownIndices.smoke.test.ts
 *
 * Its indices and aliases start `tc_run_` and are deleted after the run; the datasource's Index
 * filter keeps the tree to them, so nothing else on the servers shows or is written.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ELASTICSEARCH_CONFIG,
  ELASTICSEARCH_SCRATCH_PREFIX,
  OPENSEARCH_CONFIG,
  WITHOUT_ELASTICSEARCH,
} from "../support/databases.js";
import {
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  launchApp,
  newProfile,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  treeNode,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { explorer } from "./redisLive.js";

const captureWindow = evidenceFor("169");

/** Playwright scrolls a clicked row's whole box into view and a tree row spans the widest one, so a click leaves the tree scrolled sideways. */
async function capture(page: Page, name: string): Promise<void> {
  await page
    .getByTestId("database-tree-scroll")
    .evaluate((element: { scrollLeft: number }) => (element.scrollLeft = 0));
  await captureWindow(page, name);
}

const SEED_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 30_000 } as const;
const RANDOM_BYTES = 3;
const DATASOURCES_FILE = "datasources.json";

interface Server {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

const serverOf = (id: string, name: string, address: { host: string; port: number }): Server => ({
  id,
  name,
  url: `http://${address.host}:${String(address.port)}`,
  host: address.host,
  port: address.port,
});

const ELASTICSEARCH = serverOf("elasticsearch-shown", "Search Shared", ELASTICSEARCH_CONFIG);
const OPENSEARCH = serverOf("opensearch-shown", "OpenSearch Shared", OPENSEARCH_CONFIG);

const prefix = `${ELASTICSEARCH_SCRATCH_PREFIX}${randomBytes(RANDOM_BYTES).toString("hex")}_`;
const ORDERS = `${prefix}orders`;
const ORDERS_FAMILY = `${ORDERS}-*`;
const WRITE_ALIAS = `${prefix}orders-write`;
const ORDERS_READ = `${prefix}orders-read`;
const ORDER_INDICES = [`${ORDERS}-000001`, `${ORDERS}-000002`] as const;
const ROLLED_OVER = `${ORDERS}-000003`;
const PRODUCTS = `${prefix}products`;
const AUDIT = `${prefix}audit`;
const LOOSE = [AUDIT, PRODUCTS] as const;
/** The dialog's entries: the orders family with its write alias folded in, the read alias, two loose indices. */
const ENTRY_COUNT = 4;

let running: RunningApp | null = null;

async function send(server: Server, method: string, path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`${method} ${path} answered ${String(response.status)}: ${await response.text()}`);
}

async function seed(server: Server): Promise<void> {
  for (const index of [...ORDER_INDICES, ...LOOSE]) await send(server, "PUT", `/${index}`);
  await send(server, "POST", "/_aliases", {
    actions: [
      { add: { index: ORDER_INDICES[0], alias: WRITE_ALIAS, is_write_index: false } },
      { add: { index: ORDER_INDICES[1], alias: WRITE_ALIAS, is_write_index: true } },
      { add: { indices: [...ORDER_INDICES], alias: ORDERS_READ } },
    ],
  });
}

async function drop(server: Server): Promise<void> {
  await send(server, "DELETE", `/${prefix}*`).catch(() => undefined);
}

function saved(server: Server): SavedDatasource {
  return {
    id: server.id,
    name: server.name,
    pluginId: "elasticsearch",
    config: { host: server.host, port: server.port, authMode: "none", tlsMode: "disable", indexFilter: `${prefix}*` },
  };
}

async function names(page: Page, testId: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const row of await explorer(page).locator(`[data-testid="${testId}"]`).all())
    found.push((await row.getAttribute("data-name")) ?? "");
  return found.sort();
}

async function treeTargets(page: Page) {
  return {
    families: await names(page, "index-family"),
    indices: await names(page, "index-index"),
    aliases: await names(page, "index-alias"),
  };
}

async function launchOn(userDataDir: string, server: Server): Promise<Page> {
  running = await launchApp(null, { userDataDir });
  await setWindowSize(running.app, EVIDENCE_WINDOW);
  const { page } = running;
  await treeNode(page, server.name).click();
  await page.keyboard.press("ArrowRight");
  return page;
}

function shownDialog(page: Page, server: Server): Locator {
  return page.getByRole("dialog", { name: `Manage Shown Indices — ${server.name}` });
}

function familyNode(page: Page): Locator {
  return explorer(page).locator(`[data-testid="index-family"][data-name="${ORDERS}"]`);
}

async function openFromMenu(page: Page, server: Server, row: Locator): Promise<Locator> {
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Manage Shown Indices/ }).click();
  const dialog = shownDialog(page, server);
  await dialog.waitFor(WAIT);
  return dialog;
}

function storedShownIndices(userDataDir: string, server: Server): unknown {
  const file = JSON.parse(readFileSync(join(userDataDir, DATASOURCES_FILE), "utf8")) as {
    datasources: readonly { id: string; shownIndices?: unknown }[];
  };
  return file.datasources.find((each) => each.id === server.id)?.shownIndices;
}

function shownText(page: Page, server: Server) {
  return treeNode(page, server.name).getByTestId("shown-namespaces");
}

function eventually<T>(read: () => Promise<T>) {
  return expect.poll(read, WAIT);
}

describe.runIf(DATABASES_ENABLED && !WITHOUT_ELASTICSEARCH)("Manage Shown Indices live test (plan 169)", () => {
  beforeAll(async () => {
    await Promise.all([seed(ELASTICSEARCH), seed(OPENSEARCH)]);
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([drop(ELASTICSEARCH), drop(OPENSEARCH)]);
  }, SEED_TIMEOUT_MS);

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenSavedElasticsearch_whenFamilyAndReadAliasPicked_thenTreeKeepsThemThroughARolloverAndARestart",
    async () => {
      const server = ELASTICSEARCH;
      const profile = newProfile();
      seedDatasources(profile, [saved(server)]);
      let page = await launchOn(profile, server);
      await eventually(() => treeTargets(page)).toEqual({
        families: [ORDERS],
        indices: [...LOOSE],
        aliases: [ORDERS_READ, WRITE_ALIAS],
      });

      await treeNode(page, server.name).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Manage Shown Indices/ }).waitFor(WAIT);
      await capture(page, "01-datasource-menu");
      await page.getByRole("menuitem", { name: /^Manage Shown Indices/ }).click();
      let dialog = shownDialog(page, server);
      await dialog.waitFor(WAIT);
      await eventually(() => dialog.getByTestId("shown-schemas-count").textContent()).toBe(
        `All ${String(ENTRY_COUNT)} shown`,
      );
      const familyRow = dialog.getByRole("listitem").filter({ hasText: ORDERS_FAMILY });
      await expect(familyRow.textContent()).resolves.toContain(`alias ${WRITE_ALIAS}`);
      await expect(dialog.getByRole("checkbox", { name: WRITE_ALIAS, exact: true }).count()).resolves.toBe(0);
      await expect(familyRow.textContent()).resolves.toContain("2 indices");
      await capture(page, "02-dialog-all");

      await dialog.getByRole("checkbox", { name: "All indices", exact: true }).uncheck();
      for (const name of LOOSE) await dialog.getByRole("checkbox", { name, exact: true }).uncheck();
      const search = dialog.getByLabel("Search indices", { exact: true });
      const listed = dialog.getByRole("list", { name: "Indices" }).getByRole("checkbox");
      await search.fill("write");
      await eventually(() => listed.count()).toBe(1);
      await expect(dialog.getByRole("checkbox", { name: ORDERS_FAMILY, exact: true }).count()).resolves.toBe(1);
      await capture(page, "03-dialog-search-alias");
      await search.fill("");
      await eventually(() => dialog.getByTestId("shown-schemas-count").textContent()).toBe(
        `2 of ${String(ENTRY_COUNT)} shown`,
      );
      await capture(page, "04-dialog-picked");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await eventually(() => treeTargets(page)).toEqual({
        families: [ORDERS],
        indices: [],
        aliases: [ORDERS_READ, WRITE_ALIAS],
      });
      await eventually(() => shownText(page, server).textContent()).toBe(`2 of ${String(ENTRY_COUNT)}`);
      expect(storedShownIndices(profile, server)).toEqual([ORDERS_FAMILY, ORDERS_READ]);
      await capture(page, "05-tree-filtered");

      await send(server, "POST", `/${WRITE_ALIAS}/_rollover/${ROLLED_OVER}`, {});
      await treeNode(page, server.name).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Synchronize/ }).click();
      await eventually(() => familyNode(page).textContent()).toContain("3 indices");
      await eventually(() => treeTargets(page)).toEqual({
        families: [ORDERS],
        indices: [],
        aliases: [ORDERS_READ, WRITE_ALIAS],
      });
      await capture(page, "06-after-rollover");

      await closeApp(running?.app);
      running = null;
      page = await launchOn(profile, server);
      await eventually(() => treeTargets(page)).toEqual({
        families: [ORDERS],
        indices: [],
        aliases: [ORDERS_READ, WRITE_ALIAS],
      });
      await eventually(() => shownText(page, server).textContent()).toBe(`2 of ${String(ENTRY_COUNT)}`);
      await capture(page, "07-after-restart");

      dialog = await openFromMenu(page, server, familyNode(page));
      await dialog.getByRole("checkbox", { name: "All indices", exact: true }).check();
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await eventually(() => treeTargets(page)).toEqual({
        families: [ORDERS],
        indices: [...LOOSE],
        aliases: [ORDERS_READ, WRITE_ALIAS],
      });
      await eventually(() => shownText(page, server).count()).toBe(0);
      expect(storedShownIndices(profile, server)).toBeUndefined();
      await capture(page, "08-all-indices-again");
    },
    SCENARIO_TIMEOUT_MS * 3,
  );

  it(
    "givenSavedOpenSearch_whenOneLooseIndexPicked_thenTreeListsOnlyIt",
    async () => {
      const server = OPENSEARCH;
      const profile = newProfile();
      seedDatasources(profile, [saved(server)]);
      const page = await launchOn(profile, server);
      await eventually(() => treeTargets(page)).toEqual({
        families: [ORDERS],
        indices: [...LOOSE],
        aliases: [ORDERS_READ, WRITE_ALIAS],
      });
      const products = explorer(page).locator(`[data-testid="index-index"][data-name="${PRODUCTS}"]`);
      const dialog = await openFromMenu(page, server, products);
      await dialog.getByRole("checkbox", { name: "All indices", exact: true }).uncheck();
      await dialog.getByRole("button", { name: "Select None", exact: true }).click();
      await dialog.getByRole("checkbox", { name: PRODUCTS, exact: true }).check();
      await eventually(() => dialog.getByTestId("shown-schemas-count").textContent()).toBe(
        `1 of ${String(ENTRY_COUNT)} shown`,
      );
      await capture(page, "09-opensearch-dialog");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await eventually(() => treeTargets(page)).toEqual({ families: [], indices: [PRODUCTS], aliases: [] });
      await eventually(() => shownText(page, server).textContent()).toBe(`1 of ${String(ENTRY_COUNT)}`);
      expect(storedShownIndices(profile, server)).toEqual([PRODUCTS]);
      await capture(page, "10-opensearch-tree");
    },
    SCENARIO_TIMEOUT_MS * 2,
  );

  it(
    "givenEphemeralElasticsearch_whenDatasourceMenuOpened_thenNoManageShownIndices",
    async () => {
      const server = ELASTICSEARCH;
      running = await launchApp({
        id: "elasticsearch-ephemeral",
        pluginId: "elasticsearch",
        config: saved(server).config,
      });
      await setWindowSize(running.app, EVIDENCE_WINDOW);
      const { page } = running;
      const row = explorer(page).locator('[data-kind="datasource"]').first();
      await row.waitFor(WAIT);
      await row.click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Synchronize/ }).waitFor(WAIT);
      await expect(page.getByRole("menuitem", { name: /^Manage Shown Indices/ }).count()).resolves.toBe(0);
      await capture(page, "11-ephemeral-menu");
      await page.keyboard.press("Escape");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
