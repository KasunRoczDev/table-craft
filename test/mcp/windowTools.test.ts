import { describe, expect, it } from "vitest";
import type { SearchTargetDescription } from "@table-craft/plugin-api";
import type { AgentEngine } from "@table-craft/desktop/mcp/engines.js";
import { EngineCallError } from "@table-craft/desktop/mcp/engines.js";
import type { AgentDatasource } from "@table-craft/desktop/mcp/messages.js";
import { createTools } from "@table-craft/desktop/mcp/tools.js";
import { agentHarness, agentCaller, textOf, type AgentHarness } from "../support/mcpHarness.js";

const SHOP: AgentDatasource = { id: "shop", name: "Shop", pluginId: "sqlite", comment: null, access: "read" };
const LOGS: AgentDatasource = { id: "logs", name: "Logs", pluginId: "elasticsearch", comment: null, access: "read" };

const LOGS_INDEX: SearchTargetDescription = {
  name: "logs-checkout",
  kind: "index",
  indices: ["logs-checkout"],
  mappingType: null,
  fields: [
    { path: "@timestamp", type: "date", multiOf: null, analyzer: null, aggregatable: true },
    { path: "message", type: "text", multiOf: null, analyzer: null, aggregatable: false },
    { path: "status", type: "keyword", multiOf: null, analyzer: null, aggregatable: true },
  ],
  timeField: "@timestamp",
  mapping: null,
  settings: null,
  warnings: [],
};

/** The MCP tools over one search datasource whose engine describes `description`, or fails to. */
function searchHarness(access: AgentDatasource["access"], description: SearchTargetDescription | null = LOGS_INDEX) {
  const harness = agentHarness([{ ...LOGS, access }]);
  const engine = {
    call: (type: string) =>
      type === "indices.describe" && description !== null
        ? Promise.resolve(description)
        : Promise.reject(new EngineCallError("notFound", "no such index [nope]", null)),
    capabilities: () => Promise.resolve(["commands", "searchIndices"]),
  } as unknown as AgentEngine;
  const tools = createTools({
    ...harness.context,
    engines: { engine: () => Promise.resolve(engine), drop: () => undefined, closeAll: () => undefined },
  });
  return {
    window: harness.window,
    call: async (args: Record<string, unknown>) =>
      (await tools.call("open_index", { datasource: "logs", index: "logs-checkout", ...args }, agentCaller())).result,
  };
}

function lastRequest(window: AgentHarness["window"]) {
  return window.requests.at(-1)?.request;
}

describe("MCP window tools", () => {
  it("givenReadAccess_whenOpenTableWithWhere_thenApplied", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_table", {
      datasource: "shop",
      schema: "main",
      table: "orders",
      where: "customer_id = 1",
      orderBy: "id DESC",
    });

    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toMatchObject({ applied: true, focused: false });
    expect(harness.window.requests[0]).toMatchObject({
      target: "focused",
      request: {
        kind: "openTable",
        path: ["main"],
        table: "orders",
        where: "customer_id = 1",
        orderBy: "id DESC",
        draftOnly: false,
      },
    });
    expect(harness.history).toEqual([]);
  });

  it("givenAskReads_whenOpenTableWithWhere_thenDraftedOnly", async () => {
    const harness = agentHarness([{ ...SHOP, access: "askReads" }]);

    const answer = await harness.call("open_table", {
      datasource: "shop",
      schema: "main",
      table: "orders",
      where: "customer_id = 1",
    });

    expect(answer.structuredContent).toMatchObject({ applied: false });
    expect(textOf(answer)).toContain("the user applies it");
    expect(harness.window.requests[0]?.request).toMatchObject({ draftOnly: true });
  });

  it("givenSecondStatementInWhere_whenOpenTable_thenRefused", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_table", {
      datasource: "shop",
      schema: "main",
      table: "orders",
      where: "1=1; DELETE FROM orders",
    });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("The filter must form one read");
    expect(harness.window.requests).toEqual([]);
  });

  it("givenOffDatasource_whenOpenTable_thenRefused", async () => {
    const harness = agentHarness([{ ...SHOP, access: "off" }]);

    const answer = await harness.call("open_table", { datasource: "shop", schema: "main", table: "orders" });

    expect(answer.isError).toBe(true);
    expect(harness.window.requests).toEqual([]);
  });

  it("givenKnownColumn_whenReveal_thenWindowAskedToSelectIt", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("reveal_in_explorer", {
      datasource: "shop",
      schema: "main",
      table: "customers",
      column: "name",
    });

    expect(answer.structuredContent).toEqual({ found: true, focused: false });
    expect(harness.window.requests[0]?.request).toMatchObject({
      kind: "reveal",
      path: ["main"],
      relation: { name: "customers", kind: "table" },
      column: "name",
    });
  });

  it("givenUnknownTable_whenReveal_thenFoundFalse", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("reveal_in_explorer", { datasource: "shop", schema: "main", table: "nope" });

    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toEqual({ found: false });
    expect(harness.window.requests).toEqual([]);
  });

  it("givenQuerySortAndRange_whenOpenIndex_thenWindowSearchesWithThem", async () => {
    const harness = searchHarness("read");

    const answer = await harness.call({
      query: 'message:"\\"log.level\\":\\"ERROR\\""',
      sort: { field: "@timestamp" },
      range: "24h",
    });

    expect(answer.isError).not.toBe(true);
    expect(answer.structuredContent).toEqual({
      index: "logs-checkout",
      timeField: "@timestamp",
      searched: true,
      focused: false,
    });
    expect(textOf(answer)).toContain("Call open_index again");
    expect(lastRequest(harness.window)).toEqual({
      kind: "openIndex",
      datasourceId: "logs",
      target: "logs-checkout",
      search: {
        query: 'message:"\\"log.level\\":\\"ERROR\\""',
        sort: { field: "@timestamp", order: "desc" },
        range: "24h",
      },
      draftOnly: false,
      focus: false,
    });
  });

  it("givenFromAndTo_whenOpenIndex_thenWindowGetsACustomRange", async () => {
    const harness = searchHarness("read");

    await harness.call({ from: "2026-11-21T15:00:00Z", to: "2026-11-21T15:10:00Z", sort: null });

    expect(lastRequest(harness.window)).toMatchObject({
      search: { window: { from: "2026-11-21T15:00:00Z", to: "2026-11-21T15:10:00Z" }, sort: null },
    });
  });

  it("givenRangeAndFrom_whenOpenIndex_thenArgumentsRefused", async () => {
    const harness = searchHarness("read");

    const answer = await harness.call({ range: "1h", from: "2026-11-21T15:00:00Z" });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("Give either range or from and to.");
    expect(harness.window.requests).toEqual([]);
  });

  it("givenAskReads_whenOpenIndexWithQuery_thenBarFilledInOnly", async () => {
    const harness = searchHarness("askReads");

    const answer = await harness.call({ query: "status:500" });

    expect(answer.structuredContent).toMatchObject({ searched: false });
    expect(textOf(answer)).toContain("the user runs it");
    expect(lastRequest(harness.window)).toMatchObject({ draftOnly: true });
  });

  it("givenTextField_whenOpenIndexSortedByIt_thenRefused", async () => {
    const harness = searchHarness("read");

    const answer = await harness.call({ sort: { field: "message", order: "asc" } });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain('"message" is not a field logs-checkout can sort by');
    expect(harness.window.requests).toEqual([]);
  });

  it("givenDslThatIsNotAnObject_whenOpenIndex_thenRefused", async () => {
    const harness = searchHarness("read");

    const answer = await harness.call({ language: "dsl", query: "status:500" });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("one Query DSL query object");
    expect(harness.window.requests).toEqual([]);
  });

  it("givenUnknownIndex_whenOpenIndex_thenServerErrorReturned", async () => {
    const harness = searchHarness("read", null);

    const answer = await harness.call({ query: "status:500" });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain('Logs could not describe "logs-checkout": no such index [nope]');
    expect(harness.window.requests).toEqual([]);
  });

  it("givenSqlDatasource_whenOpenIndex_thenRefusedForTheCapability", async () => {
    const harness = agentHarness([SHOP]);

    const answer = await harness.call("open_index", { datasource: "shop", index: "orders" });

    expect(answer.isError).toBe(true);
    expect(textOf(answer)).toContain("lacks the searchIndices capability");
    expect(harness.window.requests).toEqual([]);
  });
});
