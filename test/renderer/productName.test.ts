import { describe, expect, it } from "vitest";
import { productName } from "@table-craft/desktop/renderer/model/format.js";

const SEARCH_PLUGIN = {
  name: "Elasticsearch",
  brands: [
    { id: "elasticsearch", name: "Elasticsearch" },
    { id: "opensearch", name: "OpenSearch" },
  ],
};

describe("productName", () => {
  it("givenReportedBrand_whenNamed_thenTheBrandNotThePlugin", () => {
    expect(productName(SEARCH_PLUGIN, "opensearch")).toBe("OpenSearch");
  });

  it("givenNoOrUnknownBrand_whenNamed_thenThePluginName", () => {
    expect(productName(SEARCH_PLUGIN, null)).toBe("Elasticsearch");
    expect(productName(SEARCH_PLUGIN, "solr")).toBe("Elasticsearch");
    expect(productName(undefined, "opensearch")).toBeNull();
  });
});
