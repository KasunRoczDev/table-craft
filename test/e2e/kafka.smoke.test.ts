/**
 * Plan 164's live test: the Kafka plugin's views against the Kafka the run names (the remote cluster
 * of `TABLE_CRAFT_KAFKA_REMOTE_BOOTSTRAP` in `.env`, else the compose broker) and a Schema Registry
 * mock in this process. Gated, because it needs a display, a fresh build and a broker:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/164 TABLE_CRAFT_DATABASES=mysql,tidb,kafka bun test/e2e/docker/headless.ts --databases test/e2e/kafka.smoke.test.ts
 *
 * Every topic and group it makes starts `tc_run_` (`kafkaLive.ts`) and is deleted after the run,
 * even when a scenario fails; nothing else on the cluster is written.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KAFKA_SCRATCH_PREFIX, kafkaRemoteBootstrap, WITHOUT_KAFKA } from "../support/databases.js";
import {
  chooseOption,
  chooseTheme,
  CLOSE_HOOK_TIMEOUT_MS,
  closeApp,
  consoleAlert,
  DATABASES_ENABLED,
  dataSourcesDialog,
  datasourceStatus,
  EVIDENCE_WINDOW,
  evidenceFor,
  fillNewDatasource,
  findAction,
  gridText,
  LAUNCH_TIMEOUT_MS,
  launchApp,
  newProfile,
  openConsoleOn,
  pressChord,
  runAllButton,
  runStatement,
  SCENARIO_TIMEOUT_MS,
  seedDatasources,
  setWindowSize,
  sqlEditor,
  testConnection,
  themePickerTrigger,
  waitUntilReady,
  type Datasource,
  type LaunchOptions,
  type RunningApp,
  type SavedDatasource,
} from "./harness.js";
import {
  BILLING_COMMITTED,
  EARLY_KEY,
  HOT_CUSTOMER,
  LIVE_LAG_WARNING,
  ORDER_SCHEMA_BROKEN,
  ORDER_SPACING_S,
  ORDERS_PARTITIONS,
  ORDERS_PER_PARTITION,
  seedLiveKafka,
  type LiveKafka,
} from "./kafkaLive.js";
import { dialog, explorer, treeRows } from "./redisLive.js";

const captureWindow = evidenceFor("164");

const SEED_TIMEOUT_MS = 120_000;
const LONG_SCENARIO_MS = SCENARIO_TIMEOUT_MS * 3;
const READ_TIMEOUT_MS = 30_000;
const LIVE_ID = "kafka-live";
const PRODUCTION_NAME = "Kafka Production";
const READ_ONLY_NAME = "Kafka Read-only";
const UNREACHABLE_BOOTSTRAP = "127.0.0.1:59095";
const NARROW_WINDOW = { width: 1024, height: 768 } as const;
const TAIL_BURST = 2000;
/** Above the tail ring's TOPIC_TAIL_MAX_MESSAGES, so the ring drops what the pane has not read. */
const TAIL_OVERFLOW = 120_000;
const TAIL_OVERFLOW_BATCH = 2000;
const MATCHES_NOTHING = "matches-no-message";
const BULK_RECORDS = 150_000;
const VIETNAM_ZONE = "Asia/Ho_Chi_Minh";

const WAIT = { timeout: READ_TIMEOUT_MS } as const;
const PROBE = { timeout: 1000 } as const;
const SPEED_SEARCH_WAIT_MS = 2000;

function eventually<T>(read: () => Promise<T>) {
  return expect.poll(read, WAIT);
}

const text = (locator: Locator) => eventually(async () => (await locator.allTextContents()).join(" "));
const count = (locator: Locator) => eventually(() => locator.count());
const attr = (locator: Locator, name: string) =>
  eventually(() =>
    locator
      .first()
      .getAttribute(name, PROBE)
      .catch(() => null),
  );
const disabled = (locator: Locator) =>
  eventually(() =>
    locator
      .first()
      .isDisabled(PROBE)
      .catch(() => null),
  );

async function shown(locator: Locator, timeout: number = READ_TIMEOUT_MS): Promise<void> {
  await locator.first().waitFor({ state: "visible", timeout });
}

/** Wholly inside the window, so it is reachable without scrolling the bar sideways. */
async function inViewport(locator: Locator): Promise<void> {
  await shown(locator);
  const box = await locator.first().boundingBox();
  const width = await locator.page().evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth);
  expect(box).not.toBeNull();
  if (box === null) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

let live: LiveKafka | null = null;
let running: RunningApp | null = null;

function seeded(): LiveKafka {
  if (live === null) throw new Error("The Kafka seed did not run; see beforeAll.");
  return live;
}

function liveConfig(kafka: LiveKafka): Readonly<Record<string, string | number | boolean>> {
  return {
    bootstrapServers: kafka.bootstrapServers,
    security: "PLAINTEXT",
    registryUrl: kafka.registry.url,
    lagWarning: LIVE_LAG_WARNING,
    nameFilter: `${KAFKA_SCRATCH_PREFIX}*`,
  };
}

function liveDatasource(config: Readonly<Record<string, string | number | boolean>>): Datasource {
  return { id: LIVE_ID, pluginId: "kafka", config };
}

async function launch(
  datasource: Datasource | null,
  options: LaunchOptions & { readonly size?: { width: number; height: number }; readonly ready?: boolean } = {},
): Promise<Page> {
  running = await launchApp(datasource, options);
  await setWindowSize(running.app, options.size ?? EVIDENCE_WINDOW);
  if (datasource !== null && options.ready !== false) await waitUntilReady(running.page);
  return running.page;
}

/** Launches on a saved Kafka datasource, coloured or read-only, and connects it through a console. */
async function launchSaved(saved: Omit<SavedDatasource, "pluginId" | "config">): Promise<Page> {
  const userDataDir = newProfile();
  seedDatasources(userDataDir, [{ ...saved, pluginId: "kafka", config: liveConfig(seeded()) }]);
  const page = await launch(null, { userDataDir });
  await openConsoleOn(page, saved.name);
  await waitUntilReady(page);
  return page;
}

async function setTheme(page: Page, name: string): Promise<void> {
  await pressChord(page, ",");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor();
  await settings.getByRole("tab", { name: "Appearance", exact: true }).click();
  await themePickerTrigger(page).waitFor();
  await chooseTheme(page, name);
  await settings.getByRole("button", { name: "Close", exact: true }).click();
  await count(settings).toBe(0);
}

function streamRow(page: Page, kind: string, name: string): Locator {
  return explorer(page).locator(`[data-testid="stream-${kind}"][data-name=${JSON.stringify(name)}]`);
}

/**
 * Selects a topic, group or subject row by speed search: the tree lists the whole cluster. Speed
 * search matches as it is typed, so a row listed after the typing (a topic just created) needs the
 * name typed again.
 */
async function selectStreamRow(page: Page, kind: string, name: string): Promise<Locator> {
  const section = treeRows(page, "streamSection").first();
  await section.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
  const row = streamRow(page, kind, name);
  await expect
    .poll(async () => {
      await section.click();
      await scrollTreeHome(page);
      await page.keyboard.type(name);
      const selected = await row
        .and(page.locator('[aria-selected="true"]'))
        .waitFor({ timeout: SPEED_SEARCH_WAIT_MS })
        .then(() => true)
        .catch(() => false);
      if (!selected) await page.keyboard.press("Escape");
      return selected;
    }, WAIT)
    .toBe(true);
  await page.keyboard.press("Enter");
  return row;
}

/**
 * Playwright scrolls a clicked row's whole box into view, and a tree row spans the widest row, so a
 * click leaves the tree scrolled sideways; the app's own focus moves must not.
 */
async function scrollTreeHome(page: Page): Promise<void> {
  await page
    .getByTestId("database-tree-scroll")
    .evaluate((element: { scrollLeft: number }) => (element.scrollLeft = 0));
}

/** Waits out the window's finite animations (a dialog's entrance), so a capture does not catch them half way. */
const SETTLED_SCRIPT =
  "Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished)).then(() => true)";

async function settled(page: Page): Promise<void> {
  await page.evaluate(SETTLED_SCRIPT);
}

/**
 * Evidence is published with the pull request, so a remote cluster's addresses become `broker-N`,
 * and the private address a member connects from `client-host`, for the capture only.
 */
const MASK_SCRIPT = `(hosts) => {
  const originals = new Map();
  const swap = (text) =>
    hosts
      .reduce((out, host, i) => out.split(host).join("broker-" + (i + 1)), text)
      .replace(/\\b(?:10(?:\\.\\d{1,3}){3}|(?:192\\.168|172\\.(?:1[6-9]|2\\d|3[01]))(?:\\.\\d{1,3}){2})\\b/g, "client-host");
  const maskText = (node) => {
    const entry = originals.get(node);
    if (entry && entry[2] === node.data) return;
    const next = swap(node.data);
    if (next === node.data) { originals.delete(node); return; }
    originals.set(node, ["data", node.data, next]);
    node.data = next;
  };
  const maskTree = (root) => {
    if (root.nodeType === Node.TEXT_NODE) return maskText(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) maskText(node);
  };
  maskTree(document.body);
  for (const field of document.querySelectorAll("input, textarea")) {
    const next = swap(field.value);
    if (next !== field.value) { originals.set(field, ["value", field.value, next]); field.value = next; }
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") maskText(record.target);
      else for (const added of record.addedNodes) maskTree(added);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  window.__evidenceMask = { originals, observer };
  return true;
}`;

/** Gives a redraw started before the mask time to land, so the observer masks it before the capture. */
const MASK_SETTLE_SCRIPT =
  "new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))";

const UNMASK_SCRIPT = `(() => {
  const mask = window.__evidenceMask;
  if (!mask) return true;
  mask.observer.disconnect();
  for (const [target, [key, value, masked]] of mask.originals) if (target[key] === masked) target[key] = value;
  window.__evidenceMask = null;
  return true;
})()`;

function remoteHosts(): string[] {
  const bootstrap = kafkaRemoteBootstrap();
  if (bootstrap === null) return [];
  return bootstrap
    .split(",")
    .map((broker) => broker.trim().replace(/:\d+$/, ""))
    .filter((host) => host.length > 0);
}

async function capture(page: Page, name: string): Promise<void> {
  await settled(page);
  const hosts = remoteHosts();
  if (hosts.length === 0) {
    await captureWindow(page, name);
    return;
  }
  await page.evaluate(`(${MASK_SCRIPT})(${JSON.stringify(hosts)})`);
  try {
    await page.evaluate(MASK_SETTLE_SCRIPT);
    await captureWindow(page, name);
  } finally {
    await page.evaluate(UNMASK_SCRIPT);
  }
}

async function openStreamRow(page: Page, kind: string, name: string): Promise<void> {
  await selectStreamRow(page, kind, name);
  await page.keyboard.press("Enter");
}

function topicTab(page: Page): Locator {
  return page.getByTestId("topic-tab").filter({ visible: true });
}

function groupTab(page: Page): Locator {
  return page.getByTestId("group-tab").filter({ visible: true });
}

async function openTopic(page: Page, topic: string): Promise<Locator> {
  await openStreamRow(page, "topic", topic);
  const tab = topicTab(page);
  await text(tab.getByTestId("topic-scanned")).toContain("Scanned");
  return tab;
}

async function openGroup(page: Page, group: string): Promise<Locator> {
  await openStreamRow(page, "consumerGroup", group);
  const tab = groupTab(page);
  await shown(tab.getByTestId("lag-row").first());
  return tab;
}

/** Reads again with the read bar as it stands, and waits for the new footer. */
async function read(tab: Locator): Promise<void> {
  await tab.getByTestId("topic-read").click();
  await shown(tab.getByTestId("topic-read"));
  await text(tab.getByTestId("topic-scanned")).toContain("Scanned");
}

async function fillCode(scope: Locator, testId: string, text: string): Promise<void> {
  await scope.getByTestId(testId).locator(".cm-content").fill(text);
}

/** `2026-11-21T09:15:00.000Z` of the seeded order `index`. */
function orderInstant(kafka: LiveKafka, index: number): string {
  return new Date(kafka.ordersStart + index * ORDER_SPACING_S * 1000).toISOString();
}

describe.runIf(DATABASES_ENABLED)("Kafka live test (plan 164)", () => {
  beforeAll(async () => {
    if (WITHOUT_KAFKA) return;
    live = await seedLiveKafka();
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    await live?.drop();
    live = null;
  }, SEED_TIMEOUT_MS);

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it.skipIf(WITHOUT_KAFKA)(
    "givenNewKafkaDatasource_whenSecurityIsSaslSsl_thenSaslFieldsShowAndNoSshTunnel (01; SASL and TLS shown as form fields only)",
    async () => {
      const kafka = seeded();
      const page = await launch(null);
      await fillNewDatasource(page, {
        kind: "Apache Kafka",
        name: "Live Kafka",
        fields: { "Bootstrap servers": kafka.bootstrapServers },
      });
      const form = dataSourcesDialog(page);
      await count(form.getByLabel("Username", { exact: true })).toBe(0);
      await count(form.getByText("Use SSH tunnel")).toBe(0);
      await chooseOption(form.getByLabel("Security", { exact: true }), "SASL_SSL");
      await shown(form.getByLabel("Username", { exact: true }));
      await shown(form.getByLabel("Password", { exact: true }));
      await shown(form.getByLabel("SASL mechanism", { exact: true }));
      await capture(page, "01-form");
      await chooseOption(form.getByLabel("Security", { exact: true }), "PLAINTEXT");
      await count(form.getByLabel("Username", { exact: true })).toBe(0);
      const outcome = await testConnection(page);
      expect(outcome.ok, outcome.text).toBe(true);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenSeededCluster_whenTreeOpens_thenTopicsGroupsWithLagBrokersAndSubjectsShow (02)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const orders = await selectStreamRow(page, "topic", kafka.orders);
      await text(orders).toContain(`${String(ORDERS_PARTITIONS)} partitions`);
      await text(orders).toContain(`${String(ORDERS_PARTITIONS * ORDERS_PER_PARTITION)} messages`);
      const subject = await selectStreamRow(page, "subject", kafka.orderSubject);
      await text(subject).toContain("v2 · Avro");
      const billing = await selectStreamRow(page, "consumerGroup", kafka.billing);
      await attr(billing.getByTestId("group-lag"), "data-lagging").toBe("true");
      await text(billing).toContain("lagging");
      await text(datasourceStatus(page)).toContain("broker");
      await text(datasourceStatus(page)).toContain("Schema Registry");
      const sideways = page.getByTestId("database-tree-scroll");
      expect(await sideways.evaluate((element: { scrollLeft: number }) => element.scrollLeft)).toBe(0);
      await capture(page, "02-tree");
      // The shared cluster's topics and groups push the brokers past the virtualized window.
      await page.keyboard.press("Home");
      for (const name of ["topics", "groups"]) {
        const section = streamRow(page, "streamSection", name);
        await section.click();
        await page.keyboard.press("ArrowLeft");
        await attr(section, "aria-expanded").toBe("false");
      }
      await count(treeRows(page, "broker")).toBeGreaterThan(0);
      await scrollTreeHome(page);
      await capture(page, "02-tree-brokers");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenAvroOrders_whenReadLatestFilteredAndFromTimestamp_thenDecodedRowsAndPartitionStrip (03)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openTopic(page, kafka.orders);
      const all = ORDERS_PARTITIONS * ORDERS_PER_PARTITION;
      await text(tab.getByTestId("topic-scanned")).toContain(`${String(all)} rows`);
      expect((await gridText(page)).cells.join(" ")).toContain('"customer"');
      await count(tab.getByTestId("partition-cell")).toBe(ORDERS_PARTITIONS);

      await tab.getByTestId("read-filter").fill(HOT_CUSTOMER);
      await read(tab);
      await text(tab.getByTestId("topic-scanned")).toContain("matched in the newest 500 of each partition");
      const hot = (await gridText(page)).cells.filter((cell) => cell === HOT_CUSTOMER).length;
      expect(hot).toBeGreaterThan(0);

      await tab.getByTestId("read-filter").fill("");
      await chooseOption(tab.getByTestId("read-from"), "timestamp");
      const half = all / 2;
      await tab.getByTestId("read-timestamp").fill(orderInstant(kafka, half));
      await read(tab);
      await text(tab.getByTestId("topic-scanned")).toContain(`${String(all - half)} rows`);
      await tab.locator('[data-testid="partition-cell"][data-partition="1"]').click();
      await attr(tab.locator('[data-testid="partition-cell"][data-partition="1"]'), "aria-pressed").toBe("true");
      await capture(page, "03-messages");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenTopic_whenRetentionEditedThenResetToDefault_thenConfigsViewFollows (04)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openTopic(page, kafka.orders);
      await tab.getByTestId("view-partitions").click();
      await shown(tab.getByRole("row").filter({ hasText: "in sync" }).or(tab.getByRole("row").nth(1)));
      await tab.getByTestId("view-configs").click();
      const retentionRow = (scope: Locator) =>
        scope.getByRole("row").filter({ has: page.getByText("retention.ms", { exact: true }) });
      const retention = () => retentionRow(tab);
      await shown(retention());

      await tab.getByTestId("topic-edit-configs").click();
      const edit = page.getByTestId("edit-configs-dialog");
      await edit.getByTestId("configs-search").fill("retention.ms");
      await retentionRow(edit).getByRole("button", { name: "Edit" }).click();
      await edit.getByLabel("retention.ms", { exact: true }).fill("3600000");
      await text(edit.getByTestId("configs-changes")).toContain("retention.ms");
      await text(edit.getByTestId("edit-configs-apply")).toBe("Apply 1 Change");
      await capture(page, "04-configs");
      await edit.getByTestId("edit-configs-apply").click();
      await count(edit).toBe(0);
      await text(retention()).toMatch(/1 h|3,?600,?000/);

      await tab.getByTestId("topic-edit-configs").click();
      await edit.getByTestId("configs-search").fill("retention.ms");
      await retentionRow(edit).getByRole("button", { name: "Reset to Default" }).click();
      await text(edit.getByTestId("configs-changes")).toContain("default");
      await edit.getByTestId("edit-configs-apply").click();
      await count(edit).toBe(0);
      await text(retention()).not.toMatch(/1 h|3,?600,?000/);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenAvroSubject_whenProduced_thenInvalidValueRefusedAndValidRowAppears (05)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openTopic(page, kafka.orders);
      await tab.getByTestId("topic-produce").click();
      const produce = page.getByTestId("produce-dialog");
      await text(produce.getByTestId("produce-value-schema")).toContain(kafka.orderSubject);
      await text(produce.getByTestId("produce-value-schema")).toContain("Avro");
      await produce.getByTestId("produce-key").fill("cust-live");
      await fillCode(produce, "produce-value", JSON.stringify({ id: "bad" }));
      await produce.getByTestId("produce-send").click();
      await shown(produce.getByTestId("produce-error"));
      await fillCode(
        produce,
        "produce-value",
        JSON.stringify({ id: "o-live", customer: "cust-live", amount: 9.5, note: "from the live test" }),
      );
      await produce.getByTestId("produce-send").click();
      await shown(produce.getByTestId("produce-sent"));
      await capture(page, "05-produce");
      await produce.getByRole("button", { name: "Close", exact: true }).click();
      await count(produce).toBe(0);
      await tab.getByTestId("read-filter").fill("cust-live");
      await read(tab);
      await text(tab.getByTestId("topic-scanned")).toContain("1 matched");
      expect((await gridText(page)).cells.join(" ")).toContain("o-live");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenLaggingGroup_whenResetToTimestamp_thenPreviewNamesSkipsAndActiveGroupIsRefused (06)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openGroup(page, kafka.billing);
      await text(tab.getByTestId("group-state")).toContain("Empty");
      await count(tab.getByTestId("lag-row")).toBe(ORDERS_PARTITIONS);
      await attr(tab.locator('[data-testid="lag-row"][data-partition="0"]'), "data-hot").toBe("true");
      await shown(tab.getByTestId("lag-ruler").first());

      await tab.getByTestId("group-reset").click();
      const reset = page.getByTestId("reset-dialog");
      const target = 10;
      await reset.getByTestId("reset-value").fill(orderInstant(kafka, ORDERS_PARTITIONS * target));
      await shown(reset.getByTestId("reset-preview"));
      const apply = reset.getByTestId("reset-apply");
      await text(apply).toContain(`Skip ${String(target - BILLING_COMMITTED[0])}`);
      await attr(apply, "data-variant").toBe("warning");
      await capture(page, "06-reset");
      await reset.getByRole("button", { name: "Cancel", exact: true }).click();

      const active = await openGroup(page, kafka.active);
      await active.getByTestId("group-reset").click();
      await text(reset.getByTestId("reset-refusal")).toContain("moves offsets only while a group has none");
      await shown(reset.getByTestId("reset-members"));
      await reset.getByTestId("reset-kind").locator('label[data-value="earliest"]').click();
      await text(reset.getByTestId("reset-refusal")).toContain("Stop the group's consumers first");
      await disabled(apply).toBe(true);
      await capture(page, "06-reset-refused");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenAdmin_whenTopicCreatedGrownPreviewedAndDeleted_thenEachStepConfirms (07)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      await findAction(page, "Create Topic…");
      const create = page.getByTestId("create-topic-dialog");
      await create.getByTestId("create-topic-name").fill(kafka.created);
      await create.getByLabel("Partitions", { exact: true }).fill("1");
      await create.getByTestId("create-topic-apply").click();
      await count(create).toBe(0);

      const tab = await openTopic(page, kafka.created);
      await tab.getByTestId("view-partitions").click();
      await findAction(page, "Add Partitions…");
      const grow = page.getByTestId("add-partitions-dialog");
      await text(grow).toContain("land on another partition");
      await grow.getByTestId("add-partitions-total").fill("2");
      await capture(page, "07-admin");
      await grow.getByTestId("add-partitions-apply").click();
      await count(grow).toBe(0);

      await findAction(page, "Delete Topic…");
      const confirm = dialog(page);
      await text(confirm).toContain(kafka.created);
      const remove = confirm.getByRole("button", { name: "Delete Topic", exact: true });
      await disabled(remove).toBe(true);
      await confirm.getByLabel(`Type ${kafka.created} to confirm`).fill(kafka.created);
      await capture(page, "07-delete-topic");
      await remove.click();
      await count(topicTab(page)).toBe(0);

      const purge = await openTopic(page, kafka.purge);
      await purge.getByTestId("view-partitions").click();
      await purge.getByTestId("topic-delete-records").click();
      const records = page.getByTestId("delete-records-dialog");
      await records.getByTestId("delete-boundary").fill("3");
      await records.getByRole("button", { name: "Preview", exact: true }).click();
      await shown(records.getByTestId("delete-records-preview"));
      await disabled(records.getByTestId("delete-records-apply")).toBe(true);
      await capture(page, "07-delete-records");
      await records.getByRole("button", { name: "Cancel", exact: true }).click();
    },
    LONG_SCENARIO_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenSubjectWithTwoVersions_whenIncompatibleSchemaChecked_thenRegistryRefusesIt (08; no version diff view)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      await openStreamRow(page, "subject", kafka.orderSubject);
      const tab = page.getByTestId("subject-tab").filter({ visible: true });
      const versions = tab.getByTestId("subject-versions").getByRole("button");
      await count(versions).toBe(2);
      await text(tab.getByTestId("subject-schema")).toContain("note");
      await versions.filter({ hasText: "Version 1" }).click();
      await text(tab.getByTestId("subject-schema")).not.toContain("note");
      await tab.getByTestId("subject-check").click();
      const check = page.getByTestId("schema-dialog");
      await fillCode(check, "schema-text", JSON.stringify(ORDER_SCHEMA_BROKEN, null, 2));
      await check.getByRole("button", { name: "Check", exact: true }).click();
      await text(check.getByTestId("schema-verdict")).toContain("Not compatible");
      await capture(page, "08-schemas");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenConsole_whenConsumeLagResetDryRunAndDeleteTopic_thenRowsAndDeleteAsksTheName (09)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      await runStatement(page, `consume ${kafka.orders} --from -5`);
      expect((await gridText(page)).headers.join(" ")).toContain("value");
      await runStatement(page, `lag ${kafka.billing}`);
      expect((await gridText(page)).headers.join(" ").toLowerCase()).toContain("lag");
      await runStatement(page, `reset-offsets ${kafka.billing} ${kafka.orders} --to earliest --dry-run`);
      expect((await gridText(page)).cells.join(" ")).toContain(String(BILLING_COMMITTED[2]));
      await capture(page, "09-console");
      await sqlEditor(page).fill(`delete-topic ${kafka.history}`);
      await runAllButton(page).click();
      const confirm = dialog(page);
      await text(confirm).toContain(kafka.history);
      await capture(page, "09-console-delete-topic");
      await page.keyboard.press("Escape");
      await count(confirm).toBe(0);
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenLiveTail_whenPausedFilteredAndTheRingOverflows_thenGapRowShows (10)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      await openTopic(page, kafka.events);
      await findAction(page, "Tail Topic");
      const pane = page.getByTestId("tail-pane");
      await shown(pane);
      await text(pane.getByTestId("tail-status")).toContain("Live");
      await kafka.produce(
        kafka.events,
        [1, 2, 3].map((n) => ({ partition: 0, key: `tail-${String(n)}`, value: JSON.stringify({ n }) })),
      );
      await count(pane.getByTestId("tail-row")).toBe(3);
      await pane.getByTestId("tail-filter").fill("tail-2");
      await count(pane.getByTestId("tail-row")).toBe(1);
      await pane.getByTestId("tail-filter").fill("");
      await pane.getByTestId("tail-pause").click();
      await kafka.produce(kafka.events, [{ partition: 0, key: "tail-4", value: "{}" }]);
      await text(pane.getByTestId("tail-status")).toContain("Paused");
      await pane.getByTestId("tail-pause").click();

      await kafka.produce(
        kafka.events,
        Array.from({ length: TAIL_OVERFLOW }, (_, n) => ({ partition: 0, key: `burst-${String(n)}`, value: "{}" })),
        TAIL_OVERFLOW_BATCH,
      );
      await text(pane.getByTestId("tail-status")).toContain("dropped");
      // The pane keeps its newest rows only, so freeze them while the gap is still among them.
      await pane.getByTestId("tail-pause").click();
      await pane.getByTestId("tail-filter").fill(MATCHES_NOTHING);
      await shown(pane.getByTestId("tail-gap").first());
      await capture(page, "10-tail");
    },
    LONG_SCENARIO_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenReadOnlyDatasource_whenProduceAndAdminAsked_thenRefusedWithTheReasonOnHover (11, 20)",
    async () => {
      const kafka = seeded();
      const page = await launchSaved({ id: "kafka-read-only", name: READ_ONLY_NAME, readOnly: true });
      await sqlEditor(page).fill(`produce ${kafka.orders} "{}" --key nope`);
      await runAllButton(page).click();
      await text(consoleAlert(page)).toMatch(/read-only/i);
      await capture(page, "11-readonly");
      const tab = await openTopic(page, kafka.orders);
      const produce = tab.getByTestId("topic-produce");
      await disabled(produce).toBe(true);
      await attr(produce, "title").toBe("The data source is read-only.");
      await tab.getByTestId("view-configs").click();
      await disabled(tab.getByTestId("topic-edit-configs")).toBe(true);
      await tab.getByTestId("view-messages").click();
      await produce.hover({ force: true });
      await capture(page, "20-readonly-reason");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenUnreachableBroker_whenConnecting_thenTheErrorNamesTheBroker (12; an unreachable bootstrap stands in for an advertised listener)",
    async () => {
      const kafka = seeded();
      const failed = await launch(
        liveDatasource({ ...liveConfig(kafka), bootstrapServers: UNREACHABLE_BOOTSTRAP, requestTimeout: 5 }),
        { ready: false },
      );
      const errorRow = explorer(failed).locator('[data-kind="error"]');
      await shown(errorRow.or(consoleAlert(failed)).first(), READ_TIMEOUT_MS * 2);
      await expect
        .poll(async () =>
          [...(await errorRow.allTextContents()), ...(await consoleAlert(failed).allTextContents())].join(" "),
        )
        .toContain(UNREACHABLE_BOOTSTRAP);
      await capture(failed, "12-listener");
    },
    LONG_SCENARIO_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenMatchOnlyBeforeTheNewest500_whenFiltered_thenFooterSaysSoAndSearchEarlierFindsIt (13)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openTopic(page, kafka.history);
      await tab.getByTestId("read-filter").fill(EARLY_KEY);
      await read(tab);
      await text(tab.getByTestId("topic-scanned")).toContain("0 matched in the newest 500 of each partition");
      await tab.getByTestId("topic-search-earlier").click();
      await text(tab.getByTestId("topic-scanned")).toContain("1 matched");
      expect((await gridText(page)).cells).toContain(EARLY_KEY);
      await capture(page, "13-search-earlier");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenLagRow_whenSkipRecordOnOnePartition_thenApplyAndSkip1MovesOnlyThatPartition (14)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openGroup(page, kafka.billing);
      const row = tab.locator('[data-testid="lag-row"][data-partition="2"]');
      const before = Number((await row.locator("td").nth(1).textContent())?.replace(/\D/g, ""));
      await row.getByTestId("lag-skip-record").click();
      const reset = page.getByTestId("reset-dialog");
      await eventually(() => reset.getByTestId("reset-partitions").inputValue()).toBe("2");
      const apply = reset.getByTestId("reset-apply");
      await text(apply).toBe("Apply and Skip 1");
      await attr(apply, "data-variant").toBe("warning");
      await capture(page, "14-skip-one");
      await apply.click();
      await count(reset).toBe(0);
      await text(row.locator("td").nth(1)).toBe(String(before + 1));
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenDestructiveDialogs_whenEnterIsPressed_thenOnlyThePreviewRunsAndNothingIsApplied (15)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const group = await openGroup(page, kafka.billing);
      const committed = async () => (await group.getByTestId("lag-row").allTextContents()).join("|");
      const offsets = await committed();
      await group.getByTestId("group-reset").click();
      const reset = page.getByTestId("reset-dialog");
      await reset.getByTestId("reset-value").fill(orderInstant(kafka, 0));
      await reset.getByTestId("reset-value").press("Enter");
      await shown(reset.getByTestId("reset-preview"));
      await shown(reset);
      await reset.getByRole("button", { name: "Cancel", exact: true }).click();
      await group
        .getByRole("button", { name: /Refresh/ })
        .first()
        .click();
      expect(await committed()).toBe(offsets);

      const purge = await openTopic(page, kafka.purge);
      const rowsBefore = await purge.getByTestId("topic-scanned").textContent();
      await purge.getByTestId("view-partitions").click();
      await purge.getByTestId("topic-delete-records").click();
      const records = page.getByTestId("delete-records-dialog");
      await records.getByTestId("delete-boundary").fill("2");
      await records.getByTestId("delete-boundary").press("Enter");
      await shown(records.getByTestId("delete-records-preview"));
      await shown(records);
      await capture(page, "15-enter-safe");
      await records.getByRole("button", { name: "Cancel", exact: true }).click();
      await purge.getByTestId("view-messages").click();
      await read(purge);
      expect(await purge.getByTestId("topic-scanned").textContent()).toBe(rowsBefore);

      await purge.getByTestId("topic-produce").click();
      const produce = page.getByTestId("produce-dialog");
      await produce.getByTestId("produce-key").fill("enter-key");
      await produce.getByTestId("produce-key").press("Enter");
      await shown(produce);
      await count(produce.getByTestId("produce-sent")).toBe(0);
      await produce.getByRole("button", { name: "Close", exact: true }).click();
    },
    LONG_SCENARIO_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenProductionColour_whenResetOpens_thenTitleNamesTheDatasourceAndApplyNeedsTheGroupName (16)",
    async () => {
      const kafka = seeded();
      const page = await launchSaved({ id: "kafka-production", name: PRODUCTION_NAME, color: "red" });
      const tab = await openGroup(page, kafka.billing);
      await tab.getByTestId("group-reset").click();
      const reset = page.getByTestId("reset-dialog");
      await text(reset.getByTestId("stream-dialog-title")).toContain(`on ${PRODUCTION_NAME}`);
      await shown(reset.getByTestId("production-strip"));
      await reset.getByTestId("reset-kind").locator('label[data-value="earliest"]').click();
      await shown(reset.getByTestId("reset-typed-name"));
      const apply = reset.getByTestId("reset-apply");
      await disabled(apply).toBe(true);
      await reset.getByTestId("reset-typed-name").fill(kafka.billing);
      await disabled(apply).toBe(false);
      await capture(page, "16-production");
      await reset.getByRole("button", { name: "Cancel", exact: true }).click();
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenVietnamTimeZone_whenTimestampTyped_thenFieldNamesTheZoneAndTheUtcInstant (17)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)), { env: { TZ: VIETNAM_ZONE } });
      const tab = await openTopic(page, kafka.orders);
      await chooseOption(tab.getByTestId("read-from"), "timestamp");
      await tab.getByTestId("read-timestamp").fill("2026-11-21 09:15:00");
      const hint = tab.getByTestId("timestamp-hint");
      await text(hint).toContain("UTC+07:00");
      await text(hint).toContain("= 2026-11-21 02:15:00 UTC");
      await capture(page, "17-timezone");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenLongScan_whenCancelled_thenTheReadStopsAndSaysSo (18; no partial count, see the report)",
    async () => {
      const kafka = seeded();
      await kafka.fillBulk(BULK_RECORDS);
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openTopic(page, kafka.bulk);
      await chooseOption(tab.getByTestId("read-from"), "earliest");
      await tab.getByTestId("read-filter").fill("matches-nothing");
      await tab.getByTestId("topic-read").click();
      await tab.getByTestId("topic-cancel").click({ timeout: READ_TIMEOUT_MS });
      await text(tab.getByTestId("topic-notice")).toContain("Read cancelled");
      await shown(tab.getByTestId("topic-read"));
      await capture(page, "18-cancel");
    },
    LONG_SCENARIO_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenNarrowWindow_whenTopicOpens_thenFilterAndReadStayReachable (19)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)), { size: NARROW_WINDOW });
      const tab = await openTopic(page, kafka.orders);
      await inViewport(tab.getByTestId("read-filter"));
      await inViewport(tab.getByTestId("topic-read"));
      await tab.getByTestId("read-filter").fill(HOT_CUSTOMER);
      await read(tab);
      await text(tab.getByTestId("topic-scanned")).toContain("matched");
      await capture(page, "19-narrow");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenTailBurst_whenTwoThousandArrive_thenPaneDrawsTheNewestSelectsAValueAndExports (21)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      await openTopic(page, kafka.events);
      await findAction(page, "Tail Topic");
      const pane = page.getByTestId("tail-pane");
      await text(pane.getByTestId("tail-status")).toContain("Live");
      await kafka.produce(
        kafka.events,
        Array.from({ length: TAIL_BURST }, (_, n) => ({
          partition: 0,
          key: `burst-${String(n)}`,
          value: JSON.stringify({ burst: n }),
        })),
      );
      await text(pane.getByTestId("tail-status")).toContain(TAIL_BURST.toLocaleString("en-US"));
      await shown(pane.getByTestId("tail-hidden"));
      await pane.getByTestId("tail-row").last().click();
      await text(pane.getByTestId("tail-detail-value")).toContain("burst");
      await capture(page, "21-tail-burst");

      const target = join(running?.userDataDir ?? newProfile(), "tail.jsonl");
      await running?.app.evaluate(({ dialog: dialogs }, picked) => {
        dialogs.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: picked });
      }, target);
      await pane.getByTestId("tail-export").click();
      await expect.poll(() => existsSync(target), { timeout: READ_TIMEOUT_MS }).toBe(true);
      const lines = readFileSync(target, "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(TAIL_BURST);
    },
    LONG_SCENARIO_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenDeleteAllRecords_whenPreviewed_thenTheTopicNameMustBeTypedAndTheTopicEmpties (22)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openTopic(page, kafka.purge);
      await tab.getByTestId("view-partitions").click();
      await tab.getByTestId("topic-delete-records").click();
      const records = page.getByTestId("delete-records-dialog");
      await records.getByTestId("delete-before").locator('label[data-value="latest"]').click();
      await text(records.getByTestId("delete-before")).toContain("All Records");
      await records.getByRole("button", { name: "Preview", exact: true }).click();
      await shown(records.getByTestId("delete-records-preview"));
      const apply = records.getByTestId("delete-records-apply");
      await disabled(apply).toBe(true);
      await records.getByTestId("delete-records-typed-name").fill(kafka.purge);
      await disabled(apply).toBe(false);
      await capture(page, "22-delete-all");
      await apply.click();
      await count(records).toBe(0);
      await tab.getByTestId("view-messages").click();
      await read(tab);
      await text(tab.getByTestId("topic-scanned")).toContain("0 rows");
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenLightAndHighContrastThemes_whenGroupAndResetShow_thenBothRead (23)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openGroup(page, kafka.billing);
      for (const [theme, shot] of [
        ["Light", "23-light"],
        ["High contrast", "23-contrast"],
      ] as const) {
        await setTheme(page, theme);
        await tab.getByTestId("group-reset").click();
        const reset = page.getByTestId("reset-dialog");
        await reset.getByTestId("reset-kind").locator('label[data-value="earliest"]').click();
        await shown(reset.getByTestId("reset-preview"));
        await capture(page, shot);
        await reset.getByRole("button", { name: "Cancel", exact: true }).click();
        await count(reset).toBe(0);
      }
    },
    SCENARIO_TIMEOUT_MS,
  );

  it.skipIf(WITHOUT_KAFKA)(
    "givenAvroMessageWithHeaders_whenSelectedWithTheValuePanel_thenDetailsShowHeadersAndSchema (24)",
    async () => {
      const kafka = seeded();
      const page = await launch(liveDatasource(liveConfig(kafka)));
      const tab = await openTopic(page, kafka.orders);
      await findAction(page, "Value Panel");
      await tab.getByRole("gridcell").filter({ hasText: '"customer"' }).first().click();
      const panel = tab.getByTestId("message-panel");
      await shown(panel);
      await text(panel).toContain("trace-id");
      await text(panel).toContain("AVRO");
      await text(panel.getByTestId("message-value")).toContain("customer");
      await capture(page, "24-message-panel");
    },
    SCENARIO_TIMEOUT_MS,
  );
});
