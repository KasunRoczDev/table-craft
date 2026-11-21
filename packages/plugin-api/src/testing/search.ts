import { describe, expect, it } from "vitest";
import {
  isPluginError,
  SEARCH_ID_COLUMN,
  SEARCH_SOURCE_COLUMN,
  type DatasourcePlugin,
  type IndexBrowser,
  type PluginErrorCode,
  type Row,
  type SearchOutcome,
  type SearchRequest,
  type Session,
} from "@table-craft/plugin-api";

/**
 * What a plugin declaring `searchIndices` needs to run its contract cases (plan 165). The suite
 * only reads: the test that runs it seeds the index and alias beforehand and removes them after,
 * so the cases may run against a shared cluster.
 */
export interface SearchFixture {
  /** A seeded index. */
  readonly index: string;
  /** An alias over `index` alone. */
  readonly alias: string;
  /** How many documents `index` holds; more than `pageSize`, so a search pages. */
  readonly documents: number;
  /** The page size the paging case asks for. */
  readonly pageSize: number;
  /** A keyword field holding each document's `_id`, which the cases sort by. */
  readonly sortField: string;
  /** A Lucene query and the same query in DSL, and the ids of the documents they match, in `sortField` order. */
  readonly query: { readonly lucene: string; readonly dsl: string; readonly ids: readonly string[] };
  /** A text field with a keyword multi-field, as the mapping names them. */
  readonly multiField: { readonly path: string; readonly multiOf: string };
  /** The date field the index is timed by, and a range holding `inRange` documents. */
  readonly time: { readonly field: string; readonly from: string; readonly to: string; readonly inRange: number };
  /** Text analyzed by a field's analyzer, and the tokens of the last step. */
  readonly analyze: { readonly field: string; readonly text: string; readonly tokens: readonly string[] };
}

export interface SearchContract {
  readonly plugin: DatasourcePlugin;
  readonly config: unknown;
  readonly search: SearchFixture | undefined;
}

const HISTOGRAM_BUCKETS = 12;

async function collect(rows: AsyncIterable<Row>): Promise<Row[]> {
  const all: Row[] = [];
  for await (const row of rows) all.push(row);
  return all;
}

/** The `_id` of every hit; a plugin places the column where it reads best. */
async function idsOf(outcome: SearchOutcome): Promise<unknown[]> {
  const at = outcome.result.columns.findIndex((column) => column.name === SEARCH_ID_COLUMN);
  expect(at).toBeGreaterThanOrEqual(0);
  return (await collect(outcome.result.rows)).map((row) => row[at]);
}

async function rejectionCode(pending: Promise<unknown>): Promise<PluginErrorCode | "notAPluginError" | "resolved"> {
  try {
    await pending;
    return "resolved";
  } catch (error) {
    return isPluginError(error) ? error.code : "notAPluginError";
  }
}

/** The `searchIndices` cases (plan 165). */
export function runSearchContract(contract: SearchContract): void {
  const { plugin } = contract;

  function fixture(): SearchFixture {
    if (contract.search === undefined) throw new Error("A plugin that declares searchIndices needs fixture.search.");
    return contract.search;
  }

  async function withIndices(use: (indices: IndexBrowser) => Promise<void>): Promise<void> {
    const session: Session = await plugin.connect(plugin.connectionSchema.parse(contract.config), { readOnly: true });
    try {
      const indices = session.services.searchIndices;
      if (indices === undefined) throw new Error("The session has no searchIndices service.");
      await use(indices);
    } finally {
      await session.close();
    }
  }

  function request(overrides: Partial<SearchRequest> = {}): SearchRequest {
    return {
      target: fixture().index,
      language: "lucene",
      query: "",
      sort: [{ field: fixture().sortField, order: "asc" }],
      time: null,
      fields: null,
      pageSize: fixture().pageSize,
      ...overrides,
    };
  }

  describe.runIf(plugin.capabilities.includes("searchIndices"))("searchIndices", () => {
    it("givenSeededIndex_whenListed_thenIndexAndAliasWithWriteIndex", async () => {
      await withIndices(async (indices) => {
        const { index, alias, documents } = fixture();
        const listed = await indices.list();
        const found = listed.find((target) => target.name === index);
        expect(found).toMatchObject({ kind: "index", hidden: false, docs: String(documents) });
        expect(listed.find((target) => target.name === alias)).toMatchObject({
          kind: "alias",
          indices: [index],
          writeIndex: index,
        });
      });
    });

    it("givenIndex_whenDescribed_thenFieldsMultiFieldsAndTimeField", async () => {
      await withIndices(async (indices) => {
        const { index, multiField, time } = fixture();
        const described = await indices.describe(index);
        expect(described).toMatchObject({ name: index, kind: "index", indices: [index], timeField: time.field });
        expect(described.fields.find((field) => field.path === multiField.path)?.multiOf).toBe(multiField.multiOf);
        expect(described.mapping).toMatch(/\S/);
      });
    });

    it("givenAlias_whenDescribed_thenAliasOverItsIndex", async () => {
      await withIndices(async (indices) => {
        const described = await indices.describe(fixture().alias);
        expect(described).toMatchObject({ kind: "alias", indices: [fixture().index] });
      });
    });

    it("givenMissingIndex_whenDescribed_thenStatementFailed", async () => {
      await withIndices(async (indices) => {
        expect(await rejectionCode(indices.describe(`${fixture().index}_missing`))).toBe("statementFailed");
      });
    });

    it("givenMoreDocumentsThanAPage_whenSearched_thenEveryRowOnceInOrder", async () => {
      await withIndices(async (indices) => {
        const outcome = await indices.search(request());
        const names = outcome.result.columns.map((column) => column.name);
        expect(names).toContain(SEARCH_ID_COLUMN);
        expect(names.at(-1)).toBe(SEARCH_SOURCE_COLUMN);
        expect(outcome.total).toEqual({ value: String(fixture().documents), relation: "eq" });
        expect(outcome.shards.failed).toBe(0);
        expect(outcome.request).toContain("_search");
        const ids = await idsOf(outcome);
        expect(ids).toHaveLength(fixture().documents);
        expect(new Set(ids).size).toBe(fixture().documents);
        expect(ids).toEqual([...ids].sort());
      });
    });

    it("givenLuceneAndDsl_whenSearched_thenSameMatches", async () => {
      await withIndices(async (indices) => {
        const { lucene, dsl, ids } = fixture().query;
        for (const query of [request({ query: lucene }), request({ language: "dsl", query: dsl })]) {
          const outcome = await indices.search(query);
          expect(await idsOf(outcome)).toEqual(ids);
          expect(await indices.count(query)).toBe(String(ids.length));
        }
      });
    });

    it("givenBadLucene_whenSearched_thenStatementFailed", async () => {
      await withIndices(async (indices) => {
        expect(await rejectionCode(indices.search(request({ query: "name:(" })))).toBe("statementFailed");
      });
    });

    it("givenTimeRange_whenSearchedAndCharted_thenBucketsAddUpToCount", async () => {
      await withIndices(async (indices) => {
        const { field, from, to, inRange } = fixture().time;
        const timed = request({ time: { field, from, to } });
        expect(await indices.count(timed)).toBe(String(inRange));
        const histogram = await indices.histogram(timed, HISTOGRAM_BUCKETS);
        expect(histogram.field).toBe(field);
        expect(histogram.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(inRange);
      });
    });

    it("givenField_whenAnalyzed_thenStepsEndInItsTokens", async () => {
      await withIndices(async (indices) => {
        const { field, text, tokens } = fixture().analyze;
        const steps = await indices.analyze({ target: fixture().index, field, analyzer: null, text });
        expect(steps.length).toBeGreaterThan(0);
        expect(steps.at(-1)?.tokens.map((token) => token.token)).toEqual(tokens);
      });
    });
  });
}
