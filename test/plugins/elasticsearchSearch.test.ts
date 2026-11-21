import { describe, expect, it } from "vitest";
import type { SearchField } from "@table-craft/plugin-api";
import { dialectOf, rootVersion } from "@table-craft/plugin-elasticsearch/dialect";
import { defaultFields, hitColumns, hitRow, valueAt } from "@table-craft/plugin-elasticsearch/hits";
import { parseMapping, timeFieldOf } from "@table-craft/plugin-elasticsearch/mapping";
import { histogramInterval, queryOf } from "@table-craft/plugin-elasticsearch/query";
import { analyzeSteps, totalOf } from "@table-craft/plugin-elasticsearch/search";

function field(path: string, type: string, multiOf: string | null = null): SearchField {
  return { path, type, multiOf, analyzer: null, aggregatable: type !== "text" };
}

describe("elasticsearch dialect", () => {
  it("givenSix_whenDialect_thenMappingTypesAndScroll", () => {
    const dialect = dialectOf("elasticsearch", "6.8.23");
    expect(dialect.mappingTypes).toBe(true);
    expect(dialect.totalObject).toBe(false);
    expect(dialect.pointInTime).toBe(false);
    expect(dialect.catExpandWildcards).toBe(false);
    expect(dialect.sqlPath).toBe("/_xpack/sql?format=json");
  });

  it("givenOpenSearch_whenDialect_thenPluginsPathsAndPit", () => {
    const dialect = dialectOf("opensearch", "2.19.3");
    expect(dialect.pointInTime).toBe(true);
    expect(dialect.sqlPath).toBe("/_plugins/_sql");
    expect(dialect.pplPath).toBe("/_plugins/_ppl");
    expect(dialect.termsEnum).toBe(false);
  });

  it("givenFive_whenDialect_thenRefused", () => {
    expect(() => dialectOf("elasticsearch", "5.6.16")).toThrow(/older than 6.0/);
  });

  it("givenOpenSearchRoot_whenRead_thenItsDistribution", () => {
    expect(rootVersion({ version: { number: "3.1.0", distribution: "opensearch" } })).toEqual({
      distribution: "opensearch",
      version: "3.1.0",
    });
  });
});

describe("elasticsearch mapping", () => {
  it("givenTypedMappingWithMultiFields_whenParsed_thenFlatFieldsAndType", () => {
    const reply = {
      products: {
        mappings: {
          _doc: {
            properties: {
              name: { type: "text", analyzer: "folding", fields: { raw: { type: "keyword" } } },
              price: { properties: { amount: { type: "scaled_float" } } },
              "@timestamp": { type: "date" },
            },
          },
        },
      },
    };
    const parsed = parseMapping(reply, true);
    expect(parsed.mappingType).toBe("_doc");
    expect(parsed.fields.map((entry) => [entry.path, entry.type, entry.multiOf])).toEqual([
      ["name", "text", null],
      ["name.raw", "keyword", "name"],
      ["price", "object", null],
      ["price.amount", "scaled_float", null],
      ["@timestamp", "date", null],
    ]);
    expect(parsed.fields[0]?.analyzer).toBe("folding");
    expect(timeFieldOf(parsed.fields)).toBe("@timestamp");
  });
});

describe("elasticsearch hits", () => {
  it("givenWideMapping_whenDefaultFields_thenTimeLevelMessageAndKeywords", () => {
    const fields = [
      field("@timestamp", "date"),
      field("message", "text"),
      field("log.level", "keyword"),
      ...Array.from({ length: 60 }, (_, index) => field(`labels.l${String(index)}`, "keyword")),
    ];
    const chosen = defaultFields(fields, "@timestamp");
    expect(chosen.slice(0, 3)).toEqual(["@timestamp", "log.level", "message"]);
    expect(chosen).toHaveLength(8);
  });

  it("givenDottedKeysAndArrays_whenValueAt_thenBothShapesRead", () => {
    expect(valueAt({ "log.level": "error" }, "log.level")).toBe("error");
    expect(valueAt({ log: { level: "warn" } }, "log.level")).toBe("warn");
    expect(valueAt({ lines: [{ sku: "a" }, { sku: "b" }] }, "lines.sku")).toEqual(["a", "b"]);
  });

  it("givenHit_whenRow_thenIdFieldsAndSource", () => {
    const shape = hitColumns(["sku", "price"], [field("sku", "keyword"), field("price", "double")], true, false);
    expect(shape.columns.map((column) => column.name)).toEqual(["_id", "_index", "sku", "price", "_source"]);
    const row = hitRow({ _id: "p-1", _index: "products", _source: { sku: "p-1" } }, shape);
    expect(row.slice(0, 4)).toEqual(["p-1", "products", "p-1", null]);
    expect(row[4]).toEqual({ kind: "json", text: '{"sku":"p-1"}' });
  });
});

describe("elasticsearch query", () => {
  it("givenLuceneAndTime_whenBuilt_thenBoolWithRangeFilter", () => {
    const query = queryOf({
      language: "lucene",
      query: "category:tea",
      time: { field: "@timestamp", from: "2026-01-01T00:00:00Z", to: null },
    });
    expect(query).toEqual({
      bool: {
        must: [{ query_string: { query: "category:tea", default_operator: "AND" } }],
        filter: [{ range: { "@timestamp": { format: "strict_date_optional_time", gte: "2026-01-01T00:00:00Z" } } }],
      },
    });
  });

  it("givenDslBody_whenBuilt_thenItsQuery", () => {
    expect(queryOf({ language: "dsl", query: '{"query":{"term":{"sku":"p-1"}}}', time: null })).toEqual({
      term: { sku: "p-1" },
    });
    expect(() => queryOf({ language: "dsl", query: "{oops", time: null })).toThrow(/not JSON/);
  });

  it("givenAnHourIn60Buckets_whenInterval_thenOneMinute", () => {
    expect(histogramInterval(60 * 60 * 1000, 60)).toBe("1m");
    expect(histogramInterval(15 * 60 * 1000, 60)).toBe("30s");
  });

  it("givenAnOpenHourEndingAFewMillisecondsLate_whenInterval_thenStillOneMinute", () => {
    expect(histogramInterval(60 * 60 * 1000 + 250, 60)).toBe("1m");
    expect(histogramInterval(2 * 60 * 60 * 1000, 60)).toBe("5m");
  });
});

describe("elasticsearch replies", () => {
  it("givenBothTotalShapes_whenRead_thenOneShape", () => {
    expect(totalOf(42)).toEqual({ value: "42", relation: "eq" });
    expect(totalOf({ value: 10000, relation: "gte" })).toEqual({ value: "10000", relation: "gte" });
  });

  it("givenExplainDetail_whenSteps_thenTokenizerThenFilters", () => {
    const steps = analyzeSteps({
      tokenizer: {
        name: "standard",
        tokens: [
          { token: "Crème", position: 0 },
          { token: "to", position: 1 },
        ],
      },
      tokenfilters: [
        {
          name: "lowercase",
          tokens: [
            { token: "crème", position: 0 },
            { token: "to", position: 1 },
          ],
        },
        { name: "length", tokens: [{ token: "crème", position: 0 }] },
      ],
    });
    expect(steps.map((step) => [step.name, step.kind, step.tokens.length])).toEqual([
      ["standard", "tokenizer", 2],
      ["lowercase", "tokenFilter", 2],
      ["length", "tokenFilter", 1],
    ]);
  });
});
