import elasticsearch from "@table-craft/plugin-elasticsearch";
import type { Row, Session } from "@table-craft/plugin-api";
import { runPluginContract } from "@table-craft/plugin-api/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseEnabled } from "../support/databases.js";
import {
  dropElasticsearchFixture,
  ES_COMMANDS,
  ES_FIXTURE_ALIAS,
  ES_FIXTURE_INDEX,
  ES_SEARCH,
  elasticSleep,
  elasticTargets,
  seedElasticsearchFixture,
  type ElasticTarget,
} from "../support/elasticsearchFixture.js";
import { ELASTICSEARCH_MANIFEST } from "../support/manifests.js";

const ENABLED = databaseEnabled("elasticsearch");
const BRANDS = ["elasticsearch", "opensearch"];
const VERSION = /^\d+\.\d+\.\d+/;
const UNREACHABLE = { host: "127.0.0.1", port: 1, connectTimeout: 1 } as const;

async function withSession(
  target: ElasticTarget,
  use: (session: Session) => Promise<void>,
  readOnly = false,
): Promise<void> {
  const session = await elasticsearch.connect(elasticsearch.connectionSchema.parse(target.config), { readOnly });
  try {
    await use(session);
  } finally {
    await session.close();
  }
}

async function rows(session: Session, command: string): Promise<Row[]> {
  const result = await session.execute(command);
  const all: Row[] = [];
  for await (const row of result.rows) all.push(row);
  return all;
}

describe.runIf(ENABLED).each(elasticTargets())("elasticsearch plugin on $label", (target) => {
  beforeAll(async () => {
    await seedElasticsearchFixture(target);
  });

  afterAll(async () => {
    await dropElasticsearchFixture(target);
  });

  runPluginContract(elasticsearch, {
    manifest: ELASTICSEARCH_MANIFEST,
    config: target.config,
    statements: { sleep: elasticSleep },
    commands: ES_COMMANDS,
    search: ES_SEARCH,
  });

  describe("elasticsearch only", () => {
    it("givenSession_whenConnected_thenBrandAndVersionFromTheServer", async () => {
      await withSession(target, async (session) => {
        expect(BRANDS).toContain(session.serverBrand);
        expect(session.serverVersion).toMatch(VERSION);
        const info = await session.services.serverInfo?.info(null);
        expect(info?.sections.map((section) => section.title)).toContain("Cluster");
      });
    });

    it("givenFixtureIndex_whenSearchedToTheEnd_thenNoCursorLeftOpen", async () => {
      await withSession(target, async (session) => {
        const browser = session.services.searchIndices;
        if (browser === undefined) throw new Error("no searchIndices service");
        const outcome = await browser.search({
          target: ES_FIXTURE_INDEX,
          language: "lucene",
          query: "",
          sort: [{ field: "sku", order: "desc" }],
          time: null,
          fields: ["sku", "category"],
          pageSize: 7,
        });
        const all: Row[] = [];
        for await (const row of outcome.result.rows) all.push(row);
        expect(all).toHaveLength(ES_SEARCH.documents);
        expect(all[0]?.[0]).toBe("p-120");
        const skus = all.map((row) => (typeof row[0] === "string" ? row[0] : ""));
        expect(new Set(skus).size).toBe(ES_SEARCH.documents);
        expect(skus).toEqual([...skus].sort().reverse());
        expect(outcome.result.columns.map((column) => column.name)).toEqual(["sku", "category", "_id", "_source"]);
        expect((browser as unknown as { openCursors: number }).openCursors).toBe(0);
      });
    });

    it("givenUnsortedSearch_whenPagedPastPageOne_thenEveryDocumentOnceAndNothingLeftOpen", async () => {
      await withSession(target, async (session) => {
        const browser = session.services.searchIndices;
        if (browser === undefined) throw new Error("no searchIndices service");
        const outcome = await browser.search({
          target: ES_FIXTURE_INDEX,
          language: "lucene",
          query: "",
          sort: [],
          time: null,
          fields: ["sku"],
          pageSize: 9,
        });
        const skus = new Set<string>();
        let read = 0;
        for await (const row of outcome.result.rows) {
          skus.add(typeof row[0] === "string" ? row[0] : "");
          read += 1;
        }
        expect(read).toBe(ES_SEARCH.documents);
        expect(skus.size).toBe(ES_SEARCH.documents);
        expect((browser as unknown as { openCursors: number }).openCursors).toBe(0);
      });
    });

    it("givenAliasSearch_whenRead_thenIndexColumnNamesTheBackingIndex", async () => {
      await withSession(target, async (session) => {
        const browser = session.services.searchIndices;
        if (browser === undefined) throw new Error("no searchIndices service");
        const outcome = await browser.search({
          target: `${ES_FIXTURE_ALIAS},${ES_FIXTURE_INDEX}`,
          language: "lucene",
          query: "sku:p-001",
          sort: [],
          time: null,
          fields: ["sku"],
          pageSize: 10,
        });
        const all: Row[] = [];
        for await (const row of outcome.result.rows) all.push(row);
        const names = outcome.result.columns.map((column) => column.name);
        expect(all[0]?.[names.indexOf("_index")]).toBe(ES_FIXTURE_INDEX);
      });
    });

    it("givenCatIndices_whenRun_thenOneRowPerIndexAsAGrid", async () => {
      await withSession(target, async (session) => {
        const found = await rows(session, `GET _cat/indices/${ES_FIXTURE_INDEX}?h=index,docs.count`);
        expect(found).toEqual([[ES_FIXTURE_INDEX, String(ES_SEARCH.documents)]]);
      });
    });

    it("givenSqlLine_whenRun_thenGroupedRows", async () => {
      await withSession(target, async (session) => {
        const found = await rows(
          session,
          `SELECT category, COUNT(*) AS n FROM ${ES_FIXTURE_INDEX} GROUP BY category ORDER BY category`,
        );
        expect(found.map((row) => row[0])).toEqual(["bakery", "coffee", "tea"]);
      });
    });

    it("givenReadOnlySession_whenDeleteSent_thenRefusedAndIndexKept", async () => {
      await withSession(
        target,
        async (session) => {
          const failure = await session.execute(`DELETE /${ES_FIXTURE_INDEX}`).catch((error: Error) => error);
          expect((failure as Error).message).toContain("read-only");
          expect(await rows(session, `GET _cat/indices/${ES_FIXTURE_INDEX}?h=index`)).toEqual([[ES_FIXTURE_INDEX]]);
        },
        true,
      );
    });
  });
});

describe.runIf(ENABLED)("elasticsearch plugin, unreachable", () => {
  it("givenClosedPort_whenConnecting_thenConnectionFailedNamingTheAddress", async () => {
    const failure = await elasticsearch
      .connect(elasticsearch.connectionSchema.parse(UNREACHABLE), { readOnly: true })
      .catch((error: Error) => error);
    expect((failure as Error).message).toContain("127.0.0.1:1");
  });
});
