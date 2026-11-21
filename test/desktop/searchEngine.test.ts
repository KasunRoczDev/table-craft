import { describe, expect, it, vi } from "vitest";
import {
  PluginError,
  z,
  type Capability,
  type DatasourcePlugin,
  type IndexBrowser,
  type SearchRequest,
  type Session,
} from "@table-craft/plugin-api";
import type { PluginLoadResult } from "@table-craft/core";
import { createEngine } from "@table-craft/desktop/engine/engine.js";
import { READ_ONLY_STATEMENT_HINT } from "@table-craft/desktop/engine/failures.js";
import { RESULT_FETCH_ALL_CAP, RESULT_PAGE_ROWS, type EngineResponse } from "@table-craft/desktop/engine/protocol.js";
import { SILENT_COMMAND_LANGUAGE, withDeclaredServices } from "../support/declaredServices.js";
import { fakeManifest } from "../support/manifests.js";

const PAGING = { pageRows: RESULT_PAGE_ROWS, fetchAllCap: RESULT_FETCH_ALL_CAP };
const CAPABILITIES: Capability[] = ["commands", "searchIndices"];
const TARGET = "orders";
const REQUEST: SearchRequest = {
  target: TARGET,
  language: "lucene",
  query: "",
  sort: [],
  time: null,
  fields: null,
  pageSize: 50,
};
const SEARCH_REFUSED = "This user lacks the privilege for indices:data/read/search (read or all): denied";
const ANALYZE_REFUSED = "This user lacks the privilege for indices:admin/analyze: denied";

/** Per-index-pattern permissions: listing and the mapping answer, searching and analyzing are refused. */
function guarded(): IndexBrowser {
  const refused = (message: string) => () => Promise.reject(new PluginError("statementFailed", message));
  return {
    list: vi.fn().mockResolvedValue([{ name: TARGET, kind: "index", hidden: false }]),
    describe: vi
      .fn()
      .mockResolvedValue({ name: TARGET, kind: "index", indices: [TARGET], mappingType: null, fields: [] }),
    search: vi.fn(refused(SEARCH_REFUSED)),
    count: vi.fn(refused(SEARCH_REFUSED)),
    histogram: vi.fn(refused(SEARCH_REFUSED)),
    analyze: vi.fn(refused(ANALYZE_REFUSED)),
  };
}

function setup(indices: IndexBrowser, readOnly: boolean) {
  const session: Session = {
    execute: vi.fn(),
    serverVersion: null,
    close: vi.fn(),
    services: { searchIndices: indices },
  };
  const plugin: DatasourcePlugin = {
    id: "search-fake",
    capabilities: CAPABILITIES,
    commandLanguage: SILENT_COMMAND_LANGUAGE,
    connectionSchema: z.object({}),
    connect: () => Promise.resolve(withDeclaredServices(session, CAPABILITIES)),
  };
  const loaded: PluginLoadResult = {
    status: "loaded",
    directory: "plugins/search-fake",
    manifest: fakeManifest({ id: plugin.id, name: "Search fake", capabilities: CAPABILITIES }),
    plugin,
  };
  return createEngine({
    datasource: { id: "s", pluginId: plugin.id, config: {}, readOnly, keepAliveSeconds: 0 },
    plugins: [loaded],
  });
}

function failureOf(response: EngineResponse) {
  if (response.type !== "engine.error") throw new Error("expected the request to fail");
  return response.error;
}

describe("search engine routes under per-index permissions", () => {
  it("givenReadOnlyDatasource_whenEveryIndexViewIsRefused_thenEachFailsAsAStatementAndTheTreeStillAnswers", async () => {
    const engine = setup(guarded(), true);
    const connection = engine.connect();
    const opened = await connection.handle({ id: 1, type: "session.open" });
    if (opened.type === "engine.error") throw new Error(opened.error.message);
    const { sessionId } = opened.result as { sessionId: string };

    const refusals = [
      await connection.handle({ id: 2, type: "indices.open", sessionId, request: REQUEST, ...PAGING }),
      await connection.handle({ id: 3, type: "indices.count", request: REQUEST }),
      await connection.handle({ id: 4, type: "indices.histogram", request: REQUEST, buckets: 60 }),
      await connection.handle({
        id: 5,
        type: "indices.analyze",
        request: { target: TARGET, field: null, analyzer: "standard", text: "fox" },
      }),
    ].map(failureOf);

    for (const failure of refusals) {
      expect(failure.code).toBe("statementFailed");
      expect(failure.message).toMatch(/^This user lacks the privilege for indices:/);
      expect(failure.hint).not.toBe(READ_ONLY_STATEMENT_HINT);
    }
    expect(refusals[3]?.message).toBe(ANALYZE_REFUSED);

    const listed = await connection.handle({ id: 6, type: "indices.list" });
    const described = await connection.handle({ id: 7, type: "indices.describe", target: TARGET });
    expect(listed.type).toBe("indices.list");
    expect(described.type).toBe("indices.describe");
    await engine.close();
  });
});
