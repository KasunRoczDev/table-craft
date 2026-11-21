import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPluginError } from "@table-craft/plugin-api";
import { ElasticClient, hasDotSegment, isForbidden, isReplyTooLarge } from "@table-craft/plugin-elasticsearch/client";

const AUTHORIZATION = "Basic dGVzdDp0ZXN0";
const LARGE = "x".repeat(4096);
const CHUNKS = 16;
const SMALL_LIMIT = 1024;
const seen: { path: string; authorization: string | undefined }[] = [];
let server: Server;
let client: ElasticClient;

function reply(path: string): { status: number; type: string; body: string } {
  if (path.startsWith("/denied")) {
    return {
      status: 403,
      type: "application/json",
      body: JSON.stringify({
        error: { type: "security_exception", reason: "action [indices:data/read/search] is unauthorized" },
      }),
    };
  }
  if (path.startsWith("/unauthorized")) {
    return {
      status: 401,
      type: "application/json",
      body: JSON.stringify({ error: { type: "security_exception", reason: "missing authentication credentials" } }),
    };
  }
  if (path.startsWith("/html")) return { status: 200, type: "text/html", body: "<html>proxy</html>" };
  if (path.startsWith("/large"))
    return { status: 200, type: "application/json", body: JSON.stringify({ text: LARGE }) };
  return { status: 200, type: "application/json", body: JSON.stringify({ path }) };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "";
    seen.push({ path, authorization: request.headers.authorization });
    if (path.startsWith("/chunked")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      for (let chunk = 0; chunk < CHUNKS; chunk += 1) response.write(LARGE);
      response.end();
      return;
    }
    const { status, type, body } = reply(path);
    response.writeHead(status, { "Content-Type": type, "Content-Length": String(Buffer.byteLength(body)) });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  client = new ElasticClient({
    baseUrl: `http://127.0.0.1:${String(port)}`,
    authorization: AUTHORIZATION,
    tls: null,
    requestTimeoutMs: 5_000,
    connectTimeoutMs: 5_000,
  });
});

afterAll(async () => {
  client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function failure(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("elasticsearch client", () => {
  it("givenProtocolRelativePath_whenRequested_thenItStaysOnTheConfiguredHost", async () => {
    seen.length = 0;
    const body = await client.json<{ path: string }>("GET", "//evil.example/x?pretty");
    expect(body.path).toBe("/evil.example/x?pretty");
    expect(seen).toEqual([{ path: "/evil.example/x?pretty", authorization: AUTHORIZATION }]);
  });

  it.each(["/logs/_search/../_delete_by_query", "/logs/_search/%2e%2e/_delete_by_query", "/./_cat"])(
    "givenDotSegment %s_whenRequested_thenRefusedBeforeSending",
    async (path) => {
      seen.length = 0;
      const error = await failure(client.request("POST", path));
      expect(isPluginError(error) && error.code === "statementFailed").toBe(true);
      expect(seen).toHaveLength(0);
    },
  );

  it("givenDotSegments_whenChecked_thenPlainAndEncodedFound", () => {
    expect(hasDotSegment("/a/../b")).toBe(true);
    expect(hasDotSegment("/a/%2E/b")).toBe(true);
    expect(hasDotSegment("/logs.2026/_search")).toBe(false);
  });

  it("givenForbidden_whenRequested_thenForbiddenWithTheServersReason", async () => {
    const error = await failure(client.request("GET", "/denied/_search"));
    expect(isForbidden(error)).toBe(true);
    expect(String((error as Error).message)).toContain("unauthorized");
  });

  it("givenUnauthorized_whenRequested_thenStatementFailedNotForbidden", async () => {
    const error = await failure(client.request("GET", "/unauthorized"));
    expect(isPluginError(error)).toBe(true);
    expect(isForbidden(error)).toBe(false);
  });

  it("givenHtmlReply_whenJsonExpected_thenItSaysWhatCameBack", async () => {
    const error = await failure(client.json("GET", "/html"));
    expect(String((error as Error).message)).toContain("<html>proxy</html>");
  });

  it.each(["/large", "/chunked"])("givenReplyPastTheLimit %s_whenRequested_thenDroppedAsTooLarge", async (path) => {
    const error = await failure(client.request("GET", path, { maxBytes: SMALL_LIMIT }));
    expect(isReplyTooLarge(error)).toBe(true);
    expect(isPluginError(error) && error.code === "statementFailed").toBe(true);
    expect(String((error as Error).message)).toContain("filter_path");
  });

  it("givenReplyWithinTheLimit_whenRequestedAgain_thenTheConnectionStillServes", async () => {
    await failure(client.request("GET", "/chunked", { maxBytes: SMALL_LIMIT }));
    const body = await client.json<{ text: string }>("GET", "/large");
    expect(body.text).toBe(LARGE);
  });

  it("givenAbortedSignal_whenRequested_thenCancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(client.request("GET", "/", { signal: controller.signal }));
    expect(isPluginError(error) && error.code === "cancelled").toBe(true);
  });
});
