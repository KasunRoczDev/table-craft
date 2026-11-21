import { describe, expect, it } from "vitest";
import { isPluginError, type SearchRequest } from "@table-craft/plugin-api";
import {
  acceptedReply,
  isForbidden,
  isTimedOut,
  missingPrivilege,
  replyError,
  type ElasticTransport,
  type HttpMethod,
  type Reply,
  type RequestOptions,
} from "@table-craft/plugin-elasticsearch/client";
import { probe } from "@table-craft/plugin-elasticsearch/connect";
import { runRequest } from "@table-craft/plugin-elasticsearch/console";
import { dialectOf, distributionOfVersion, parseVersion } from "@table-craft/plugin-elasticsearch/dialect";
import { ElasticIndices, SEARCH_TIMEOUT } from "@table-craft/plugin-elasticsearch/search";
import { nodeList } from "@table-craft/plugin-elasticsearch/server";

interface Sent {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body: unknown;
}

type Answer = (method: HttpMethod, path: string, body: unknown) => Reply;

const ADDRESS = "gateway.example:443";
const TIME_FIELD = "@timestamp";
const TARGET = "logs-checkout";
const SCROLL_ID = "scroll-1";

function json(body: unknown, status = 200): Reply {
  return { status, body, text: JSON.stringify(body) };
}

function errorReply(status: number, reason: string): Reply {
  return json({ error: { type: "gateway_exception", reason }, status }, status);
}

/** A transport that is not HTTP: it answers from `answer` and settles statuses through the plugin's own seam. */
class FakeTransport implements ElasticTransport {
  readonly address = ADDRESS;
  readonly sent: Sent[] = [];
  readonly released: string[][] = [];
  closed = false;
  releaseCursors?: (ids: readonly string[]) => Promise<void>;

  constructor(
    readonly answer: Answer,
    releases: boolean,
  ) {
    if (releases) {
      this.releaseCursors = (ids) => {
        this.released.push([...ids]);
        return Promise.resolve();
      };
    }
  }

  request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<Reply> {
    this.sent.push({ method, path, body: options.body });
    return Promise.resolve().then(() => acceptedReply(this.answer(method, path, options.body), options));
  }

  close(): void {
    this.closed = true;
  }
}

const MAPPING = {
  [TARGET]: { mappings: { properties: { [TIME_FIELD]: { type: "date" }, message: { type: "text" } } } },
};

function hit(id: number) {
  return { _id: `e-${String(id)}`, _index: TARGET, _source: { message: `m${String(id)}` } };
}

/** A small log index: two pages of one hit each, then nothing. */
function logsCluster(options: { timedOut?: boolean } = {}): Answer {
  return (method, path) => {
    if (path.startsWith("/_cat/indices/")) return json([{ index: TARGET }]);
    if (path.endsWith("/_mapping")) return json(MAPPING);
    if (path.includes("/_search?scroll=")) {
      return json({
        _scroll_id: SCROLL_ID,
        took: 3,
        timed_out: options.timedOut === true,
        _shards: { total: 1, successful: 1, skipped: 0, failed: 0 },
        hits: { total: { value: 2, relation: "eq" }, hits: [hit(1)] },
      });
    }
    if (path === "/_search/scroll" && method === "POST") return json({ _scroll_id: SCROLL_ID, hits: { hits: [] } });
    if (path === "/_search/scroll" && method === "DELETE") return json({ succeeded: true });
    if (path.endsWith("/_search")) {
      return json({
        timed_out: options.timedOut === true,
        hits: { total: { value: 2, relation: "eq" }, hits: [] },
        aggregations: { over_time: { buckets: [{ key: 0, doc_count: 2 }] } },
      });
    }
    return errorReply(404, `no answer for ${path}`);
  };
}

function searchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    target: TARGET,
    language: "lucene",
    query: "",
    sort: [],
    time: { field: TIME_FIELD, from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z" },
    fields: null,
    pageSize: 1,
    ...overrides,
  };
}

async function drain(rows: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const _row of rows) count += 1;
  return count;
}

async function failure(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const ELASTIC_8 = dialectOf("elasticsearch", "8.19.7");

describe("elasticsearch transport seam", () => {
  it("givenTransportThatReleasesCursors_whenRowsRunOut_thenScrollFreedThroughIt", async () => {
    const transport = new FakeTransport(logsCluster(), true);
    const indices = new ElasticIndices(transport, ELASTIC_8, "");
    const outcome = await indices.search(searchRequest());
    expect(await drain(outcome.result.rows)).toBe(1);
    expect(transport.released).toEqual([[SCROLL_ID]]);
    expect(transport.sent.some((sent) => sent.method === "DELETE")).toBe(false);
    expect(indices.openScrolls).toBe(0);
  });

  it("givenPlainTransport_whenSessionClosesWithAScrollOpen_thenDeleteScrollSent", async () => {
    const transport = new FakeTransport(logsCluster(), false);
    const indices = new ElasticIndices(transport, ELASTIC_8, "");
    await indices.search(searchRequest());
    expect(indices.openScrolls).toBe(1);
    await indices.close();
    expect(transport.sent.at(-1)).toEqual({
      method: "DELETE",
      path: "/_search/scroll",
      body: { scroll_id: [SCROLL_ID] },
    });
  });

  it("givenSearchCountAndHistogram_whenSent_thenEveryBodyCarriesTheTimeout", async () => {
    const transport = new FakeTransport(logsCluster(), true);
    const indices = new ElasticIndices(transport, ELASTIC_8, "");
    const outcome = await indices.search(searchRequest());
    await indices.count(searchRequest());
    await indices.histogram(searchRequest(), 60);
    const searches = transport.sent.filter((sent) => sent.path.includes("/_search") && sent.method === "POST");
    const firstPages = searches.filter((sent) => sent.path !== "/_search/scroll");
    expect(firstPages).toHaveLength(3);
    for (const sent of firstPages) expect(sent.body).toMatchObject({ timeout: SEARCH_TIMEOUT });
    expect(outcome.request).toContain(`"timeout": "${SEARCH_TIMEOUT}"`);
  });

  it("givenCount_whenCounted_thenExactTotalOfASizeZeroSearch", async () => {
    const transport = new FakeTransport(logsCluster(), true);
    const count = await new ElasticIndices(transport, ELASTIC_8, "").count(searchRequest());
    expect(count).toBe("2");
    expect(transport.sent.at(-1)?.body).toMatchObject({ size: 0, track_total_hits: true });
  });

  it("givenSearchTimedOutOnTheServer_whenSearched_thenPartialHitsWithAWarning", async () => {
    const transport = new FakeTransport(logsCluster({ timedOut: true }), true);
    const indices = new ElasticIndices(transport, ELASTIC_8, "");
    const outcome = await indices.search(searchRequest());
    expect(outcome.warnings.join(" ")).toMatch(/timed out on the server/);
    const histogram = await indices.histogram(searchRequest(), 60);
    expect(histogram.buckets).toHaveLength(1);
  });

  it("givenCountTimedOutOnTheServer_whenCounted_thenStatementFailedNotAWrongNumber", async () => {
    const transport = new FakeTransport(logsCluster({ timedOut: true }), true);
    const error = await failure(new ElasticIndices(transport, ELASTIC_8, "").count(searchRequest()));
    expect(isPluginError(error) && error.code === "statementFailed").toBe(true);
    expect(String((error as Error).message)).toContain(SEARCH_TIMEOUT);
  });

  it("givenConsoleRequest_whenRunOverATransport_thenSentThroughIt", async () => {
    const transport = new FakeTransport(() => json([{ index: TARGET, health: "green" }]), false);
    const result = await runRequest(
      { transport, dialect: ELASTIC_8, readOnly: true, signal: new AbortController().signal },
      "GET _cat/indices",
    );
    expect(transport.sent[0]?.path).toBe("/_cat/indices?format=json");
    expect(result.columns.map((column) => column.name)).toEqual(["index", "health"]);
  });

  it("givenNodesRefused_whenListed_thenTheTransportsAddressStandsIn", async () => {
    const transport = new FakeTransport(() => errorReply(403, "no monitor privilege"), false);
    const nodes = await nodeList(transport);
    expect(nodes.map((node) => node.address)).toEqual([ADDRESS]);
  });
});

/** Per-index-pattern permissions: the mapping reads, but searching and analyzing are refused. */
function guardedCluster(): Answer {
  const logs = logsCluster();
  return (method, path, body) => {
    if (path.includes("/_search") || path.endsWith("/_analyze") || path.includes("/_validate/query")) {
      const action = path.endsWith("/_analyze") ? "indices:admin/analyze" : "indices:data/read/search";
      return json(
        {
          error: {
            type: "security_exception",
            reason: `action [${action}] is unauthorized for user [reader] on indices [${TARGET}]`,
          },
          status: 403,
        },
        403,
      );
    }
    if (path.endsWith("/_settings")) return json({ [TARGET]: { settings: { index: { number_of_shards: "1" } } } });
    return logs(method, path, body);
  };
}

describe("elasticsearch per-index permissions", () => {
  const views: Record<string, (indices: ElasticIndices) => Promise<unknown>> = {
    search: (indices) => indices.search(searchRequest()),
    count: (indices) => indices.count(searchRequest()),
    histogram: (indices) => indices.histogram(searchRequest(), 60),
    analyze: (indices) => indices.analyze({ target: TARGET, field: null, analyzer: "standard", text: "Quick fox" }),
  };

  for (const [view, run] of Object.entries(views)) {
    it(`givenForbidden${view}_whenRun_thenStatementFailureNamingThePrivilege`, async () => {
      const indices = new ElasticIndices(new FakeTransport(guardedCluster(), true), ELASTIC_8, "");
      const error = await failure(run(indices));
      expect(isPluginError(error) && error.code === "statementFailed").toBe(true);
      expect(isForbidden(error)).toBe(true);
      expect((error as Error).message).toMatch(
        /^This user lacks the privilege for indices:(data\/read\/search|admin\/analyze)/,
      );
      expect(indices.openScrolls).toBe(0);
    });
  }

  it("givenSearchRefused_whenTheMappingIsRead_thenItStillAnswers", async () => {
    const indices = new ElasticIndices(new FakeTransport(guardedCluster(), true), ELASTIC_8, "");
    await failure(indices.search(searchRequest()));
    const description = await indices.describe(TARGET);
    expect(description.fields.map((field) => field.path)).toContain(TIME_FIELD);
  });
});

describe("elasticsearch error seam", () => {
  it("givenForbiddenStatus_whenBuilt_thenPermissionError", () => {
    const error = replyError(errorReply(403, "action is unauthorized"));
    expect(isForbidden(error)).toBe(true);
    expect(error.message).toContain("action is unauthorized");
  });

  it("givenGatewayTimeout_whenBuilt_thenTimedOutWithAdvice", () => {
    const error = replyError({ status: 504, body: null, text: "upstream timed out" });
    expect(isTimedOut(error)).toBe(true);
    expect(isForbidden(error)).toBe(false);
    expect(error.message).toMatch(/timed out at a gateway: upstream timed out\. Narrow/);
  });

  it("givenElasticsearchSecurityReason_whenForbidden_thenMessageNamesTheMissingPrivilege", () => {
    const reason =
      "action [indices:data/read/search] is unauthorized for user [reader] with effective roles [logs] on indices " +
      "[orders], this action is granted by the index privileges [read,all]";
    const error = replyError(json({ error: { type: "security_exception", reason }, status: 403 }, 403));
    expect(missingPrivilege(reason)).toBe("the privilege for indices:data/read/search (read or all)");
    expect(error.message).toMatch(/^This user lacks the privilege for indices:data\/read\/search \(read or all\): /);
    expect(error.message).toContain("Ask a cluster admin");
  });

  it("givenOpenSearchSecurityReason_whenForbidden_thenMessageNamesTheDeniedAction", () => {
    const reason = "no permissions for [indices:admin/analyze] and User [name=reader, backend_roles=[]]";
    expect(missingPrivilege(reason)).toBe("the privilege for indices:admin/analyze");
    expect(replyError(errorReply(403, reason)).message).toMatch(/^This user lacks the privilege for indices:admin/);
  });

  it("givenForbiddenReasonWithoutAnAction_whenBuilt_thenGenericPermissionMessage", () => {
    expect(missingPrivilege("blocked by policy")).toBeNull();
    expect(replyError(errorReply(403, "blocked by policy")).message).toMatch(/^This user is not allowed to do that/);
  });

  it("givenAcceptedStatus_whenSettled_thenReplyKept", () => {
    const reply = errorReply(404, "missing");
    expect(acceptedReply(reply, { accept: [404] })).toBe(reply);
    expect(() => acceptedReply(reply)).toThrow(/missing/);
  });
});

/** A cluster whose probes answer as `answers` says, by path; anything else is a 404. */
function probing(answers: Readonly<Record<string, Reply>>): FakeTransport {
  return new FakeTransport((_method, path) => answers[path] ?? errorReply(404, `no ${path}`), false);
}

const ROOT = "/";
const LOCAL_NODE = "/_nodes/_local/version";
const CAT_NODES = "/_cat/nodes?h=version&format=json";

describe("elasticsearch probe", () => {
  it("givenRootAnswers_whenProbed_thenNoOtherProbe", async () => {
    const transport = probing({
      [ROOT]: json({ cluster_name: "shop", version: { number: "8.19.7" } }),
    });
    const found = await probe(transport);
    expect([found.dialect.distribution, found.dialect.versionText, found.clusterName]).toEqual([
      "elasticsearch",
      "8.19.7",
      "shop",
    ]);
    expect(transport.sent.map((sent) => sent.path)).toEqual([ROOT]);
  });

  it("givenRootForbidden_whenProbed_thenLocalNodeAnswers", async () => {
    const transport = probing({
      [ROOT]: errorReply(403, "no monitor privilege"),
      [LOCAL_NODE]: json({ cluster_name: "logs", nodes: { a: { version: "2.19.1", distribution: "opensearch" } } }),
    });
    const found = await probe(transport);
    expect([found.dialect.distribution, found.dialect.versionText, found.clusterName]).toEqual([
      "opensearch",
      "2.19.1",
      "logs",
    ]);
  });

  it.each([502, 503, 504])("givenGatewayStatus %s_whenProbed_thenCatNodesAnswers", async (status) => {
    const transport = probing({
      [ROOT]: errorReply(status, "upstream failed"),
      [LOCAL_NODE]: errorReply(403, "not on the allow list"),
      [CAT_NODES]: json([{ version: "2.19.1" }, { version: "2.18.0" }]),
    });
    const found = await probe(transport);
    expect([found.dialect.distribution, found.dialect.versionText, found.clusterName]).toEqual([
      "opensearch",
      "2.18.0",
      null,
    ]);
    expect(transport.sent.map((sent) => sent.path)).toEqual([ROOT, LOCAL_NODE, CAT_NODES]);
  });

  it("givenRootTimesOut_whenProbed_thenCatNodesNamesElasticsearch", async () => {
    const timedOut = Object.assign(new Error("Elasticsearch did not answer within 30 s"), { timedOut: true });
    const transport = new FakeTransport((_method, path) => {
      if (path === ROOT) throw timedOut;
      if (path === CAT_NODES) return json([{ version: "7.17.25" }]);
      return errorReply(403, "denied");
    }, false);
    const found = await probe(transport);
    expect([found.dialect.distribution, found.dialect.versionText]).toEqual(["elasticsearch", "7.17.25"]);
  });

  it("givenUnauthorized_whenProbed_thenSaidWithoutTryingOthers", async () => {
    const transport = probing({ [ROOT]: errorReply(401, "missing authentication credentials") });
    const error = await failure(probe(transport));
    expect(String((error as Error).message)).toContain("refused the credentials");
    expect(transport.sent).toHaveLength(1);
  });

  it("givenEveryProbeRefused_whenProbed_thenTheFirstRefusalSaid", async () => {
    const transport = probing({
      [ROOT]: errorReply(504, "root timed out"),
      [LOCAL_NODE]: errorReply(403, "denied"),
      [CAT_NODES]: errorReply(403, "denied"),
    });
    const error = await failure(probe(transport));
    expect(String((error as Error).message)).toContain("root timed out");
  });

  it.each([
    ["1.3.20", "opensearch"],
    ["3.1.0", "opensearch"],
    ["6.8.23", "elasticsearch"],
    ["9.1.0", "elasticsearch"],
  ])("givenBareVersion %s_whenGuessed_then %s", (text, distribution) => {
    const version = parseVersion(text);
    expect(version === null ? null : distributionOfVersion(version)).toBe(distribution);
  });
});
