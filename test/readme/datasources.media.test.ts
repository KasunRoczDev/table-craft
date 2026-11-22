/**
 * Plan 167's GIFs of the datasources that shipped without one: Kafka topics decoded through Schema
 * Registry beside a lagging consumer group, and an Elasticsearch index searched by Lucene and a log
 * alias read time first. Each runs against a disposable server of `shopServers.ts`, recorded by the
 * same `bun run readme:media`.
 */
import type { Locator, Page } from "playwright-core";
import { expect } from "vitest";
import { COFFEE_QUERY, LIVE_LOG_ALIAS, LIVE_PRODUCTS, PRODUCT_COUNT } from "../e2e/elasticsearchLive.js";
import { LIVE_LAG_WARNING, ORDERS_PARTITIONS, ORDERS_PER_PARTITION } from "../e2e/kafkaLive.js";
import { chooseOption, LAUNCH_TIMEOUT_MS, type SavedDatasource, toolWindow } from "../e2e/harness.js";
import { clickVisibly, pause, pointAt, pressVisibly, typeSlowly } from "./pace.js";
import { connect, datasourceRow, mediaSuite, READ_PAUSE_MS, scene } from "./scenes.js";
import {
  loadShopElasticsearch,
  loadShopKafka,
  SHOP_KAFKA_GROUP,
  SHOP_KAFKA_HOT_CUSTOMER,
  SHOP_KAFKA_ORDERS,
  SHOP_KAFKA_PORT,
  SHOP_SCHEMA_REGISTRY_PORT,
  SHOP_SEARCH,
  SHOP_SEARCH_DATASOURCE,
  stopShopElasticsearch,
  stopShopKafka,
} from "./shopServers.js";

const EVENTS = "events";
const EVENTS_KAFKA: SavedDatasource = {
  id: EVENTS,
  name: EVENTS,
  pluginId: "kafka",
  color: "violet",
  config: {
    bootstrapServers: `127.0.0.1:${String(SHOP_KAFKA_PORT)}`,
    security: "PLAINTEXT",
    registryUrl: `http://127.0.0.1:${String(SHOP_SCHEMA_REGISTRY_PORT)}`,
    lagWarning: LIVE_LAG_WARNING,
  },
};
const ORDERS_COUNT = ORDERS_PARTITIONS * ORDERS_PER_PARTITION;
const FILTERED_COUNT = /^\d+ of [\d,]+ scanned$/;

const ERROR_QUERY = "log.level:error";
const LAST_HOUR = "1h";

let closeRegistry: (() => Promise<void>) | null = null;

function explorer(page: Page): Locator {
  return toolWindow(page, "Database");
}

function streamRow(page: Page, kind: "topic" | "consumerGroup", name: string): Locator {
  return explorer(page).locator(`[data-testid="stream-${kind}"][data-name=${JSON.stringify(name)}]`);
}

function indexRow(page: Page, kind: "index" | "alias", name: string): Locator {
  return explorer(page).locator(`[data-testid="index-${kind}"][data-name=${JSON.stringify(name)}]`);
}

/** Connects off camera and opens the datasource's tree, as the etcd scene does. */
async function connectAndExpand(page: Page, name: string, first: Locator): Promise<void> {
  await connect(page, name);
  if ((await first.count()) === 0) {
    await datasourceRow(page, name).click();
    await page.keyboard.press("ArrowRight");
  }
  await first.waitFor({ timeout: LAUNCH_TIMEOUT_MS });
}

/** Opens a tree row the way a reader would: select it, then Enter. */
async function openRow(page: Page, row: Locator): Promise<void> {
  await clickVisibly(page, row);
  await pressVisibly(page, "Enter");
}

const visibleText = (target: Locator) => expect.poll(() => target.textContent(), { timeout: LAUNCH_TIMEOUT_MS });

mediaSuite("README datasource media", () => {
  scene("kafka", {
    alsoSaved: [EVENTS_KAFKA],
    prepare: async () => {
      closeRegistry = (await loadShopKafka()).close;
    },
    teardown: async () => {
      await closeRegistry?.();
      closeRegistry = null;
      stopShopKafka();
    },
    setup: async ({ page }) => {
      await connectAndExpand(page, EVENTS, streamRow(page, "topic", SHOP_KAFKA_ORDERS));
      await streamRow(page, "consumerGroup", SHOP_KAFKA_GROUP).waitFor({ timeout: LAUNCH_TIMEOUT_MS });
    },
    run: async ({ page }) => {
      const orders = streamRow(page, "topic", SHOP_KAFKA_ORDERS);
      await pointAt(page, orders);
      await pause(page);
      await openRow(page, orders);
      const topic = page.getByTestId("topic-tab").filter({ visible: true });
      await visibleText(topic.getByTestId("topic-scanned")).toBe(`${String(ORDERS_COUNT)} messages`);
      await pause(page, READ_PAUSE_MS);

      await clickVisibly(page, topic.getByTestId("read-filter"));
      await typeSlowly(page, SHOP_KAFKA_HOT_CUSTOMER);
      await clickVisibly(page, topic.getByTestId("topic-read"));
      await visibleText(topic.getByTestId("topic-scanned")).toMatch(FILTERED_COUNT);
      await pause(page);

      await clickVisibly(page, topic.getByRole("gridcell").filter({ hasText: '"customer"' }).first());
      await pressVisibly(page, "Shift+Enter");
      const details = topic.getByTestId("message-panel");
      await visibleText(details).toContain("AVRO");
      await pointAt(page, details);
      await pause(page, READ_PAUSE_MS);

      const billing = streamRow(page, "consumerGroup", SHOP_KAFKA_GROUP);
      await openRow(page, billing);
      const group = page.getByTestId("group-tab").filter({ visible: true });
      await group.getByTestId("lag-row").first().waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pointAt(page, group.locator('[data-testid="lag-row"][data-hot="true"]'));
      await pause(page, READ_PAUSE_MS);
    },
  });

  scene("elasticsearch", {
    alsoSaved: [SHOP_SEARCH_DATASOURCE],
    prepare: loadShopElasticsearch,
    teardown: () => {
      stopShopElasticsearch();
      return Promise.resolve();
    },
    setup: async ({ page }) => {
      await connectAndExpand(page, SHOP_SEARCH, indexRow(page, "index", LIVE_PRODUCTS));
    },
    run: async ({ page }) => {
      const products = indexRow(page, "index", LIVE_PRODUCTS);
      await pointAt(page, products);
      await pause(page);
      await clickVisibly(page, products, { double: true });
      const tab = page.getByTestId("index-tab").filter({ visible: true });
      const hits = tab.getByTestId("index-hits");
      await visibleText(hits).toContain(`of ${PRODUCT_COUNT.toLocaleString("en-US")} hits`);
      await pause(page);

      await clickVisibly(page, tab.getByTestId("index-query"));
      await typeSlowly(page, COFFEE_QUERY);
      await pressVisibly(page, "Enter");
      await expect
        .poll(() => hits.textContent(), { timeout: LAUNCH_TIMEOUT_MS })
        .not.toContain(`of ${PRODUCT_COUNT.toLocaleString("en-US")} hits`);
      await pause(page, READ_PAUSE_MS);

      await clickVisibly(page, indexRow(page, "alias", LIVE_LOG_ALIAS), { double: true });
      await visibleText(tab.getByTestId("index-header")).toContain(LIVE_LOG_ALIAS);
      await clickVisibly(page, tab.getByTestId("index-range"));
      await chooseOption(tab.getByTestId("index-range"), LAST_HOUR);
      await tab.getByTestId("index-histogram").waitFor({ timeout: LAUNCH_TIMEOUT_MS });
      await pause(page);
      const unfiltered = await hits.textContent();
      await clickVisibly(page, tab.getByTestId("index-query"));
      await typeSlowly(page, ERROR_QUERY);
      await pressVisibly(page, "Enter");
      await expect.poll(() => hits.textContent(), { timeout: LAUNCH_TIMEOUT_MS }).not.toBe(unfiltered);
      // A hovered bar would read as a spike.
      await pointAt(page, tab.getByTestId("index-header"));
      await pause(page, READ_PAUSE_MS);
    },
  });
});
