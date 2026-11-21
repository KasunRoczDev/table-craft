import { describe, expect, it } from "vitest";
import { complete } from "@table-craft/plugin-elasticsearch/complete";
import { classify, parseRequest, split } from "@table-craft/plugin-elasticsearch/language";

function spansOf(text: string): string[] {
  return split(text).map((span) => {
    expect(text.slice(span.from, span.to)).toBe(span.sql);
    return span.sql;
  });
}

describe("elasticsearch console split", () => {
  it("givenRequestsWithBodies_whenSplit_thenOneSpanPerRequest", () => {
    const text = 'GET products/_search\n{\n  "query": { "match_all": {} }\n}\n\n# health\nGET _cluster/health';
    expect(spansOf(text)).toEqual([
      'GET products/_search\n{\n  "query": { "match_all": {} }\n}',
      "GET _cluster/health",
    ]);
  });

  it("givenBulkNdjson_whenSplit_thenTheBodyKeepsEveryLine", () => {
    const text = 'POST _bulk\n{"index":{"_index":"p","_id":"1"}}\n{"name":"a"}\nGET p/_count';
    expect(spansOf(text)).toEqual(['POST _bulk\n{"index":{"_index":"p","_id":"1"}}\n{"name":"a"}', "GET p/_count"]);
  });

  it("givenBodyHoldingARequestLineInAString_whenSplit_thenTheBodyStaysWhole", () => {
    const text = 'POST p/_doc\n{\n  "note": "GET x\nstill the body"\n}';
    expect(spansOf(text)).toHaveLength(1);
  });

  it("givenSqlAndPpl_whenSplit_thenTheSemicolonIsDropped", () => {
    const text = "SELECT category, COUNT(*)\nFROM products\nGROUP BY category;\nsource=logs | head 5";
    expect(spansOf(text)).toEqual([
      "SELECT category, COUNT(*)\nFROM products\nGROUP BY category",
      "source=logs | head 5",
    ]);
  });
});

describe("elasticsearch console parse", () => {
  it("givenPathWithoutSlash_whenParsed_thenTheSlashIsAdded", () => {
    expect(parseRequest('get products/_search\n{"size": 1}')).toEqual({
      kind: "rest",
      method: "GET",
      path: "/products/_search",
      body: '{"size": 1}',
    });
  });

  it("givenNeitherRequestNorQuery_whenParsed_thenNull", () => {
    expect(parseRequest("hello world")).toBeNull();
    expect(parseRequest("source=logs | head 1")).toEqual({ kind: "ppl", query: "source=logs | head 1" });
  });
});

describe("elasticsearch classify", () => {
  it.each([
    ["GET products/_search", "read"],
    ["HEAD /", "read"],
    ['POST products/_search\n{"query":{}}', "read"],
    ['POST _search/scroll\n{"scroll_id":"x"}', "read"],
    ['DELETE _search/scroll\n{"scroll_id":"x"}', "read"],
    ['PUT products/_doc/1\n{"a":1}', "write"],
    ["DELETE products/_doc/1", "write"],
    ["PUT products", "ddl"],
    ['PUT products/_mapping\n{"properties":{}}', "ddl"],
    ["SELECT 1", "read"],
  ])("given %s_whenClassified_thenItsKind", (command, kind) => {
    expect(classify(command).kind).toBe(kind);
  });

  it("givenDeleteIndex_whenClassified_thenDestructiveByName", () => {
    const result = classify("DELETE products");
    expect(result.destructive).toContain("products");
    expect(result.confirmByName).toBe(true);
  });

  it("givenDeleteByQueryMatchAll_whenClassified_thenCostlyAndByName", () => {
    const all = classify('POST products/_delete_by_query\n{"query":{"match_all":{}}}');
    expect(all.costly).toBeDefined();
    expect(all.confirmByName).toBe(true);
    const some = classify('POST products/_delete_by_query\n{"query":{"term":{"sku":"p-1"}}}');
    expect(some.destructive).not.toBeNull();
    expect(some.confirmByName).toBe(false);
  });
});

describe("elasticsearch complete", () => {
  it("givenLineStart_whenCompleted_thenMethods", async () => {
    const result = await complete({ text: "G", offset: 1 }, null);
    expect(result.items.map((item) => item.label)).toContain("GET");
  });

  it("givenMethod_whenCompleted_thenEndpointsAndIndices", async () => {
    const session = { suggestIndices: async () => ["products", "orders"] };
    const result = await complete({ text: "GET pro", offset: 7 }, session as never);
    const labels = result.items.map((item) => item.label);
    expect(labels).toContain("products");
    expect(result.from).toBe(4);
  });
});
