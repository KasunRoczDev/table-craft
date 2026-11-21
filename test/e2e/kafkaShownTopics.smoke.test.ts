/**
 * Plan 166's live test: Manage Shown Topics on a saved Kafka datasource, against the Kafka the run
 * names (the remote cluster of `TABLE_CRAFT_KAFKA_REMOTE_BOOTSTRAP` in `.env`, else the compose
 * broker). Gated, because it needs a display, a fresh build and a broker:
 *
 *   TABLE_CRAFT_EVIDENCE_DIR=docs/evidence/166 bun run test:smoke:db:headless:kafka test/e2e/kafkaShownTopics.smoke.test.ts
 *
 * Its topics start `tc_run_` and are deleted after the run; the datasource's Name filter keeps the
 * tree to them, so nothing else on the cluster shows or is written.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Admin } from "@platformatic/kafka";
import type { Locator, Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KAFKA_CONFIG, KAFKA_SCRATCH_PREFIX, WITHOUT_KAFKA } from "../support/databases.js";
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

const captureWindow = evidenceFor("166");

const SEED_TIMEOUT_MS = 60_000;
const WAIT = { timeout: 30_000 } as const;
const RANDOM_BYTES = 3;
const CLIENT_ID = "table-craft-live-166";
const DATASOURCES_FILE = "datasources.json";
const NAME = "Kafka Shared";
const TOPIC_SUFFIXES = ["audit", "billing", "orders", "payments"] as const;
const PICKED = ["orders", "payments"] as const;

const prefix = `${KAFKA_SCRATCH_PREFIX}${randomBytes(RANDOM_BYTES).toString("hex")}_`;
const topicName = (suffix: string) => `${prefix}${suffix}`;
const ALL_TOPICS = TOPIC_SUFFIXES.map(topicName);
const PICKED_TOPICS = PICKED.map(topicName);

let admin: Admin | null = null;
let running: RunningApp | null = null;

function eventually<T>(read: () => Promise<T>) {
  return expect.poll(read, WAIT);
}

function saved(): SavedDatasource {
  return {
    id: "kafka-shared",
    name: NAME,
    pluginId: "kafka",
    config: { bootstrapServers: KAFKA_CONFIG.bootstrapServers, security: "PLAINTEXT", nameFilter: `${prefix}*` },
  };
}

function topicRows(page: Page): Locator {
  return explorer(page).locator('[data-testid="stream-topic"]');
}

async function listedTopics(page: Page): Promise<readonly string[]> {
  const names: string[] = [];
  for (const row of await topicRows(page).all()) names.push((await row.getAttribute("data-name")) ?? "");
  return names.sort();
}

async function launchOn(userDataDir: string): Promise<Page> {
  running = await launchApp(null, { userDataDir });
  await setWindowSize(running.app, EVIDENCE_WINDOW);
  const { page } = running;
  await treeNode(page, NAME).click();
  await page.keyboard.press("ArrowRight");
  return page;
}

function shownDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: `Manage Shown Topics — ${NAME}` });
}

async function openFromMenu(page: Page, row: Locator): Promise<Locator> {
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Manage Shown Topics/ }).click();
  const dialog = shownDialog(page);
  await dialog.waitFor(WAIT);
  return dialog;
}

function storedShownTopics(userDataDir: string): unknown {
  const file = JSON.parse(readFileSync(join(userDataDir, DATASOURCES_FILE), "utf8")) as {
    datasources: readonly { id: string; shownTopics?: unknown }[];
  };
  return file.datasources.find((each) => each.id === saved().id)?.shownTopics;
}

describe.runIf(DATABASES_ENABLED)("Manage Shown Topics live test (plan 166)", () => {
  beforeAll(async () => {
    if (WITHOUT_KAFKA) return;
    admin = new Admin({
      clientId: CLIENT_ID,
      bootstrapBrokers: KAFKA_CONFIG.bootstrapServers.split(",").map((broker) => broker.trim()),
      timeout: WAIT.timeout,
      retries: 1,
    });
    await admin.createTopics({ topics: ALL_TOPICS, partitions: 1, replicas: 1 });
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    for (const topic of ALL_TOPICS) await admin?.deleteTopics({ topics: [topic] }).catch(() => undefined);
    await admin?.close().catch(() => undefined);
    admin = null;
  }, SEED_TIMEOUT_MS);

  afterEach(async () => {
    await closeApp(running?.app);
    running = null;
  }, CLOSE_HOOK_TIMEOUT_MS);

  it.skipIf(WITHOUT_KAFKA)(
    "givenSavedKafka_whenTwoTopicsPicked_thenTreeListsThemAndTheChoiceSurvivesARestart",
    async () => {
      const profile = newProfile();
      seedDatasources(profile, [saved()]);
      let page = await launchOn(profile);
      await eventually(() => listedTopics(page)).toEqual(ALL_TOPICS);
      await captureWindow(page, "01-all-topics");

      await treeNode(page, NAME).click({ button: "right" });
      await page.getByRole("menuitem", { name: /^Manage Shown Topics/ }).waitFor(WAIT);
      await captureWindow(page, "02-datasource-menu");
      await page.getByRole("menuitem", { name: /^Manage Shown Topics/ }).click();
      let dialog = shownDialog(page);
      await dialog.waitFor(WAIT);
      await eventually(() => dialog.getByTestId("shown-schemas-count").textContent()).toBe(
        `All ${String(ALL_TOPICS.length)} shown`,
      );

      await dialog.getByRole("checkbox", { name: "All topics", exact: true }).uncheck();
      for (const topic of ALL_TOPICS.filter((each) => !PICKED_TOPICS.includes(each))) {
        await dialog.getByRole("checkbox", { name: topic, exact: true }).uncheck();
      }
      await dialog.getByLabel("Search topics", { exact: true }).fill("pay");
      await eventually(() => dialog.getByRole("list", { name: "Topics" }).getByRole("checkbox").count()).toBe(1);
      await captureWindow(page, "03-dialog-search");
      await dialog.getByLabel("Search topics", { exact: true }).fill("");
      await eventually(() => dialog.getByTestId("shown-schemas-count").textContent()).toBe(
        `${String(PICKED_TOPICS.length)} of ${String(ALL_TOPICS.length)} shown`,
      );
      await captureWindow(page, "04-dialog-picked");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });

      await eventually(() => listedTopics(page)).toEqual(PICKED_TOPICS);
      const shown = treeNode(page, NAME).getByTestId("shown-namespaces");
      await eventually(() => shown.textContent()).toBe(
        `${String(PICKED_TOPICS.length)} of ${String(ALL_TOPICS.length)}`,
      );
      expect(storedShownTopics(profile)).toEqual(PICKED_TOPICS);
      await captureWindow(page, "05-tree-filtered");

      await closeApp(running?.app);
      running = null;
      page = await launchOn(profile);
      await eventually(() => listedTopics(page)).toEqual(PICKED_TOPICS);
      await eventually(() => treeNode(page, NAME).getByTestId("shown-namespaces").textContent()).toBe(
        `${String(PICKED_TOPICS.length)} of ${String(ALL_TOPICS.length)}`,
      );
      await captureWindow(page, "06-after-restart");

      dialog = await openFromMenu(page, topicRows(page).first());
      await dialog.getByRole("checkbox", { name: "All topics", exact: true }).check();
      await captureWindow(page, "07-dialog-all-again");
      await dialog.getByRole("button", { name: "OK", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await eventually(() => listedTopics(page)).toEqual(ALL_TOPICS);
      await eventually(() => treeNode(page, NAME).getByTestId("shown-namespaces").count()).toBe(0);
      expect(storedShownTopics(profile)).toBeUndefined();
      await captureWindow(page, "08-all-topics-again");
    },
    SCENARIO_TIMEOUT_MS * 3,
  );
});
