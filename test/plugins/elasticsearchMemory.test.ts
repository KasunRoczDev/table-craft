import { describe, expect, it } from "vitest";
import type { Row } from "@table-craft/plugin-api";
import {
  ReplyTooLargeError,
  type ElasticTransport,
  type HttpMethod,
  type Reply,
} from "@table-craft/plugin-elasticsearch/client";
import { jsonReply } from "@table-craft/plugin-elasticsearch/console";
import { dialectOf } from "@table-craft/plugin-elasticsearch/dialect";
import { cellOf, hitColumns, hitRow } from "@table-craft/plugin-elasticsearch/hits";
import {
  CELL_PREVIEW_CHARS,
  PREVIEW_END,
  REPLY_PREVIEW_CHARS,
  jsonCell,
  previewText,
  rowBytes,
} from "@table-craft/plugin-elasticsearch/limits";
import { ElasticIndices } from "@table-craft/plugin-elasticsearch/search";

const MIB = 1024 * 1024;
const FAMILY = Array.from({ length: 10 }, (_, index) => `logs-${String(index + 1).padStart(6, "0")}`);
const MAPPING = { mappings: { properties: { "@timestamp": { type: "date" }, message: { type: "text" } } } };
const TOTAL = 25;
const READABLE_PAGE = 10;
const MESSAGE = "m".repeat(1000);

interface Sent {
  readonly method: HttpMethod;
  readonly path: string;
  readonly body: unknown;
}

function hit(index: number) {
  return {
    _id: `d${String(index)}`,
    _index: FAMILY[0],
    _source: { "@timestamp": new Date(index * 1000).toISOString(), message: MESSAGE },
    sort: [index],
  };
}

/** A cluster of one rollover family that refuses to send a page larger than `READABLE_PAGE`. */
function fakeCluster(): { client: ElasticTransport; sent: Sent[] } {
  const sent: Sent[] = [];
  let served = 0;
  const page = (size: number) => {
    const hits = Array.from({ length: Math.min(size, TOTAL - served) }, (_, offset) => hit(served + offset));
    served += hits.length;
    return { pit_id: "pit-1", took: 1, _shards: { total: 1, successful: 1 }, hits: { total: TOTAL, hits } };
  };
  const answer = (method: HttpMethod, path: string, options: { body?: unknown }): Promise<unknown> => {
    if (method === "DELETE") return Promise.resolve({});
    if (path.startsWith("/_cat/indices/")) return Promise.resolve(FAMILY.map((index) => ({ index })));
    if (path.endsWith("/_mapping")) {
      const names = path.slice(1, -"/_mapping".length).split(",");
      return Promise.resolve(Object.fromEntries(names.map((name) => [name, MAPPING])));
    }
    if (path.endsWith("/_settings")) return Promise.resolve({});
    if (path === "/logs/_pit?keep_alive=5m") return Promise.resolve({ id: "pit-1" });
    if (path.endsWith("/_search")) {
      const size = (options.body as { size: number }).size;
      if (size > READABLE_PAGE) return Promise.reject(new ReplyTooLargeError(64 * MIB));
      if (path !== "/_search") served = 0;
      return Promise.resolve(page(size));
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  };
  const request = async (method: HttpMethod, path: string, options: { body?: unknown } = {}): Promise<Reply> => {
    sent.push({ method, path, body: options.body });
    const body = await answer(method, path, options);
    return { status: 200, body, text: JSON.stringify(body) };
  };
  return { client: { address: "127.0.0.1:9200", request, close: () => undefined }, sent };
}

const REQUEST = {
  target: "logs",
  language: "lucene" as const,
  query: "",
  sort: [],
  time: null,
  fields: null,
  pageSize: 100,
};

async function rowsOf(rows: AsyncIterable<Row>): Promise<Row[]> {
  const all: Row[] = [];
  for await (const row of rows) all.push(row);
  return all;
}

describe("elasticsearch memory guards", () => {
  const dialect = dialectOf("elasticsearch", "8.19.7");

  it("givenFirstPageTooLargeToRead_whenSearched_thenThePageShrinksUntilItFits", async () => {
    const { client } = fakeCluster();
    const outcome = await new ElasticIndices(client, dialect, "").search(REQUEST);
    expect(outcome.request).toContain(`"size": ${String(READABLE_PAGE)}`);
    expect(await rowsOf(outcome.result.rows)).toHaveLength(TOTAL);
  });

  it("givenRowsPastTheMemoryBudget_whenPaged_thenPagingStopsAndNoCursorIsLeft", async () => {
    const { client, sent } = fakeCluster();
    const indices = new ElasticIndices(client, dialect, "", undefined, 10_000);
    const outcome = await indices.search(REQUEST);
    const rows = await rowsOf(outcome.result.rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(READABLE_PAGE);
    expect(sent.some((request) => request.path.includes("_pit"))).toBe(false);
    expect(indices.openCursors).toBe(0);
  });

  it("givenLargeFamily_whenDescribed_thenOnlyTheLastIndicesMappingsAreRead", async () => {
    const { client, sent } = fakeCluster();
    const description = await new ElasticIndices(client, dialect, "").describe("logs");
    const mappings = sent.filter((request) => request.path.endsWith("/_mapping")).map((request) => request.path);
    expect(mappings).toEqual([`/${FAMILY.slice(-4).join(",")}/_mapping`]);
    expect(description.indices).toEqual(FAMILY);
    expect(description.kind).toBe("alias");
    expect(description.timeField).toBe("@timestamp");
    expect(description.warnings.join(" ")).toContain("last 4 of 10");
  });

  it("givenLongText_whenMadeACell_thenOnlyItsStartIsKept", () => {
    const long = "a".repeat(CELL_PREVIEW_CHARS + 10);
    expect(cellOf(long)).toBe("a".repeat(CELL_PREVIEW_CHARS) + PREVIEW_END);
    expect(previewText("short")).toBe("short");
    expect(jsonCell('{"a":1}')).toEqual({ kind: "json", text: '{"a":1}' });
    expect(typeof cellOf({ text: long })).toBe("string");
  });

  it("givenHugeSource_whenMadeARow_thenTheSourceCellIsAPreview", () => {
    const shape = hitColumns(
      ["message"],
      [{ path: "message", type: "text", multiOf: null, analyzer: null, aggregatable: false }],
      false,
      false,
    );
    const row = hitRow({ _id: "1", _source: { message: "b".repeat(CELL_PREVIEW_CHARS * 2) } }, shape);
    const source = row[row.length - 1];
    expect(typeof source === "string" && source.endsWith(PREVIEW_END)).toBe(true);
    expect(rowBytes(row)).toBeLessThan(CELL_PREVIEW_CHARS * 2 * 2 + 1024);
  });

  it("givenHugeConsoleReply_whenShown_thenOutputGetsItsStartAndHowToNarrow", () => {
    const body = { mappings: "c".repeat(REPLY_PREVIEW_CHARS * 2) };
    const result = jsonReply(body, true);
    expect(result.reply?.text.length).toBeLessThan(REPLY_PREVIEW_CHARS + 200);
    expect(result.reply?.text).toContain("filter_path");
    expect(jsonReply({ ok: true }, true).reply?.value).toEqual({ kind: "json", text: '{"ok":true}' });
  });
});
