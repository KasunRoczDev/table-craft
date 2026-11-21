import { randomBytes } from "node:crypto";
import type { CommandsFixture, SearchFixture } from "@table-craft/plugin-api/testing";
import {
  ELASTICSEARCH_CONFIG,
  ELASTICSEARCH_SCRATCH_PREFIX,
  elasticsearchConfigOf,
  elasticsearchRemoteUrl,
  OPENSEARCH_CONFIG,
} from "./databases.js";

const RANDOM_BYTES = 4;
const suffix = randomBytes(RANDOM_BYTES).toString("hex");

/** The products index every case reads, created by `seedElasticsearchFixture` and never written. */
export const ES_FIXTURE_INDEX = `${ELASTICSEARCH_SCRATCH_PREFIX}products_${suffix}`;
export const ES_FIXTURE_ALIAS = `${ELASTICSEARCH_SCRATCH_PREFIX}catalog_${suffix}`;
/** Indices a case creates for itself; `dropElasticsearchFixture` deletes them all. */
export const ES_SCRATCH_PATTERN = `${ELASTICSEARCH_SCRATCH_PREFIX}*_${suffix}`;

const DOCUMENTS = 120;
const PAGE_SIZE = 50;
const CATEGORIES = ["bakery", "coffee", "tea"] as const;
const NAMES = ["Crème brûlée", "Flat white", "Sencha", "Croissant", "Cold brew", "Earl grey"] as const;
const FIRST_HOUR = Date.UTC(2026, 0, 1);
const HOUR_MS = 3_600_000;
const RANGE_FIRST = 24;
const RANGE_LAST = 47;
/** Ends half an hour past the last document of the range, so neither bound sits on a document. */
const RANGE_END_SLACK_MS = HOUR_MS / 2;
const TYPELESS_MAJOR = 7;
const REMOTE_INDEX_FILTER = `${ELASTICSEARCH_SCRATCH_PREFIX}*`;

export interface ElasticTarget {
  readonly label: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly url: string;
}

function urlOf(config: { readonly host: string; readonly port: number }): string {
  return `http://${config.host}:${String(config.port)}`;
}

/** The servers the suite runs against: the two compose services, and the remote one `.env` names. */
export function elasticTargets(): readonly ElasticTarget[] {
  const remote = elasticsearchRemoteUrl();
  return [
    { label: "elasticsearch", config: ELASTICSEARCH_CONFIG, url: urlOf(ELASTICSEARCH_CONFIG) },
    { label: "opensearch", config: OPENSEARCH_CONFIG, url: urlOf(OPENSEARCH_CONFIG) },
    ...(remote === null
      ? []
      : [
          {
            label: "remote",
            config: { ...elasticsearchConfigOf(remote), indexFilter: REMOTE_INDEX_FILTER },
            url: remote,
          },
        ]),
  ];
}

function authorization(url: URL): Record<string, string> {
  if (url.username === "") return {};
  const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  return { authorization: `Basic ${Buffer.from(pair).toString("base64")}` };
}

/** One request straight to the server, outside the plugin, for seeding and checks. */
export async function elasticRequest(
  target: ElasticTarget,
  method: string,
  path: string,
  body?: unknown,
  ndjson = false,
): Promise<unknown> {
  const url = new URL(target.url);
  const headers: Record<string, string> = { ...authorization(url) };
  let payload: string | undefined;
  if (body !== undefined) {
    headers["content-type"] = ndjson ? "application/x-ndjson" : "application/json";
    payload = ndjson ? `${(body as unknown[]).map((line) => JSON.stringify(line)).join("\n")}\n` : JSON.stringify(body);
  }
  url.username = "";
  url.password = "";
  const response = await fetch(new URL(path, url), { method, headers, body: payload ?? null });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${String(response.status)}: ${text.slice(0, 500)}`);
  return text === "" ? null : JSON.parse(text);
}

/** Mapping types: Elasticsearch before 7.0 wants the one `_doc` type; OpenSearch never does. */
async function wantsMappingType(target: ElasticTarget): Promise<boolean> {
  const root = (await elasticRequest(target, "GET", "/")) as { version: { number: string; distribution?: string } };
  return root.version.distribution === undefined && Number(root.version.number.split(".")[0]) < TYPELESS_MAJOR;
}

function sku(index: number): string {
  return `p-${String(index + 1).padStart(3, "0")}`;
}

function documentAt(index: number): Record<string, unknown> {
  return {
    sku: sku(index),
    name: `${NAMES[index % NAMES.length] ?? ""} ${String(index + 1)}`,
    category: CATEGORIES[index % CATEGORIES.length],
    price: (index % 20) + 0.5,
    "@timestamp": new Date(FIRST_HOUR + index * HOUR_MS).toISOString(),
  };
}

const PRODUCT_MAPPING = {
  properties: {
    sku: { type: "keyword" },
    name: { type: "text", analyzer: "folding", fields: { raw: { type: "keyword" } } },
    category: { type: "keyword" },
    price: { type: "scaled_float", scaling_factor: 100 },
    "@timestamp": { type: "date" },
  },
};

const PRODUCT_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 0,
  analysis: {
    filter: { at_least_three: { type: "length", min: 3 } },
    analyzer: {
      folding: { type: "custom", tokenizer: "standard", filter: ["lowercase", "asciifolding", "at_least_three"] },
    },
  },
};

/** Creates the products index with its documents and an alias over it. */
export async function seedElasticsearchFixture(target: ElasticTarget): Promise<void> {
  const typed = await wantsMappingType(target);
  await elasticRequest(target, "PUT", `/${ES_FIXTURE_INDEX}`, {
    settings: PRODUCT_SETTINGS,
    mappings: typed ? { _doc: PRODUCT_MAPPING } : PRODUCT_MAPPING,
  });
  const lines = Array.from({ length: DOCUMENTS }, (_, index) => [
    { index: { _id: sku(index) } },
    documentAt(index),
  ]).flat();
  const bulkPath = typed ? `/${ES_FIXTURE_INDEX}/_doc/_bulk` : `/${ES_FIXTURE_INDEX}/_bulk`;
  const bulk = (await elasticRequest(target, "POST", `${bulkPath}?refresh=true`, lines, true)) as { errors: boolean };
  if (bulk.errors) throw new Error(`Seeding ${ES_FIXTURE_INDEX} on ${target.label} failed`);
  await elasticRequest(target, "POST", "/_aliases", {
    actions: [{ add: { index: ES_FIXTURE_INDEX, alias: ES_FIXTURE_ALIAS } }],
  });
}

/** Deletes every index this run created, and nothing else. */
export async function dropElasticsearchFixture(target: ElasticTarget): Promise<void> {
  // Elasticsearch 8 refuses a wildcard delete (`action.destructive_requires_name`), so name each one.
  const found = (await elasticRequest(target, "GET", `/_cat/indices/${ES_SCRATCH_PATTERN}?format=json&h=index`)) as {
    index: string;
  }[];
  if (found.length === 0) return;
  await elasticRequest(target, "DELETE", `/${found.map((row) => row.index).join(",")}`);
}

function idsWhere(keep: (index: number) => boolean): string[] {
  return Array.from({ length: DOCUMENTS }, (_, index) => index)
    .filter(keep)
    .map(sku);
}

const TEA = CATEGORIES.indexOf("tea");

export const ES_SEARCH: SearchFixture = {
  index: ES_FIXTURE_INDEX,
  alias: ES_FIXTURE_ALIAS,
  documents: DOCUMENTS,
  pageSize: PAGE_SIZE,
  sortField: "sku",
  query: {
    lucene: "category:tea",
    dsl: '{"term": {"category": "tea"}}',
    ids: idsWhere((index) => index % CATEGORIES.length === TEA),
  },
  multiField: { path: "name.raw", multiOf: "name" },
  time: {
    field: "@timestamp",
    from: new Date(FIRST_HOUR + RANGE_FIRST * HOUR_MS).toISOString(),
    to: new Date(FIRST_HOUR + RANGE_LAST * HOUR_MS + RANGE_END_SLACK_MS).toISOString(),
    inRange: RANGE_LAST - RANGE_FIRST + 1,
  },
  analyze: { field: "name", text: "Crème brûlée to go", tokens: ["creme", "brulee"] },
};

const PER_CATEGORY = DOCUMENTS / CATEGORIES.length;

export const ES_COMMANDS: CommandsFixture = {
  scripts: [
    {
      text: `GET /${ES_FIXTURE_INDEX}/_count\n\n# the first document\nPOST /${ES_FIXTURE_INDEX}/_search\n{\n  "size": 1\n}\n`,
      statements: [`GET /${ES_FIXTURE_INDEX}/_count`, `POST /${ES_FIXTURE_INDEX}/_search\n{\n  "size": 1\n}`],
    },
    {
      text: "GET _cluster/health\nGET _cat/indices",
      statements: ["GET _cluster/health", "GET _cat/indices"],
    },
  ],
  scalar: { command: "HEAD /", text: "200 - OK" },
  array: {
    command: `GET _cat/aliases/${ES_FIXTURE_ALIAS}?h=alias,index`,
    columns: ["alias", "index"],
    rows: [[ES_FIXTURE_ALIAS, ES_FIXTURE_INDEX]],
  },
  map: {
    command: `GET /${ES_FIXTURE_INDEX}/_search\n{"size": 0, "aggs": {"by_category": {"terms": {"field": "category", "order": {"_key": "asc"}}}}}`,
    columns: ["key", "doc_count"],
    rows: CATEGORIES.map((category) => [category, PER_CATEGORY]),
  },
  write: { command: `PUT /${ES_FIXTURE_INDEX}/_doc/p-999\n{"sku": "p-999"}`, name: "PUT" },
  confirmByName: `DELETE /${ES_FIXTURE_INDEX}`,
};

/** A request the server holds open for `seconds`: health waiting for nodes the cluster never has. */
export function elasticSleep(seconds: number): string {
  return `GET /_cluster/health?wait_for_nodes=1000&timeout=${String(seconds)}s`;
}
