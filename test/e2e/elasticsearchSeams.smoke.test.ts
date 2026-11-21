/**
 * Plan 166's live test: a cluster past 200 indices with a rolled-over and a monthly family, the
 * tree's filter row, and a gateway in front of the compose Elasticsearch that refuses `GET /`, the
 * node info and some searches, as a cluster with per-index permissions does. Gated, because it
 * needs a display, a fresh build and the server:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/166 TABLE_CRAFT_DATABASES=mysql,tidb,elasticsearch bun test/e2e/docker/headless.ts --databases test/e2e/elasticsearchSeams.smoke.test.ts
 *
 * The seed owns the indices and the index template it names and deletes them after the run.
 */
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WITHOUT_ELASTICSEARCH } from "../support/databases.js";
import {
  chooseOption,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  DATABASES_ENABLED,
  EVIDENCE_WINDOW,
  evidenceFor,
  evidenceTextFor,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  waitUntilReady,
  type RunningApp,
} from "./harness.js";
import { liveElasticsearch, type LiveElasticsearch } from "./elasticsearchLive.js";
import { explorer } from "./redisLive.js";

const captureWindow = evidenceFor("166");
const writeEvidence = evidenceTextFor("166");

const SEED_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 30_000;
const WAIT = { timeout: READ_TIMEOUT_MS } as const;
const LOOPBACK = "127.0.0.1";
const HTTP_FORBIDDEN = 403;
const HTTP_GATEWAY_TIMEOUT = 504;
const DELETE_BATCH = 40;
const WIDEN_DATABASE_PX = 200;

const TEMPLATE = "tc-plan-166";
/** Above the built-in `logs-*-*` data stream template (priority 100), so these stay plain indices. */
const TEMPLATE_PRIORITY = 500;
const ROLLOVER_FAMILY = "logs-checkout";
const ROLLOVER_COUNT = 196;
const MONTHLY_FAMILY = "logs-billing";
const MONTHLY = ["2026-09", "2026-10"] as const;
const MONTHLY_SEGMENTS = 3;
/** Every search and `_analyze` on it is refused at the gateway. */
const DENIED_INDEX = "orders-archive";
/** Its documents search; only its histogram is refused. */
const UNCHARTED_INDEX = "orders-recent";
const RECENT_DOCS = 40;
const RECENT_SPAN_MS = 10 * 60_000;

const DIRECT_NAME = "Log cluster";
const GATEWAY_NAME = "Log cluster behind a gateway";

function rolloverIndices(): string[] {
  return Array.from({ length: ROLLOVER_COUNT }, (_, at) => `${ROLLOVER_FAMILY}-${String(at + 1).padStart(6, "0")}`);
}

function monthlyIndices(): string[] {
  return MONTHLY.flatMap((month) =>
    Array.from(
      { length: MONTHLY_SEGMENTS },
      (_, at) => `${MONTHLY_FAMILY}-${month}-${String(at + 1).padStart(4, "0")}`,
    ),
  );
}

const SEEDED = [...rolloverIndices(), ...monthlyIndices(), DENIED_INDEX, UNCHARTED_INDEX];

async function send(live: LiveElasticsearch, method: string, path: string, body?: string, ndjson = false) {
  const response = await fetch(`${live.url}${path}`, {
    method,
    headers: { "Content-Type": ndjson ? "application/x-ndjson" : "application/json" },
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  if (!response.ok && response.status !== 404)
    throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return text;
}

async function dropSeams(live: LiveElasticsearch): Promise<void> {
  for (let at = 0; at < SEEDED.length; at += DELETE_BATCH)
    await send(live, "DELETE", `/${SEEDED.slice(at, at + DELETE_BATCH).join(",")}?ignore_unavailable=true`);
  await send(live, "DELETE", `/_index_template/${TEMPLATE}`);
}

/** One document per index, so the bulk request creates them all through the template. */
async function seedSeams(live: LiveElasticsearch, now: number = Date.now()): Promise<void> {
  await dropSeams(live);
  await send(
    live,
    "PUT",
    `/_index_template/${TEMPLATE}`,
    JSON.stringify({
      index_patterns: [`${ROLLOVER_FAMILY}-*`, `${MONTHLY_FAMILY}-*`, DENIED_INDEX, UNCHARTED_INDEX],
      priority: TEMPLATE_PRIORITY,
      template: {
        settings: { number_of_shards: 1, number_of_replicas: 0 },
        mappings: { properties: { "@timestamp": { type: "date" }, note: { type: "text" } } },
      },
    }),
  );
  const documents = SEEDED.flatMap((index) =>
    Array.from({ length: index === UNCHARTED_INDEX ? RECENT_DOCS : 1 }, (_, at) => ({
      index,
      source: {
        "@timestamp": new Date(now - Math.round((at / RECENT_DOCS) * RECENT_SPAN_MS)).toISOString(),
        note: `Order ${String(at + 1)} shipped to go`,
      },
    })),
  );
  const bulk = documents
    .map(({ index, source }) => `${JSON.stringify({ index: { _index: index } })}\n${JSON.stringify(source)}\n`)
    .join("");
  const text = await send(live, "POST", "/_bulk?refresh=true", bulk, true);
  if ((JSON.parse(text) as { errors?: boolean }).errors === true)
    throw new Error(`The plan 166 seed's bulk request reported item errors: ${text.slice(0, 600)}`);
}

function securityError(action: string, privileges: string, index: string): string {
  const reason =
    `action [${action}] is unauthorized for user [reader] with effective roles [reader] on indices [${index}], ` +
    `this action is granted by the index privileges [${privileges}]`;
  const cause = { type: "security_exception", reason };
  return JSON.stringify({ error: { root_cause: [cause], ...cause }, status: HTTP_FORBIDDEN });
}

interface Refusal {
  readonly status: number;
  readonly body: string;
}

/** What the gateway refuses, as a cluster with per-index permissions behind a proxy does. */
function refusalOf(method: string, path: string, body: string): Refusal | null {
  const route = path.split("?")[0] ?? "";
  if (method === "GET" && route === "/") return { status: HTTP_GATEWAY_TIMEOUT, body: "upstream timed out" };
  if (route.startsWith("/_nodes"))
    return { status: HTTP_FORBIDDEN, body: securityError("cluster:monitor/nodes/info", "monitor,manage,all", "-") };
  if (route.startsWith(`/${DENIED_INDEX}/_search`))
    return { status: HTTP_FORBIDDEN, body: securityError("indices:data/read/search", "read,all", DENIED_INDEX) };
  if (route.startsWith(`/${DENIED_INDEX}/_analyze`))
    return { status: HTTP_FORBIDDEN, body: securityError("indices:admin/analyze", "manage,all", DENIED_INDEX) };
  if (route.startsWith(`/${UNCHARTED_INDEX}/_search`) && body.includes("date_histogram"))
    return { status: HTTP_FORBIDDEN, body: securityError("indices:data/read/search", "read,all", UNCHARTED_INDEX) };
  return null;
}

interface Gateway {
  readonly server: Server;
  readonly port: number;
  readonly log: string[];
}

function forward(live: LiveElasticsearch, incoming: IncomingMessage, body: Buffer, reply: ServerResponse): void {
  const upstream = request(
    { host: live.host, port: live.port, method: incoming.method, path: incoming.url, headers: incoming.headers },
    (answer) => {
      reply.writeHead(answer.statusCode ?? HTTP_GATEWAY_TIMEOUT, answer.headers);
      answer.pipe(reply);
    },
  );
  upstream.on("error", () => reply.writeHead(HTTP_GATEWAY_TIMEOUT).end());
  upstream.end(body);
}

async function startGateway(live: LiveElasticsearch): Promise<Gateway> {
  const log: string[] = [];
  const server = createServer((incoming, reply) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const method = incoming.method ?? "GET";
      const path = incoming.url ?? "/";
      const refusal = refusalOf(method, path, body.toString("utf8"));
      log.push(`${method} ${path} -> ${refusal === null ? "forwarded" : String(refusal.status)}`);
      if (refusal === null) return forward(live, incoming, body, reply);
      reply.writeHead(refusal.status, { "Content-Type": "application/json" }).end(refusal.body);
    });
  });
  await new Promise<void>((done) => server.listen(0, LOOPBACK, done));
  return { server, port: (server.address() as AddressInfo).port, log };
}

let live: LiveElasticsearch | null = null;
let gateway: Gateway | null = null;
let running: RunningApp | null = null;

function seeded(): LiveElasticsearch {
  if (live === null) throw new Error("The plan 166 seed did not run; see beforeAll.");
  return live;
}

function opened(): Gateway {
  if (gateway === null) throw new Error("The gateway did not start; see beforeAll.");
  return gateway;
}

async function launchOn(name: string, host: string, port: number): Promise<Page> {
  const userDataDir = newProfile();
  const config = { host, port, authMode: "none", tlsMode: "disable" };
  seedDatasources(userDataDir, [{ id: "plan-166", name, pluginId: "elasticsearch", readOnly: true, config }]);
  running = await launchApp(null, { userDataDir });
  await setWindowSize(running.app, EVIDENCE_WINDOW);
  await openConsoleOn(running.page, name);
  await waitUntilReady(running.page);
  await widenDatabase(running.page);
  return running.page;
}

/** Widens the Database tool window, so the evidence shows whole index names and the filter. */
async function widenDatabase(page: Page): Promise<void> {
  const handle = await page.getByRole("separator").first().boundingBox();
  if (handle === null) throw new Error("The Database tool window is not laid out.");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + WIDEN_DATABASE_PX, y, { steps: 10 });
  await page.mouse.up();
}

const filterInput = (page: Page) => explorer(page).getByTestId("index-filter");
const filterCount = (page: Page) =>
  expect.poll(() => explorer(page).getByTestId("index-filter-count").textContent(), WAIT);
const family = (page: Page, base: string) =>
  explorer(page).locator(`[data-testid="index-family"][data-name="${base}"]`);
const indexRow = (page: Page, name: string) =>
  explorer(page).locator(`[data-testid="index-index"][data-name="${name}"]`);

async function filterTree(page: Page, text: string): Promise<void> {
  await filterInput(page).fill(text);
}

async function openIndex(page: Page, name: string): Promise<Locator> {
  await filterTree(page, name);
  const row = indexRow(page, name);
  await row.waitFor({ state: "visible", timeout: READ_TIMEOUT_MS });
  await row.dblclick();
  const tab = page.getByTestId("index-tab");
  await expect.poll(() => tab.getByTestId("index-header").textContent(), WAIT).toContain(name);
  return tab;
}

describe.runIf(DATABASES_ENABLED && !WITHOUT_ELASTICSEARCH)("Elasticsearch seams live test (plan 166)", () => {
  beforeAll(async () => {
    live = liveElasticsearch();
    await seedSeams(live);
    gateway = await startGateway(live);
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    if (gateway !== null) await new Promise((done) => gateway?.server.close(done));
    if (live !== null) await dropSeams(live);
  }, SEED_TIMEOUT_MS);

  afterEach(async () => {
    if (running !== null) await closeApp(running.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it(
    "givenClusterPast200Indices_whenConnected_thenTheFilterRowCountsAndTheMonthlyFamilyGroups",
    async () => {
      const page = await launchOn(DIRECT_NAME, seeded().host, seeded().port);
      await filterInput(page).waitFor(WAIT);
      await filterCount(page).toMatch(/^[\d,]+ of [\d,]+$/);
      const [shown, total = 0] = ((await explorer(page).getByTestId("index-filter-count").textContent()) ?? "")
        .split(" of ")
        .map((part) => Number(part.replaceAll(",", "")));
      expect(shown).toBe(total);
      expect(total).toBeGreaterThanOrEqual(SEEDED.length);
      await family(page, ROLLOVER_FAMILY).waitFor(WAIT);
      await family(page, MONTHLY_FAMILY).waitFor(WAIT);
      await captureWindow(page, "01-filter-row");

      await family(page, MONTHLY_FAMILY).click();
      if ((await family(page, MONTHLY_FAMILY).getAttribute("aria-expanded")) !== "true")
        await page.keyboard.press("ArrowRight");
      const newest = `${MONTHLY_FAMILY}-2026-10-0003`;
      await indexRow(page, newest).waitFor(WAIT);
      await captureWindow(page, "02-monthly-family");

      await filterTree(page, "billing-2026-10");
      await filterCount(page).toMatch(new RegExp(`^${String(MONTHLY_SEGMENTS)} of `));
      await indexRow(page, `${MONTHLY_FAMILY}-2026-10-0001`).waitFor(WAIT);
      expect(await indexRow(page, `${MONTHLY_FAMILY}-2026-09-0001`).count()).toBe(0);
      await captureWindow(page, "03-filter-matches");

      await filterTree(page, "billing*0001");
      await filterCount(page).toMatch(/^2 of /);
      await indexRow(page, `${MONTHLY_FAMILY}-2026-09-0001`).waitFor(WAIT);
      await captureWindow(page, "04-filter-wildcard");

      await filterInput(page).press("Escape");
      await filterCount(page).toMatch(new RegExp(`^${total.toLocaleString("en-US")} of `));
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenGatewayRefusingTheRoot_whenConnected_thenTheVersionComesFromTheNodeList",
    async () => {
      const page = await launchOn(GATEWAY_NAME, LOOPBACK, opened().port);
      await filterInput(page).waitFor(WAIT);
      await expect.poll(() => page.getByText(/Elasticsearch 8\./).count(), WAIT).toBeGreaterThan(0);
      const log = opened().log;
      expect(log).toContain(`GET / -> ${String(HTTP_GATEWAY_TIMEOUT)}`);
      expect(log.some((line) => line.startsWith("GET /_cat/nodes") && line.endsWith("forwarded"))).toBe(true);
      await captureWindow(page, "05-probe-fallback");
      writeEvidence("05-gateway-log.txt", `${log.join("\n")}\n`);
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenIndexWithoutReadPrivilege_whenOpened_thenEachViewSaysWhichPrivilegeIsMissing",
    async () => {
      const page = await launchOn(GATEWAY_NAME, LOOPBACK, opened().port);
      await filterInput(page).waitFor(WAIT);
      const tab = await openIndex(page, DENIED_INDEX);
      await expect.poll(() => tab.getByTestId("query-error").textContent(), WAIT).toContain("indices:data/read/search");
      expect(await tab.getByTestId("index-error").count()).toBe(0);
      await captureWindow(page, "06-search-refused");

      await tab.getByRole("tab", { name: "Analyze" }).click();
      await chooseOption(tab.getByTestId("index-analyze-field"), "note");
      await tab.getByTestId("index-analyze-text").fill("Shipped to go");
      await tab.getByTestId("index-analyze").click();
      await expect
        .poll(() => tab.getByTestId("index-analyze-error").textContent(), WAIT)
        .toContain("indices:admin/analyze");
      await captureWindow(page, "07-analyze-refused");

      await tab.getByRole("tab", { name: "Mapping" }).click();
      await tab.locator('[data-testid="index-field"][data-name="note"]').waitFor(WAIT);
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );

  it(
    "givenHistogramRefused_whenIndexOpened_thenTheHitsStandUnderTheMessage",
    async () => {
      const page = await launchOn(GATEWAY_NAME, LOOPBACK, opened().port);
      await filterInput(page).waitFor(WAIT);
      const recent = await openIndex(page, UNCHARTED_INDEX);
      await expect
        .poll(() => recent.getByTestId("histogram-error").textContent(), WAIT)
        .toContain("indices:data/read/search");
      await expect.poll(() => recent.getByTestId("index-hits").textContent(), WAIT).toMatch(/of [\d,]+ hits?/);
      expect((await gridText(page)).cells.length).toBeGreaterThan(0);
      await captureWindow(page, "08-histogram-refused");
    },
    LAUNCH_TIMEOUT_MS + SCENARIO_TIMEOUT_MS,
  );
});
