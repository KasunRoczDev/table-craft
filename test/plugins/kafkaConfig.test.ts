import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginManifestSchema, serviceProblems } from "@table-craft/plugin-api";
import plugin from "@table-craft/plugin-kafka";
import { connectionSchema, parseBootstrap } from "@table-craft/plugin-kafka/config";
import { nameFilter } from "@table-craft/plugin-kafka/glob";
import { clusterModeOf, missingApis, serverVersionOf, type BrokerApi } from "@table-craft/plugin-kafka/version";

const MANIFEST = resolve(import.meta.dirname, "../../plugins/kafka/table-craft-plugin.json");

function apis(versions: Readonly<Record<string, number>>): BrokerApi[] {
  return Object.entries(versions).map(([name, maxVersion], apiKey) => ({ apiKey, name, minVersion: 0, maxVersion }));
}

const BASE = { Metadata: 12, ApiVersions: 3, ListOffsets: 8, Produce: 9 };

describe("kafka config", () => {
  it("givenBootstrapWithoutPort_whenParsed_thenRefusedNamingEntry", () => {
    expect(() => parseBootstrap("broker-1:9092, broker-2")).toThrow(/"broker-2" has no port/);
    const parsed = connectionSchema.safeParse({ bootstrapServers: "kafka.internal" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('"kafka.internal" has no port');
  });

  it("givenBootstrapList_whenParsed_thenHostsAndPorts", () => {
    expect(parseBootstrap("a:9092,[::1]:9093\nb:1")).toEqual([
      { host: "a", port: 9092 },
      { host: "::1", port: 9093 },
      { host: "b", port: 1 },
    ]);
    expect(() => parseBootstrap("a:70000")).toThrow(/outside/);
  });

  it("givenSaslWithoutUser_whenParsed_thenUserRequired", () => {
    const parsed = connectionSchema.safeParse({ security: "SASL_SSL" });
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("user");
  });

  it("givenManifest_whenParsed_thenValidAndMatchesPlugin", () => {
    const manifest = pluginManifestSchema.parse(JSON.parse(readFileSync(MANIFEST, "utf8")));
    expect([...manifest.capabilities].sort()).toEqual([...plugin.capabilities].sort());
    expect(serviceProblems(plugin.capabilities, plugin)).toEqual([]);
    expect(manifest.connection.network).toBeUndefined();
    expect(manifest.connection.url).toBeUndefined();
  });
});

describe("kafka version estimate", () => {
  it("givenApiVersionsOfReleases_whenEstimated_thenHighestMatchedRelease", () => {
    expect(serverVersionOf(apis({ ...BASE, Fetch: 12, DescribeCluster: 0, LeaderAndIsr: 5 }))).toBe("≥ 2.8");
    expect(serverVersionOf(apis({ ...BASE, Fetch: 16, DescribeCluster: 1, ConsumerGroupHeartbeat: 0 }))).toBe("≥ 3.7");
    expect(serverVersionOf(apis({ ...BASE, Fetch: 18, DescribeCluster: 2, ConsumerGroupHeartbeat: 1 }))).toBe("≥ 4.1");
    expect(serverVersionOf(apis({ ...BASE, Fetch: 11, DescribeCluster: 0 }))).toBe("≥ 2.3");
    expect(serverVersionOf(apis({ ...BASE, Fetch: 6 }))).toBe("version unknown");
  });

  it("givenOldBroker_whenRequiredApiMissing_thenNamed", () => {
    expect(missingApis(apis({ Metadata: 1, ApiVersions: 1, Fetch: 4 }))).toEqual(["ListOffsets", "Produce"]);
    expect(missingApis(apis({ ...BASE, Fetch: 12 }))).toEqual([]);
  });

  it("givenLeaderAndIsr_whenModeRead_thenZooKeeper", () => {
    expect(clusterModeOf(apis({ ...BASE, LeaderAndIsr: 5 }), "abc")).toBe("ZooKeeper");
    expect(clusterModeOf(apis(BASE), "abc")).toBe("KRaft");
    expect(clusterModeOf(apis(BASE), "redpanda.1234")).toBe("Redpanda");
  });
});

describe("kafka name filter", () => {
  it("givenGlobList_whenNameFilter_thenAnyGlobMatches", () => {
    const listed = nameFilter("orders.*, payments.v?");
    expect(["orders.v1", "payments.v2", "payments.v10", "audit"].filter(listed)).toEqual(["orders.v1", "payments.v2"]);
  });

  it("givenEmptyFilter_whenNameFilter_thenEveryNameListed", () => {
    expect(nameFilter(" ")("anything")).toBe(true);
    expect(connectionSchema.parse({}).nameFilter).toBe("");
  });
});
