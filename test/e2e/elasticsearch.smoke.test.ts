/**
 * Plan 165's live test: the Elasticsearch plugin's index tree, index tab and Dev Tools console
 * against the compose Elasticsearch, seeded by `elasticsearchLive.ts`. Gated, because it needs a
 * display, a fresh build and the server:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/165 TABLE_CRAFT_DATABASES=mysql,tidb,elasticsearch bun test/e2e/docker/headless.ts --databases test/e2e/elasticsearch.smoke.test.ts
 *
 * The seed owns the indices it names and deletes them after the run.
 */
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { OPENSEARCH_CONFIG, WITHOUT_ELASTICSEARCH } from "../support/databases.js";
import {
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  runAllButton,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  seedSettings,
  setWindowSize,
  sqlEditor,
  waitUntilReady,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import { AgentClient, freePort } from "./mcpAgent.js";
import {
  COFFEE_QUERY,
  dropLiveElasticsearch,
  LIVE_CATALOG,
  LIVE_LOG_ALIAS,
  LIVE_ORDERS,
  LIVE_PRODUCTS,
  liveElasticsearch,
  ORDER_COUNT,
  PRODUCT_COUNT,
  seedLiveElasticsearch,
  type LiveElasticsearch,
} from "./elasticsearchLive.js";
import { dialog, explorer } from "./redisLive.js";

const captureWindow = evidenceFor("165");

const SEED_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 30_000;
const LIVE_ID = "elasticsearch-live";
const LIVE_NAME = "Shop search";
const READ_ONLY_NAME = "Shop search (read-only)";
const ANALYZE_TEXT = "Crème brûlée to go";
/** The screen-reader suffix a dropped token carries after its text. */
const DROPPED_SUFFIX = " (dropped)";
const TEA_DSL = '{ "term": { "category": "tea" } }';
const BY_STATUS = `GET ${LIVE_ORDERS}/_search
{
  "size": 0,
  "aggs": { "by_status": { "terms": { "field": "status" } } }
}`;
const STATUS_SQL = `SELECT status, COUNT(*) AS orders FROM ${LIVE_ORDERS} GROUP BY status ORDER BY status`;
const WAIT = { timeout: READ_TIMEOUT_MS } as const;
/** A page expression, because this program has no DOM lib: the dialog has faded in fully. */
const DIALOG_SETTLED = `(() => {
  const open = document.querySelector('[role="dialog"]');
  return open !== null && getComputedStyle(open).opacity === '1';
})()`;

const ASK_ID = "elasticsearch-ask";
const ASK_NAME = "Shop search (agent asks)";
const AGENT_CLIENT = "Claude Code";
const TOKEN_PATTERN = /Bearer (tc_[\w-]+)/;
/** The agent's fixed window, well inside the newer log index's last hour. */
const WINDOW_END_AGO_MS = 10 * 60_000;
const WINDOW_SPAN_MS = 30 * 60_000;

const OPENSEARCH_ID = "opensearch-live";
const OPENSEARCH_NAME = "Shop search on OpenSearch";
const STATUS_PPL = `source=${LIVE_ORDERS} | stats count() as orders by status`;

let live: LiveElasticsearch | null = null;
let openSearch: LiveElasticsearch | null = null;
let running: RunningApp | null = null;

function seeded(): LiveElasticsearch {
  if (live === null) throw new Error("The Elasticsearch seed did not run; see beforeAll.");
  return live;
}

function liveConfig(server: LiveElasticsearch): Readonly<Record<string, string | number | boolean>> {
  return { host: server.host, port: server.port, authMode: "none", tlsMode: "disable" };
}

/** Launches on a saved datasource and connects it through a console, as a user's first run. */
async function launchSaved(name: string, readOnly = false, server: LiveElasticsearch = seeded()): Promise<Page> {
  const userDataDir = newProfile();
  const id = server === seeded() ? LIVE_ID : OPENSEARCH_ID;
  seedDatasources(userDataDir, [{ id, name, pluginId: "elasticsearch", readOnly, config: liveConfig(server) }]);
  running = await launchApp(null, { userDataDir });
  await setWindowSize(running.app, EVIDENCE_WINDOW);
  await openConsoleOn(running.page, name);
  await waitUntilReady(running.page);
  return running.page;
}

/** Launches with the MCP server on, as plan 156's live test does, and signs an agent in. */
async function launchServing(datasources: readonly SavedDatasource[]): Promise<{ page: Page; agent: AgentClient }> {
  const port = await freePort();
  const userDataDir = newProfile();
  seedDatasources(userDataDir, datasources);
  seedSettings(userDataDir, {
    version: 1,
    appearance: { motion: "off" },
    mcp: { enabled: true, port, rowCap: 100, clients: [{ name: AGENT_CLIENT, allowed: true }] },
  });
  running = await launchApp(null, { userDataDir });
  await setWindowSize(running.app, EVIDENCE_WINDOW);
  const { page, app } = running;
  await expect.poll(() => page.getByTestId("status-mcp").isVisible(), { timeout: LAUNCH_TIMEOUT_MS }).toBe(true);
  await findAction(page, "MCP Server Settings");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByTestId("mcp-copy-config").click();
  await expect.poll(() => settings.getByTestId("mcp-copy-config").textContent()).toBe("Copied");
  const token = TOKEN_PATTERN.exec(await app.evaluate(({ clipboard }) => clipboard.readText()))?.[1];
  if (token === undefined) throw new Error("The copied config holds no token.");
  await page.keyboard.press("Escape");
  const agent = new AgentClient(port, token);
  await agent.initialize(AGENT_CLIENT);
  return { page, agent };
}

function treeTarget(page: Page, kind: "index" | "alias", name: string): Locator {
  return explorer(page).locator(`[data-testid="index-${kind}"][data-name="${name}"]`);
}

async function openTarget(page: Page, kind: "index" | "alias", name: string): Promise<Locator> {
  const row = treeTarget(page, kind, name);
  await row.waitFor({ state: "visible", timeout: READ_TIMEOUT_MS });
  await row.dblclick();
  const tab = page.getByTestId("index-tab");
  await expect.poll(() => tab.getByTestId("index-header").textContent(), WAIT).toContain(name);
  return tab;
}

const hits = (tab: Locator) => expect.poll(() => tab.getByTestId("index-hits").textContent(), WAIT);

async function search(tab: Locator, query: string): Promise<void> {
  await tab.getByTestId("index-query").fill(query);
  await tab.getByTestId("index-query").press("Enter");
}

describe.runIf(DATABASES_ENABLED && !WITHOUT_ELASTICSEARCH)("Elasticsearch live test (plan 165)", () => {
  beforeAll(async () => {
    live = liveElasticsearch();
    openSearch = liveElasticsearch(OPENSEARCH_CONFIG);
    await Promise.all([seedLiveElasticsearch(live), seedLiveElasticsearch(openSearch)]);
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    await Promise.all([live, openSearch].flatMap((server) => (server === null ? [] : [dropLiveElasticsearch(server)])));
  }, SEED_TIMEOUT_MS);

  afterEach(async () => {
    if (running !== null) await closeApp(running.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenSeededCluster_whenConnected_thenTheTreeListsIndicesFamiliesAndAliases",
    async () => {
      const page = await launchSaved(LIVE_NAME);
      await treeTarget(page, "index", LIVE_PRODUCTS).waitFor(WAIT);
      await expect.poll(() => treeTarget(page, "alias", LIVE_CATALOG).count(), WAIT).toBe(1);
      await expect
        .poll(() => explorer(page).locator(`[data-testid="index-family"][data-name="${LIVE_LOG_ALIAS}"]`).count(), WAIT)
        .toBe(1);
      await expect.poll(() => page.getByText(/Elasticsearch 8\./).count(), WAIT).toBeGreaterThan(0);
      await captureWindow(page, "01-tree");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIndex_whenOpened_thenDocumentsSearchByLuceneAndDslWithTheRequestShown",
    async () => {
      const page = await launchSaved(LIVE_NAME);
      const tab = await openTarget(page, "index", LIVE_PRODUCTS);
      await hits(tab).toContain(`of ${PRODUCT_COUNT.toLocaleString("en-US")} hits`);
      await expect.poll(async () => (await gridText(page)).headers.join(" "), WAIT).toContain("_source");
      await captureWindow(page, "02-documents");

      await search(tab, COFFEE_QUERY);
      await hits(tab).not.toContain(`of ${PRODUCT_COUNT.toLocaleString("en-US")} hits`);
      const coffee = (await gridText(page)).cells;
      expect(coffee).toContain("coffee");
      expect(coffee).not.toContain("tea");
      await captureWindow(page, "03-lucene");

      await tab.getByTestId("index-request").click();
      const request = page.getByTestId("index-request-text");
      await expect.poll(() => request.textContent(), WAIT).toContain(`${LIVE_PRODUCTS}/_search`);
      expect(await request.textContent()).toContain("query_string");
      await captureWindow(page, "04-request");
      await page.keyboard.press("Escape");

      await chooseOption(tab.getByTestId("index-language"), "dsl");
      await search(tab, TEA_DSL);
      await expect.poll(async () => (await gridText(page)).cells.includes("coffee"), WAIT).toBe(false);
      expect((await gridText(page)).cells).toContain("tea");
      await captureWindow(page, "05-dsl");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIndex_whenMappingAndAnalyzeShown_thenMultiFieldsAndTheDroppedTokensRead",
    async () => {
      const page = await launchSaved(LIVE_NAME);
      const tab = await openTarget(page, "index", LIVE_PRODUCTS);
      await tab.getByRole("tab", { name: "Mapping" }).click();
      await tab.locator('[data-testid="index-field"][data-name="name.raw"]').waitFor(WAIT);
      expect(await tab.locator('[data-testid="index-field"][data-name="name.raw"]').textContent()).toContain(
        "multi-field",
      );
      await captureWindow(page, "06-mapping");

      await tab.getByRole("tab", { name: "Analyze" }).click();
      await chooseOption(tab.getByTestId("index-analyze-field"), "name");
      await tab.getByTestId("index-analyze-text").fill(ANALYZE_TEXT);
      await tab.getByTestId("index-analyze").click();
      await expect
        .poll(async () => {
          const texts = await tab.getByTestId("index-token-dropped").allTextContents();
          return texts.map((text) => text.replace(DROPPED_SUFFIX, ""));
        }, WAIT)
        .toEqual(expect.arrayContaining(["to", "go"]));
      expect(await tab.getByTestId("index-analysis-verdict").textContent()).toContain("never reach the index");
      const steps = await tab.getByTestId("index-analysis-step").count();
      expect(steps).toBeGreaterThan(2);
      await captureWindow(page, "07-analyze");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenTimeSeriesAlias_whenOpened_thenItSearchesTheTimeRangeWithAHistogram",
    async () => {
      const page = await launchSaved(LIVE_NAME);
      const tab = await openTarget(page, "alias", LIVE_LOG_ALIAS);
      await expect.poll(() => tab.getByTestId("index-header-facts").textContent(), WAIT).toContain("@timestamp");
      await hits(tab).toMatch(/hits?$/);
      await chooseOption(tab.getByTestId("index-range"), "1h");
      await tab.getByTestId("index-query").press("Enter");
      await tab.getByTestId("index-histogram").waitFor(WAIT);
      await hits(tab).toMatch(/of [\d,]+ hits/);
      await expect.poll(async () => (await gridText(page)).headers.join(" "), WAIT).toContain("_index");
      // The range menu closes over the strip, and a hovered bar would read as a spike.
      await tab.getByTestId("index-header").hover();
      await captureWindow(page, "08-time-range");

      await search(tab, "log.level:error");
      await expect
        .poll(async () => {
          const cells = (await gridText(page)).cells;
          return cells.includes("error") && !cells.includes("info");
        }, WAIT)
        .toBe(true);
      await captureWindow(page, "09-log-errors");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenConsole_whenRequestsRun_thenAggregationsSqlAndDestructiveConfirmShow",
    async () => {
      const page = await launchSaved(LIVE_NAME);
      await runStatement(page, BY_STATUS);
      await expect.poll(async () => (await gridText(page)).headers.join(" "), WAIT).toContain("doc_count");
      const counts = (await gridText(page)).cells.filter((cell) => /^\d+$/.test(cell)).map(Number);
      expect(counts.reduce((sum, value) => sum + value, 0)).toBe(ORDER_COUNT);
      await captureWindow(page, "10-console-aggregation");

      await runStatement(page, STATUS_SQL);
      await expect.poll(async () => (await gridText(page)).headers.join(" "), WAIT).toContain("orders");
      await captureWindow(page, "11-console-sql");

      await sqlEditor(page).click();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.insertText(`DELETE /${LIVE_ORDERS}`);
      await runAllButton(page).click();
      await dialog(page).waitFor(WAIT);
      await expect.poll(() => page.evaluate(DIALOG_SETTLED), WAIT).toBe(true);
      await expect.poll(() => dialog(page).textContent(), WAIT).toContain(LIVE_ORDERS);
      await captureWindow(page, "12-confirm-delete");
      await page.keyboard.press("Escape");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenReadOnlyDatasource_whenWriteRuns_thenItIsRefusedBeforeSending",
    async () => {
      const page = await launchSaved(READ_ONLY_NAME, true);
      await runStatement(page, `PUT /${LIVE_PRODUCTS}/_doc/SKU-NEW\n{ "name": "Mocha" }`);
      await expect.poll(() => consoleAlert(page).first().textContent(), WAIT).toContain("read-only");
      await captureWindow(page, "13-read-only");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );
  it(
    "givenAgent_whenOpenIndexThenCalledAgain_thenTheTabSearchesAndTheRequestChanges",
    async () => {
      const server = seeded();
      const { page, agent } = await launchServing([
        { id: LIVE_ID, name: LIVE_NAME, pluginId: "elasticsearch", agentAccess: "read", config: liveConfig(server) },
        { id: ASK_ID, name: ASK_NAME, pluginId: "elasticsearch", agentAccess: "askReads", config: liveConfig(server) },
      ]);

      const opened = await agent.tool("open_index", {
        datasource: LIVE_ID,
        index: LIVE_LOG_ALIAS,
        query: "log.level:error",
        sort: { field: "@timestamp" },
        range: "1h",
      });
      expect(opened.isError).toBe(false);
      expect(opened.structured?.["searched"]).toBe(true);
      const tab = page.getByTestId("index-tab");
      await expect.poll(() => tab.getByTestId("index-header").textContent(), WAIT).toContain(LIVE_LOG_ALIAS);
      await expect.poll(() => tab.getByTestId("index-query").inputValue(), WAIT).toBe("log.level:error");
      await hits(tab).toMatch(/of [\d,]+ hits/);
      await expect
        .poll(async () => {
          const cells = (await gridText(page)).cells;
          return cells.includes("error") && !cells.includes("info");
        }, WAIT)
        .toBe(true);
      expect(await tab.getByTestId("index-range").textContent()).toContain("Last hour");
      await tab.getByTestId("index-header").hover();
      await captureWindow(page, "16-agent-open-index");

      const to = new Date(Date.now() - WINDOW_END_AGO_MS);
      const from = new Date(to.getTime() - WINDOW_SPAN_MS);
      const edited = await agent.tool("open_index", {
        datasource: LIVE_ID,
        index: LIVE_LOG_ALIAS,
        query: "log.level:warn",
        from: from.toISOString(),
        to: to.toISOString(),
      });
      expect(edited.isError).toBe(false);
      expect(await page.getByTestId("index-tab").count()).toBe(1);
      await expect.poll(() => tab.getByTestId("index-query").inputValue(), WAIT).toBe("log.level:warn");
      await expect.poll(() => tab.getByTestId("index-range").textContent(), WAIT).toContain("UTC");
      await expect
        .poll(async () => {
          const cells = (await gridText(page)).cells;
          return cells.includes("warn") && !cells.includes("error");
        }, WAIT)
        .toBe(true);
      await tab.getByTestId("index-request").click();
      const request = page.getByTestId("index-request-text");
      await expect.poll(() => request.textContent(), WAIT).toContain(to.toISOString());
      await captureWindow(page, "17-agent-edits-request");
      await page.keyboard.press("Escape");

      const drafted = await agent.tool("open_index", { datasource: ASK_ID, index: LIVE_PRODUCTS, query: COFFEE_QUERY });
      expect(drafted.isError).toBe(false);
      expect(drafted.structured?.["searched"]).toBe(false);
      await expect.poll(() => page.getByTestId("index-header").last().textContent(), WAIT).toContain(LIVE_PRODUCTS);
      const askTab = page.getByTestId("index-tab").last();
      await expect.poll(() => askTab.getByTestId("index-query").inputValue(), WAIT).toBe(COFFEE_QUERY);
      await captureWindow(page, "18-agent-draft-only");

      const refused = await agent.tool("open_index", {
        datasource: LIVE_ID,
        index: LIVE_PRODUCTS,
        sort: { field: "name" },
      });
      expect(refused.isError).toBe(true);
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenOpenSearch_whenConnected_thenTheTreeDocumentsAndPplRead",
    async () => {
      if (openSearch === null) throw new Error("The OpenSearch seed did not run; see beforeAll.");
      const page = await launchSaved(OPENSEARCH_NAME, false, openSearch);
      await expect.poll(() => page.getByText(/OpenSearch 2\./).count(), WAIT).toBeGreaterThan(0);
      const tab = await openTarget(page, "index", LIVE_PRODUCTS);
      await hits(tab).toContain(`of ${PRODUCT_COUNT.toLocaleString("en-US")} hits`);
      await search(tab, COFFEE_QUERY);
      await expect.poll(async () => (await gridText(page)).cells.includes("tea"), WAIT).toBe(false);
      await captureWindow(page, "14-opensearch-documents");

      await page
        .getByRole("tab", { name: /^console/ })
        .first()
        .click();
      await runStatement(page, STATUS_PPL);
      await expect.poll(async () => (await gridText(page)).headers.join(" "), WAIT).toContain("orders");
      await captureWindow(page, "15-opensearch-ppl");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );
});
