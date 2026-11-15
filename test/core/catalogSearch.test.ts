import { describe, expect, it } from "vitest";
import { searchCatalog, type CatalogSearchHit } from "@table-craft/core";
import type { ColumnMeta, NamespaceCatalog, Relation, RelationKind } from "@table-craft/plugin-api";

type ColumnSpec = readonly [name: string, type: string, comment?: string];

function column([name, type, comment]: ColumnSpec, position: number): ColumnMeta {
  return { name, position, type, nullable: true, default: null, comment: comment ?? null, autoIncrement: false };
}

function relation(
  name: string,
  columns: readonly ColumnSpec[],
  options: { readonly kind?: RelationKind; readonly comment?: string } = {},
): Relation {
  return {
    name,
    kind: options.kind ?? "table",
    comment: options.comment ?? null,
    columns: columns.map((spec, index) => column(spec, index + 1)),
    primaryKey: null,
    uniqueKeys: [],
    foreignKeys: [],
    indexes: [],
  };
}

function catalog(path: string, ...relations: Relation[]): NamespaceCatalog {
  return { path: [path], relations, routines: [], sequences: [] };
}

const SHOP = catalog(
  "main",
  relation("customers", [
    ["id", "INTEGER"],
    ["name", "TEXT"],
    ["email", "TEXT"],
  ]),
  relation("orders", [
    ["id", "INTEGER"],
    ["customer_id", "INTEGER"],
    ["amt", "REAL", "order total"],
  ]),
  relation(
    "customer_totals",
    [
      ["customer_id", "INTEGER"],
      ["total", "REAL"],
    ],
    { kind: "view" },
  ),
);

function named(hit: CatalogSearchHit): string {
  return [...hit.path, hit.relation, ...(hit.column === undefined ? [] : [hit.column.name])].join(".");
}

describe("catalog search", () => {
  it("givenExactName_whenSearching_thenTableHitRanksFirst", () => {
    const [first] = searchCatalog([SHOP], "customers", "all");

    expect(first).toEqual({ path: ["main"], relation: "customers", kind: "table", match: "exact" });
  });

  it("givenPrefix_whenSearching_thenPrefixBeatsWordAndContains", () => {
    const hits = searchCatalog([SHOP], "customer", "all");

    expect(hits.map((hit) => [named(hit), hit.match])).toEqual([
      ["main.customers", "prefix"],
      ["main.customer_totals", "prefix"],
      ["main.orders.customer_id", "prefix"],
      ["main.customer_totals.customer_id", "prefix"],
    ]);
  });

  it("givenSnakeCaseColumn_whenSearchingAfterUnderscore_thenWordMatch", () => {
    const hits = searchCatalog([SHOP], "id", "columns");

    expect(hits.find((hit) => named(hit) === "main.orders.customer_id")?.match).toBe("word");
    expect(hits[0]?.match).toBe("exact");
  });

  it("givenMixedCaseQuery_whenSearching_thenMatchIgnoresCase", () => {
    const hits = searchCatalog([SHOP], "MAIL", "all");

    expect(hits).toEqual([
      {
        path: ["main"],
        relation: "customers",
        kind: "table",
        column: { name: "email", type: "TEXT" },
        match: "contains",
      },
    ]);
  });

  it("givenCamelCaseName_whenSearchingTheSecondWord_thenWordMatch", () => {
    const hits = searchCatalog([catalog("app", relation("userAccounts", []))], "accounts", "all");

    expect(hits.map((hit) => hit.match)).toEqual(["word"]);
  });

  it("givenCommentOnly_whenSearching_thenCommentHitRanksLast", () => {
    const hits = searchCatalog([SHOP], "total", "all");

    expect(hits.map((hit) => [named(hit), hit.match])).toEqual([
      ["main.customer_totals.total", "exact"],
      ["main.customer_totals", "word"],
      ["main.orders.amt", "comment"],
    ]);
  });

  it("givenNameAndCommentMatch_whenSearching_thenOneHitByName", () => {
    const commented = catalog("main", relation("orders", [], { comment: "every order placed" }));

    expect(searchCatalog([commented], "order", "tables")).toEqual([
      { path: ["main"], relation: "orders", kind: "table", match: "prefix" },
    ]);
  });

  it("givenTablesScope_whenSearching_thenNoColumnHits", () => {
    const hits = searchCatalog([SHOP], "customer", "tables");

    expect(hits.map(named)).toEqual(["main.customers", "main.customer_totals"]);
  });

  it("givenView_whenSearching_thenHitCarriesViewKind", () => {
    const hits = searchCatalog([SHOP], "customer_totals", "tables");

    expect(hits).toEqual([{ path: ["main"], relation: "customer_totals", kind: "view", match: "exact" }]);
  });

  it("givenTwoCatalogs_whenSearching_thenTiesKeepCatalogOrder", () => {
    const other = catalog("archive", relation("customers", []));

    expect(searchCatalog([other, SHOP], "customers", "tables").map(named)).toEqual([
      "archive.customers",
      "main.customers",
    ]);
  });

  it("givenNoMatch_whenSearching_thenEmpty", () => {
    expect(searchCatalog([SHOP], "invoice", "all")).toEqual([]);
    expect(searchCatalog([SHOP], "   ", "all")).toEqual([]);
  });
});
