/**
 * The shop the Elasticsearch live test browses (plan 165), seeded into the compose `elasticsearch`
 * and `opensearch` services: a `products` index with a folding analyzer and the `catalog` alias over it, `orders`
 * with a time field, and a rolled-over log family behind its write alias. Every name is the run's
 * own on a container no other suite writes to, and `dropLiveElasticsearch` deletes them all.
 */
import { ELASTICSEARCH_CONFIG } from "../support/databases.js";

interface ServerAddress {
  readonly host: string;
  readonly port: number;
}

export const LIVE_PRODUCTS = "products";
export const LIVE_CATALOG = "catalog";
export const LIVE_ORDERS = "orders";
export const LIVE_LOG_ALIAS = "checkout-logs";
export const LIVE_LOG_INDICES = ["checkout-logs-000411", "checkout-logs-000412"] as const;
export const PRODUCT_COUNT = 240;
export const ORDER_COUNT = 600;
export const LOG_COUNT_EACH = 300;
/** Products whose category is `coffee` and price at most 20, the Lucene query the test types. */
export const COFFEE_QUERY = "category:coffee AND price:[* TO 20]";

const CATEGORIES = ["coffee", "tea", "bakery", "gift cards"] as const;
const PRODUCT_NAMES = ["Crème brûlée", "Flat white", "Sencha", "Croissant", "Cold brew", "Earl grey"] as const;
const LEVELS = ["info", "info", "info", "warn", "error"] as const;
const PODS = ["checkout-api-7d9f-x2k4p", "checkout-api-7d9f-q8m2z", "checkout-worker-5c4b-h7r1d"] as const;
const MINUTE_MS = 60_000;
/** Orders spread over the last two hours, so the default 15 minutes holds some and an hour more. */
const ORDER_SPAN_MS = 2 * 60 * MINUTE_MS;
const LOG_SPAN_MS = 60 * MINUTE_MS;
const PRICE_STEP = 0.75;
const BASE_PRICE = 3;
const MAX_PRICE_STEPS = 40;

export interface LiveElasticsearch {
  readonly url: string;
  readonly host: string;
  readonly port: number;
}

export function liveElasticsearch(server: ServerAddress = ELASTICSEARCH_CONFIG): LiveElasticsearch {
  return { url: `http://${server.host}:${String(server.port)}`, host: server.host, port: server.port };
}

async function send(live: LiveElasticsearch, method: string, path: string, body?: unknown, ndjson = false) {
  const response = await fetch(`${live.url}${path}`, {
    method,
    headers: { "Content-Type": ndjson ? "application/x-ndjson" : "application/json" },
    ...(body === undefined ? {} : { body: ndjson && typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok && response.status !== 404)
    throw new Error(`${method} ${path} answered ${response.status}: ${text}`);
  return text;
}

function bulkOf(index: string, documents: readonly (readonly [string, object])[]): string {
  return documents
    .map(([id, source]) => `${JSON.stringify({ index: { _index: index, _id: id } })}\n${JSON.stringify(source)}\n`)
    .join("");
}

const FOLDING_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 0,
  analysis: {
    filter: { min_three: { type: "length", min: 3 } },
    analyzer: {
      folding: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding", "min_three"] },
    },
  },
};

const SMALL_INDEX = { number_of_shards: 1, number_of_replicas: 0 };

function products(): (readonly [string, object])[] {
  return Array.from({ length: PRODUCT_COUNT }, (_, index) => {
    const sku = `SKU-${String(10_001 + index)}`;
    const name = `${PRODUCT_NAMES[index % PRODUCT_NAMES.length] ?? ""} ${String(Math.floor(index / PRODUCT_NAMES.length) + 1)}`;
    return [
      sku,
      {
        sku,
        name,
        category: CATEGORIES[index % CATEGORIES.length],
        price: BASE_PRICE + (index % MAX_PRICE_STEPS) * PRICE_STEP,
        in_stock: index % 7 !== 0,
      },
    ] as const;
  });
}

function orders(now: number): (readonly [string, object])[] {
  return Array.from({ length: ORDER_COUNT }, (_, index) => {
    const id = `ORD-${String(50_001 + index)}`;
    return [
      id,
      {
        "@timestamp": new Date(now - Math.round((index / ORDER_COUNT) * ORDER_SPAN_MS)).toISOString(),
        customer: `customer-${String((index * 37) % 120)}`,
        status: index % 9 === 0 ? "refunded" : "paid",
        total: Math.round((8 + (index % 23) * 1.5) * 100) / 100,
        lines: [{ sku: `SKU-${String(10_001 + (index % PRODUCT_COUNT))}`, quantity: 1 + (index % 3) }],
      },
    ] as const;
  });
}

function logs(now: number, older: boolean): (readonly [string, object])[] {
  return Array.from({ length: LOG_COUNT_EACH }, (_, index) => {
    const at = now - (older ? LOG_SPAN_MS : 0) - Math.round((index / LOG_COUNT_EACH) * LOG_SPAN_MS);
    const level = LEVELS[index % LEVELS.length] ?? "info";
    const pod = PODS[index % PODS.length] ?? "";
    const message = JSON.stringify({
      level,
      msg:
        level === "error"
          ? "payment authorisation timed out"
          : level === "warn"
            ? "retrying cart lock"
            : "order placed",
      order: `ORD-${String(50_001 + index)}`,
    });
    return [
      `${older ? "a" : "b"}-${String(index)}`,
      {
        "@timestamp": new Date(at).toISOString(),
        log: { level },
        kubernetes: {
          pod: { name: pod },
          container: { name: pod.startsWith("checkout-worker") ? "checkout-worker" : "checkout-api" },
        },
        message,
      },
    ] as const;
  });
}

const LOG_MAPPING = {
  properties: {
    "@timestamp": { type: "date" },
    log: { properties: { level: { type: "keyword" } } },
    kubernetes: {
      properties: {
        pod: { properties: { name: { type: "keyword" } } },
        container: { properties: { name: { type: "keyword" } } },
      },
    },
    message: { type: "text", fields: { keyword: { type: "keyword", ignore_above: 1024 } } },
  },
};

export async function dropLiveElasticsearch(live: LiveElasticsearch): Promise<void> {
  for (const index of [LIVE_PRODUCTS, LIVE_ORDERS, ...LIVE_LOG_INDICES]) await send(live, "DELETE", `/${index}`);
}

export async function seedLiveElasticsearch(live: LiveElasticsearch, now: number = Date.now()): Promise<void> {
  await dropLiveElasticsearch(live);
  await send(live, "PUT", `/${LIVE_PRODUCTS}`, {
    settings: FOLDING_SETTINGS,
    mappings: {
      properties: {
        sku: { type: "keyword" },
        name: { type: "text", analyzer: "folding", fields: { raw: { type: "keyword" } } },
        category: { type: "keyword" },
        price: { type: "scaled_float", scaling_factor: 100 },
        in_stock: { type: "boolean" },
      },
    },
    aliases: { [LIVE_CATALOG]: {} },
  });
  await send(live, "PUT", `/${LIVE_ORDERS}`, {
    settings: SMALL_INDEX,
    mappings: {
      properties: {
        "@timestamp": { type: "date" },
        customer: { type: "keyword" },
        status: { type: "keyword" },
        total: { type: "double" },
        lines: { type: "nested", properties: { sku: { type: "keyword" }, quantity: { type: "integer" } } },
      },
    },
  });
  const [older, newer] = LIVE_LOG_INDICES;
  await send(live, "PUT", `/${older}`, {
    settings: SMALL_INDEX,
    mappings: LOG_MAPPING,
    aliases: { [LIVE_LOG_ALIAS]: { is_write_index: false } },
  });
  await send(live, "PUT", `/${newer}`, {
    settings: SMALL_INDEX,
    mappings: LOG_MAPPING,
    aliases: { [LIVE_LOG_ALIAS]: { is_write_index: true } },
  });
  const bulk =
    bulkOf(LIVE_PRODUCTS, products()) +
    bulkOf(LIVE_ORDERS, orders(now)) +
    bulkOf(older, logs(now, true)) +
    bulkOf(newer, logs(now, false));
  const answer = JSON.parse(await send(live, "POST", "/_bulk?refresh=true", bulk, true)) as { errors?: boolean };
  if (answer.errors === true) throw new Error("The live seed's bulk request reported item errors.");
}
