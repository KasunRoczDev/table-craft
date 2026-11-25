import { describe, expect, it } from "vitest";
import type { Row, SearchRequest } from "@table-craft/plugin-api";
import {
  acceptedReply,
  type CursorIds,
  type ElasticTransport,
  type HttpMethod,
  type Reply,
  type RequestOptions,
} from "@table-craft/plugin-elasticsearch/client";
import { dialectOf, type Dialect } from "@table-craft/plugin-elasticsearch/dialect";
import { afterValue, compareSortValues } from "@table-craft/plugin-elasticsearch/paging";
import { ElasticIndices, TRACK_TOTAL_HITS_UP_TO } from "@table-craft/plugin-elasticsearch/search";

const TARGET = "orders";
const PAGE = 5;
const DOCS = 23;
const LATE_FIRST = "late-first";
const LATE_LAST = "late-last";

interface Doc {
  readonly id: string;
  readonly index: string;
  readonly t: number;
  readonly shardDoc: number;
}

interface Sent {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

type Clause = Record<string, { order?: string }>;

function json(body: unknown, status = 200): Reply {
  return { status, body, text: JSON.stringify(body) };
}

function refused(status: number, reason: string): Reply {
  return json({ error: { type: "security_exception", reason }, status }, status);
}

function valueOf(doc: Doc, field: string): string | number {
  if (field === "t") return doc.t;
  if (field === "_shard_doc") return doc.shardDoc;
  if (field === "_index") return doc.index;
  if (field === "_id") return doc.id;
  return 1;
}

function fieldOf(clause: Clause): string {
  return Object.keys(clause)[0] ?? "";
}

function compare(a: readonly unknown[], b: readonly unknown[], sort: readonly Clause[]): number {
  for (let index = 0; index < sort.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === right) continue;
    const below = typeof left === "number" && typeof right === "number" ? left < right : String(left) < String(right);
    const desc = Object.values(sort[index] ?? {})[0]?.order === "desc";
    return (below ? -1 : 1) * (desc ? -1 : 1);
  }
  return 0;
}

/** The hits `sort` orders `docs` into; ties keep `docs`' own order, which differs per read. */
function ordered(docs: readonly Doc[], sort: readonly Clause[]) {
  return docs
    .map((doc) => ({ doc, sort: sort.map((clause) => valueOf(doc, fieldOf(clause))) }))
    .sort((a, b) => compare(a.sort, b.sort, sort));
}

function hitOf(entry: { doc: Doc; sort: readonly unknown[] }, sorted: boolean) {
  return {
    _id: entry.doc.id,
    _index: entry.doc.index,
    _source: { t: entry.doc.t },
    ...(sorted ? { sort: entry.sort } : {}),
  };
}

interface ClusterOptions {
  /** Status the server answers a release with. */
  readonly releaseStatus?: number;
  /** Status the server answers opening a point in time with. */
  readonly pitStatus?: number;
}

/**
 * A cluster of `DOCS` documents with many ties on `t`. Page one reads ties in the reverse of shard
 * order, the way merged shard replies may; a point in time or scroll reads them in shard order.
 */
class Cluster implements ElasticTransport {
  readonly address = "cluster.example:9200";
  readonly sent: Sent[] = [];
  readonly released: CursorIds[] = [];
  docs: Doc[];
  releaseCursors?: (cursors: CursorIds) => Promise<void>;
  #snapshot: Doc[] = [];
  #scrolled: ReturnType<typeof ordered> = [];
  #scrollSize = 0;
  #generation = 0;

  constructor(
    readonly dialect: Dialect,
    readonly options: ClusterOptions = {},
  ) {
    this.docs = Array.from({ length: DOCS }, (_, index) => ({
      id: `d${String(index).padStart(2, "0")}`,
      index: TARGET,
      t: index % 4,
      shardDoc: index,
    }));
  }

  add(id: string, t: number): void {
    this.docs.push({ id, index: TARGET, t, shardDoc: this.docs.length });
  }

  releasing(status: number | null): void {
    this.releaseCursors = (cursors) => {
      this.released.push(cursors);
      return status === null ? Promise.resolve() : Promise.reject(acceptedReplyError(status));
    };
  }

  request(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<Reply> {
    const body = (options.body ?? {}) as Record<string, unknown>;
    this.sent.push({ method, path, body });
    return Promise.resolve().then(() => acceptedReply(this.#answer(method, path, body), options));
  }

  close(): void {}

  get pages(): Sent[] {
    return this.sent.filter(
      (sent) => sent.method === "POST" && sent.path.includes("_search") && !sent.path.includes("point_in_time"),
    );
  }

  #answer(method: HttpMethod, path: string, body: Record<string, unknown>): Reply {
    if (path.startsWith("/_cat/indices/")) return json([{ index: TARGET }]);
    if (path.endsWith("/_mapping")) return json({ [TARGET]: { mappings: { properties: { t: { type: "long" } } } } });
    if (method === "DELETE") {
      return this.options.releaseStatus === undefined
        ? json({ succeeded: true })
        : refused(this.options.releaseStatus, "action [indices:data/read/close_point_in_time] is unauthorized");
    }
    if (path === `/${TARGET}/_pit?keep_alive=5m` || path === `/${TARGET}/_search/point_in_time?keep_alive=5m`) {
      if (this.options.pitStatus !== undefined) return refused(this.options.pitStatus, "no point in time here");
      this.#snapshot = [...this.docs];
      this.#generation += 1;
      return json(path.includes("_pit") ? { id: this.#pitId() } : { pit_id: this.#pitId() });
    }
    if (path === "/_search") return this.#pitPage(body);
    if (path === `/${TARGET}/_search?scroll=5m`) {
      if ("track_total_hits" in body)
        return refused(400, "disabling [track_total_hits] is not allowed in a scroll context");
      const sort = (body.sort ?? []) as Clause[];
      this.#scrolled = ordered(this.docs, sort);
      this.#scrollSize = Number(body.size);
      this.#generation = 1;
      return this.#scrollPage(sort.length > 0);
    }
    if (path === "/_search/scroll") return this.#scrollPage(true);
    if (path === `/${TARGET}/_search`) return this.#firstPage(body);
    return refused(404, `no answer for ${method} ${path}`);
  }

  #pitId(): string {
    return `pit-${String(this.#generation)}`;
  }

  #firstPage(body: Record<string, unknown>): Reply {
    if (!this.dialect.trackTotalHitsUpTo && "track_total_hits" in body) return refused(400, "track_total_hits number");
    const sort = (body.sort ?? []) as Clause[];
    const all = ordered([...this.docs].reverse(), sort);
    return json({
      took: 1,
      _shards: { total: 3, successful: 3, skipped: 0, failed: 0 },
      hits: {
        total: { value: all.length, relation: "eq" },
        hits: all.slice(0, Number(body.size)).map((entry) => hitOf(entry, sort.length > 0)),
      },
    });
  }

  #pitPage(body: Record<string, unknown>): Reply {
    const pit = body.pit as { id: string };
    if (pit.id !== this.#pitId()) return refused(404, `unknown point in time ${pit.id}`);
    const sort = body.sort as Clause[];
    const after = body.search_after as unknown[] | undefined;
    const entries = ordered(this.#snapshot, sort).filter(
      (entry) => after === undefined || compare(entry.sort, after, sort) > 0,
    );
    this.#generation += 1;
    return json({
      pit_id: this.#pitId(),
      hits: { hits: entries.slice(0, Number(body.size)).map((entry) => hitOf(entry, true)) },
    });
  }

  #scrollPage(sorted: boolean): Reply {
    const page = this.#scrolled.splice(0, this.#scrollSize);
    this.#generation += 1;
    return json({
      _scroll_id: `scroll-${String(this.#generation)}`,
      hits: { hits: page.map((entry) => hitOf(entry, sorted)) },
    });
  }
}

function acceptedReplyError(status: number): Error {
  try {
    acceptedReply(refused(status, "action [indices:data/read/scroll/clear] is unauthorized"), {});
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  return new Error("expected a refusal");
}

function cellText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function searchRequest(overrides: Partial<SearchRequest> = {}): SearchRequest {
  return {
    target: TARGET,
    language: "lucene",
    query: "",
    sort: [{ field: "t", order: "desc" }],
    time: null,
    fields: ["t"],
    pageSize: PAGE,
    ...overrides,
  };
}

async function read(rows: AsyncIterable<Row>, limit = Number.POSITIVE_INFINITY): Promise<Row[]> {
  const iterator = rows[Symbol.asyncIterator]();
  const all: Row[] = [];
  try {
    while (all.length < limit) {
      const next = await iterator.next();
      if (next.done === true) break;
      all.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return all;
}

const ELASTIC_8 = dialectOf("elasticsearch", "8.19.7");
const OPENSEARCH_2 = dialectOf("opensearch", "2.19.0");
const ELASTIC_6 = dialectOf("elasticsearch", "6.8.23");

describe("elasticsearch paging", () => {
  it("givenReaderStaysOnPageOne_whenThePageAndTheLookaheadAreRead_thenNothingOpensOnTheServer", async () => {
    const cluster = new Cluster(ELASTIC_8);
    const indices = new ElasticIndices(cluster, ELASTIC_8, "");
    const outcome = await indices.search(searchRequest());
    expect(await read(outcome.result.rows, PAGE + 1)).toHaveLength(PAGE + 1);
    expect(cluster.pages.map((sent) => sent.path)).toEqual([`/${TARGET}/_search`]);
    expect(cluster.pages[0]?.body).toMatchObject({ size: PAGE + 1, track_total_hits: TRACK_TOTAL_HITS_UP_TO });
    expect(outcome.request).toContain(`"track_total_hits": ${String(TRACK_TOTAL_HITS_UP_TO)}`);
    expect(indices.openCursors).toBe(0);
    await indices.close();
    expect(cluster.sent.some((sent) => sent.method === "DELETE")).toBe(false);
  });

  for (const dialect of [ELASTIC_8, OPENSEARCH_2]) {
    it(`givenPointInTimeOn${dialect.distribution}_whenPagedToTheEnd_thenEveryHitOnceInOrder`, async () => {
      const cluster = new Cluster(dialect);
      const indices = new ElasticIndices(cluster, dialect, "");
      const outcome = await indices.search(searchRequest());
      const ids = outcome.result.columns.findIndex((column) => column.name === "_id");
      const times = outcome.result.columns.findIndex((column) => column.name === "t");
      const before = cluster.docs.map((doc) => doc.id);
      cluster.add(LATE_FIRST, 9);
      cluster.add(LATE_LAST, -1);
      const rows = await read(outcome.result.rows);
      const seen = rows.map((row) => cellText(row[ids]));
      expect(new Set(seen).size).toBe(seen.length);
      expect([...before].sort()).toEqual(seen.filter((id) => !id.startsWith("late")).sort());
      expect(seen).not.toContain(LATE_FIRST);
      expect(seen.at(-1)).toBe(LATE_LAST);
      const order = rows.map((row) => Number(row[times]));
      expect(order).toEqual([...order].sort((a, b) => b - a));
      const pit = dialect.pointInTime;
      const secondPage = cluster.pages[1]?.body;
      expect(secondPage?.search_after).toEqual([
        order[PAGE],
        ...(pit?.tiebreakers.map((tiebreaker) => tiebreaker.first) ?? []),
      ]);
      expect(secondPage).toMatchObject({ track_total_hits: false });
      const releases = cluster.sent.filter((sent) => sent.method === "DELETE");
      expect(releases).toHaveLength(1);
      expect(releases[0]?.path).toBe(pit?.close);
      const released = releases[0]?.body ?? {};
      expect(Object.keys(released)).toEqual([dialect.distribution === "opensearch" ? "pit_id" : "id"]);
      expect(JSON.stringify(released)).toMatch(/"pit-\d+"/);
      expect(indices.openCursors).toBe(0);
    });
  }

  it("givenScoredSearch_whenPaged_thenTheScoreIsTheSortSearchAfterGoesOnFrom", async () => {
    const cluster = new Cluster(ELASTIC_8);
    const outcome = await new ElasticIndices(cluster, ELASTIC_8, "").search(searchRequest({ query: "t:1", sort: [] }));
    await read(outcome.result.rows, PAGE + 2);
    expect(cluster.pages[0]?.body.sort).toEqual([{ _score: { order: "desc" } }]);
    expect(cluster.pages[1]?.body.sort).toEqual([{ _score: { order: "desc" } }, { _shard_doc: { order: "asc" } }]);
  });

  it("givenUnsortedSearch_whenPaged_thenThePointInTimeReadsFromTheStartWithoutRepeats", async () => {
    const cluster = new Cluster(ELASTIC_8);
    const outcome = await new ElasticIndices(cluster, ELASTIC_8, "").search(searchRequest({ sort: [] }));
    const ids = outcome.result.columns.findIndex((column) => column.name === "_id");
    const seen = (await read(outcome.result.rows)).map((row) => cellText(row[ids]));
    expect(seen).toHaveLength(DOCS);
    expect(new Set(seen).size).toBe(DOCS);
    expect(cluster.pages[1]?.body).not.toHaveProperty("search_after");
  });

  it("givenServerWithoutPointInTime_whenPaged_thenScrollWithoutTrackTotalHitsAndNoRepeats", async () => {
    const cluster = new Cluster(ELASTIC_6);
    const indices = new ElasticIndices(cluster, ELASTIC_6, "");
    const outcome = await indices.search(searchRequest());
    expect(cluster.pages[0]?.body).not.toHaveProperty("track_total_hits");
    const ids = outcome.result.columns.findIndex((column) => column.name === "_id");
    const before = cluster.docs.map((doc) => doc.id);
    cluster.add(LATE_FIRST, 9);
    const seen = (await read(outcome.result.rows)).map((row) => cellText(row[ids]));
    expect(seen.sort()).toEqual(before.sort());
    expect(cluster.pages[1]?.path).toBe(`/${TARGET}/_search?scroll=5m`);
    expect(cluster.pages[1]?.body).not.toHaveProperty("track_total_hits");
    expect(cluster.sent.filter((sent) => sent.method === "DELETE").map((sent) => sent.path)).toEqual([
      "/_search/scroll",
    ]);
    expect(indices.openCursors).toBe(0);
  });

  it("givenPointInTimeRefused_whenPaged_thenTheRestComesByScroll", async () => {
    const cluster = new Cluster(ELASTIC_8, { pitStatus: 405 });
    const outcome = await new ElasticIndices(cluster, ELASTIC_8, "").search(searchRequest());
    expect(await read(outcome.result.rows)).toHaveLength(DOCS);
    expect(cluster.pages.map((sent) => sent.path)).toContain(`/${TARGET}/_search?scroll=5m`);
  });

  it("givenTransportThatReleasesCursors_whenTheResultIsLetGo_thenThePointInTimeFreedThroughIt", async () => {
    const cluster = new Cluster(ELASTIC_8);
    cluster.releasing(null);
    const indices = new ElasticIndices(cluster, ELASTIC_8, "");
    const outcome = await indices.search(searchRequest());
    await read(outcome.result.rows, PAGE + 3);
    expect(cluster.released).toEqual([{ pitIds: [expect.stringMatching(/^pit-/)] }]);
    expect(cluster.sent.some((sent) => sent.method === "DELETE")).toBe(false);
    expect(indices.openCursors).toBe(0);
  });

  it("givenRefusedRelease_whenResultsAreLetGo_thenOneWarningOnTheNextSearchOnly", async () => {
    const cluster = new Cluster(ELASTIC_8, { releaseStatus: 403 });
    const indices = new ElasticIndices(cluster, ELASTIC_8, "");
    const first = await indices.search(searchRequest());
    await read(first.result.rows, PAGE + 3);
    const second = await indices.search(searchRequest());
    expect(second.warnings.join(" ")).toMatch(/refused to free a search cursor.*5m keep-alive/);
    await read(second.result.rows, PAGE + 3);
    const third = await indices.search(searchRequest());
    expect(third.warnings).toEqual([]);
    expect(indices.openCursors).toBe(0);
  });

  it("givenRefusedReleaseThroughTheTransport_whenSessionCloses_thenNoError", async () => {
    const cluster = new Cluster(ELASTIC_8);
    cluster.releasing(403);
    const indices = new ElasticIndices(cluster, ELASTIC_8, "");
    const outcome = await indices.search(searchRequest());
    const iterator = outcome.result.rows[Symbol.asyncIterator]();
    for (let index = 0; index < PAGE + 3; index += 1) await iterator.next();
    expect(indices.openCursors).toBe(1);
    await indices.close();
    expect(cluster.released).toHaveLength(1);
    expect(indices.openCursors).toBe(0);
  });
});

describe("elasticsearch paging dialects", () => {
  it.each([
    ["elasticsearch", "6.8.23", null],
    ["elasticsearch", "7.9.3", null],
    ["elasticsearch", "7.10.2", "_index,_id"],
    ["elasticsearch", "7.12.0", "_shard_doc"],
    ["elasticsearch", "8.19.7", "_shard_doc"],
    ["opensearch", "2.3.0", null],
    ["opensearch", "2.4.0", "_index,_id"],
  ] as const)("given%s%s_whenRead_thenTiebreakers%s", (distribution, version, tiebreakers) => {
    const pit = dialectOf(distribution, version).pointInTime;
    expect(pit === null ? null : pit.tiebreakers.map((tiebreaker) => tiebreaker.field).join(",")).toBe(tiebreakers);
  });

  it("givenSortValues_whenCompared_thenServerOrderWithMissingLast", () => {
    const sort = [{ t: { order: "desc" } }, { name: { order: "asc" } }];
    expect(compareSortValues([2, "a"], [1, "a"], sort)).toBeLessThan(0);
    expect(compareSortValues([1, "a"], [1, "b"], sort)).toBeLessThan(0);
    expect(compareSortValues([null, "a"], [1, "a"], sort)).toBeGreaterThan(0);
    expect(compareSortValues([1, "\u{1F600}"], [1, "\uFFFD"], sort)).toBeGreaterThan(0);
    expect(compareSortValues([1, "a"], [1, "a"], sort)).toBe(0);
  });

  it("givenMissingNumericSortValue_whenSentBack_thenTheExactLongLimit", () => {
    expect(afterValue(2 ** 63)).toBe("9223372036854775807");
    expect(afterValue(-(2 ** 63))).toBe("-9223372036854775808");
    expect(afterValue(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(afterValue("a")).toBe("a");
  });
});
