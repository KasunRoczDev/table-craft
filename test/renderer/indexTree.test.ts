import { describe, expect, it } from "vitest";
import type { SearchTarget } from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceView } from "@table-craft/desktop/preload/bridge.js";
import { explorerRows, keyTreeKey, type ExplorerRow } from "@table-craft/desktop/renderer/model/explorerTree.js";
import {
  EMPTY_INDICES,
  familyBaseOf,
  familyDetail,
  groupedCount,
  healthTone,
  humanBytes,
  indexFilterCount,
  indexFilterMatcher,
  indexGroups,
  indexStatusText,
  INDEX_FILTER_THRESHOLD,
  showsIndexFilter,
  middleTruncate,
  searchTargetDetail,
  searchTargetFacts,
  type DatasourceIndices,
} from "@table-craft/desktop/renderer/model/indexTree.js";
import { shownIndexFilter } from "@table-craft/desktop/renderer/model/shownIndices.js";

function index(name: string, docs = "10", bytes = "2048", health: string | null = "green"): SearchTarget {
  return {
    name,
    kind: "index",
    hidden: name.startsWith("."),
    health,
    status: "open",
    docs,
    bytes,
    indices: [name],
    writeIndex: null,
  };
}

function alias(name: string, indices: readonly string[], writeIndex: string | null = null): SearchTarget {
  return { ...index(name), kind: "alias", docs: null, bytes: null, health: null, indices, writeIndex };
}

function dataStream(name: string, backing: number): SearchTarget {
  const indices = Array.from({ length: backing }, (_, at) => `.ds-${name}-2026.11.2${String(at)}-00000${String(at)}`);
  return { ...index(name), kind: "dataStream", docs: null, bytes: null, indices };
}

const DATASOURCE = {
  id: "search",
  name: "search-local",
  pluginId: "elasticsearch",
  folder: null,
  color: null,
  readOnly: false,
  comment: "",
  config: {},
  secretModes: {},
} as unknown as DatasourceView;

const LOGS = ["000410", "000411", "000412"].map((suffix) => index(`logs-checkout-${suffix}`));

const INDICES: DatasourceIndices = {
  ...EMPTY_INDICES,
  targets: [
    ...LOGS,
    index("products"),
    index("orders", "2431", "1258291", "yellow"),
    index("audit.http"),
    index("audit.login"),
    index(".kibana_1"),
    alias("logs-checkout", ["logs-checkout-000411", "logs-checkout-000412"], "logs-checkout-000412"),
    alias("catalog", ["products"]),
    dataStream("metrics-app", 3),
  ],
};

function rows(
  indices: DatasourceIndices,
  expanded: readonly string[],
  datasource: DatasourceView = DATASOURCE,
): readonly ExplorerRow[] {
  return explorerRows({
    tree: [{ kind: "datasource", datasource }],
    catalogs: {},
    expanded: new Set(["datasource:search", ...expanded]),
    collapsedFolders: new Set(),
    showSystem: false,
    canExpand: () => true,
    indices: { search: indices },
    browsesIndices: () => true,
  });
}

const key = (...parts: readonly string[]) => keyTreeKey("search", ...parts);
const OPEN_SECTIONS = ["indices", "dataStreams", "aliases"].map((section) => key("indexSection", section));

function outline(shown: readonly ExplorerRow[]): readonly string[] {
  return shown.slice(1).map((row) => `${"  ".repeat(row.depth - 1)}${row.node.kind}:${row.label}`);
}

describe("index tree", () => {
  it("givenRolloverAndDateSuffixes_whenBased_thenFamilyBase", () => {
    expect(familyBaseOf("logs-checkout-000412")).toBe("logs-checkout");
    expect(familyBaseOf("logs-2026.11.21")).toBe("logs");
    expect(familyBaseOf("logs-2026.11")).toBe("logs");
    expect(familyBaseOf("logs-2026-11-21")).toBe("logs");
    expect(familyBaseOf("logs-2026.11.21-000001")).toBe("logs");
    expect(familyBaseOf("logs-2026-11")).toBe("logs");
    expect(familyBaseOf("orders")).toBeNull();
    expect(familyBaseOf("orders-v2")).toBeNull();
  });

  it("givenIndices_whenGrouped_thenFamiliesNewestFirstFoldersAndLoose", () => {
    const plain = (INDICES.targets ?? []).filter((target) => target.kind === "index" && !target.hidden);
    const aliases = (INDICES.targets ?? []).filter((target) => target.kind === "alias");
    const { families, folders, loose } = indexGroups(plain, aliases);
    expect(families).toHaveLength(1);
    expect(families[0]?.base).toBe("logs-checkout");
    expect(families[0]?.writeAlias).toBe("logs-checkout");
    expect(families[0]?.members.map((member) => member.name)).toEqual([
      "logs-checkout-000412",
      "logs-checkout-000411",
      "logs-checkout-000410",
    ]);
    expect(folders.map((folder) => folder.prefix)).toEqual(["audit."]);
    expect(loose.map((each) => each.name)).toEqual(["orders", "products"]);
  });

  it("givenLoneSuffixedIndex_whenGrouped_thenNoFamily", () => {
    const { families, loose } = indexGroups([index("logs-checkout-000412"), index("orders")]);
    expect(families).toEqual([]);
    expect(loose.map((each) => each.name)).toEqual(["logs-checkout-000412", "orders"]);
  });

  it("givenOpenSections_whenRows_thenFamilyShowsNewestTwoAndOlderFolds", () => {
    const shown = rows(INDICES, [...OPEN_SECTIONS, key("indexFamily", "logs-checkout")]);
    expect(outline(shown)).toEqual([
      "indexSection:Indices",
      "  indexFolder:audit.",
      "  indexFamily:logs-checkout",
      "    searchTarget:logs-checkout-000412",
      "    searchTarget:logs-checkout-000411",
      "    indexOlder:1 older",
      "  searchTarget:orders",
      "  searchTarget:products",
      "indexSection:Data streams",
      "  searchTarget:metrics-app",
      "indexSection:Aliases",
      "  searchTarget:catalog",
      "  searchTarget:logs-checkout",
      "indexSection:Hidden",
    ]);
    expect(shown.find((row) => row.node.kind === "indexSection")?.node).toMatchObject({ count: 7 });
  });

  it("givenHiddenSectionOpened_whenRows_thenSystemIndicesOnlyThere", () => {
    const shown = rows(INDICES, [key("indexSection", "hidden")]);
    expect(outline(shown)).toEqual([
      "indexSection:Indices",
      "indexSection:Data streams",
      "indexSection:Aliases",
      "indexSection:Hidden",
      "  searchTarget:.kibana_1",
    ]);
  });

  it("givenUnlisted_whenRows_thenLoadingOrError", () => {
    expect(outline(rows({ ...EMPTY_INDICES, loading: true }, []))).toEqual(["loading:"]);
    const error = { code: "connectionFailed" as const, message: "Connection refused", hint: "" };
    expect(outline(rows({ ...EMPTY_INDICES, error }, []))).toEqual(["error:Connection refused"]);
  });

  it("givenTargets_whenDetailed_thenSizesAliasesAndBackingIndices", () => {
    expect(searchTargetDetail(index("orders", "2431", "1258291"))).toBe("2,431 docs · 1.2 MB");
    expect(searchTargetDetail(index("one", "1", "512"))).toBe("1 doc · 512 B");
    expect(searchTargetDetail(index("unknown", "", ""))).toBe("");
    expect(searchTargetDetail(alias("catalog", ["products"]))).toBe("→ products");
    expect(searchTargetDetail(alias("logs", ["a", "b"]))).toBe("→ 2 indices");
    expect(searchTargetDetail(dataStream("metrics-app", 3))).toBe("3 backing indices");
    expect(searchTargetDetail(dataStream("metrics-web", 1))).toBe("1 backing index");
    expect(familyDetail(LOGS)).toBe("3 indices · 30 docs · 6.0 KB");
    expect(searchTargetFacts(index("orders", "2431", "1258291"), ["orders"])).toBe("2,431 docs · 1.2 MB · 1 index");
    expect(searchTargetFacts(null, ["a", "b"])).toBe("2 indices");
  });

  it("givenSizes_whenHumanised_thenBinaryUnitsWithOneDecimal", () => {
    expect(humanBytes("0")).toBe("0 B");
    expect(humanBytes("1023")).toBe("1023 B");
    expect(humanBytes("1024")).toBe("1.0 KB");
    expect(humanBytes(String(5 * 1024 ** 3))).toBe("5.0 GB");
    expect(humanBytes(String(2 * 1024 ** 5))).toBe("2048.0 TB");
    expect(humanBytes(null)).toBeNull();
    expect(groupedCount("1234567")).toBe("1,234,567");
    expect(groupedCount(null)).toBeNull();
  });

  it("givenHealth_whenToned_thenOnlyYellowAndRedMarked", () => {
    expect(healthTone("green")).toBeNull();
    expect(healthTone(null)).toBeNull();
    expect(healthTone("yellow")).toBe("warning");
    expect(healthTone("red")).toBe("danger");
  });

  it("givenLongName_whenTruncated_thenStartAndEndKept", () => {
    const name = "logs-checkout-service-production-eu-west-1-2026.11.21-000412";
    const short = middleTruncate(name, 24);
    expect(short).toHaveLength(24);
    expect(short).toBe("logs-checkou…1.21-000412");
    expect(middleTruncate("orders", 24)).toBe("orders");
  });

  it("givenListing_whenStatus_thenVisibleIndexCount", () => {
    expect(indexStatusText(INDICES)).toBe("7 indices");
    expect(indexStatusText({ ...EMPTY_INDICES, targets: [index("orders")] })).toBe("1 index");
    expect(indexStatusText(EMPTY_INDICES)).toBeNull();
    expect(indexStatusText(undefined)).toBeNull();
  });

  it("givenMonthlySuffixWithAGeneration_whenBased_thenOneFamilyNewestFirst", () => {
    expect(familyBaseOf("logs-billing-2026-10-0001")).toBe("logs-billing");
    const monthly = ["2026-09-0001", "2026-10-0001", "2026-10-0002"].map((suffix) => index(`logs-billing-${suffix}`));
    const { families } = indexGroups(monthly);
    expect(families.map((family) => family.base)).toEqual(["logs-billing"]);
    expect(families[0]?.members.map((member) => member.name)).toEqual([
      "logs-billing-2026-10-0002",
      "logs-billing-2026-10-0001",
      "logs-billing-2026-09-0001",
    ]);
  });

  it("givenFilterText_whenMatched_thenCaseBlindSubstringWithWildcards", () => {
    const matches = indexFilterMatcher("Logs-*-2026");
    expect(matches("logs-checkout-2026.11.21")).toBe(true);
    expect(matches("logs-checkout-000412")).toBe(false);
    expect(indexFilterMatcher("audit.")("audit.http")).toBe(true);
    expect(indexFilterMatcher("audit.")("audit-http")).toBe(false);
    expect(indexFilterMatcher("  ")("anything")).toBe(true);
  });

  it("givenSmallListing_whenRows_thenNoFilterRow", () => {
    expect(showsIndexFilter(INDICES)).toBe(false);
    expect(rows(INDICES, OPEN_SECTIONS).some((row) => row.node.kind === "indexFilter")).toBe(false);
  });

  it("givenListingPastTheThreshold_whenRows_thenFilterRowLeadsWithItsCount", () => {
    const many = Array.from({ length: INDEX_FILTER_THRESHOLD + 1 }, (_, at) =>
      index(`app-${String(at).padStart(4, "0")}`),
    );
    const shown = rows({ ...EMPTY_INDICES, targets: many }, []);
    expect(outline(shown).slice(0, 2)).toEqual(["indexFilter:", "indexSection:Indices"]);
    expect(shown[1]?.node).toMatchObject({ matched: 201, total: 201 });
    expect(indexFilterCount({ matched: 12, total: 8760 })).toBe("12 of 8,760");
  });

  it("givenFilter_whenRows_thenMatchesKeptInTheirFamiliesAndFoldersAndOpened", () => {
    const shown = rows({ ...INDICES, filter: "o" }, []);
    expect(outline(shown)).toEqual([
      "indexFilter:",
      "indexSection:Indices",
      "  searchTarget:audit.login",
      "  indexFamily:logs-checkout",
      "    searchTarget:logs-checkout-000412",
      "    searchTarget:logs-checkout-000411",
      "    indexOlder:1 older",
      "      searchTarget:logs-checkout-000410",
      "  searchTarget:orders",
      "  searchTarget:products",
      "indexSection:Aliases",
      "  searchTarget:catalog",
      "  searchTarget:logs-checkout",
    ]);
    expect(shown[1]?.node).toMatchObject({ kind: "indexFilter", matched: 8, total: 11 });
    expect(shown.filter((row) => row.expandable).every((row) => row.expanded)).toBe(true);
  });

  it("givenFilterMatchingASystemIndex_whenRows_thenHiddenSectionOpensOnIt", () => {
    const shown = rows({ ...INDICES, filter: "kibana" }, []);
    expect(outline(shown)).toEqual([
      "indexFilter:",
      "indexSection:Indices",
      "indexSection:Hidden",
      "  searchTarget:.kibana_1",
    ]);
  });

  it("givenShownList_whenBuildingRows_thenOnlyListedTargetsInSections", () => {
    const datasource = { ...DATASOURCE, shownIndices: ["logs-checkout-*", "metrics-app"] };
    const shown = rows(INDICES, [...OPEN_SECTIONS, key("indexFamily", "logs-checkout")], datasource);
    expect(outline(shown)).toEqual([
      "indexSection:Indices",
      "  indexFamily:logs-checkout",
      "    searchTarget:logs-checkout-000412",
      "    searchTarget:logs-checkout-000411",
      "    indexOlder:1 older",
      "indexSection:Data streams",
      "  searchTarget:metrics-app",
      "indexSection:Aliases",
      "  searchTarget:logs-checkout",
    ]);
    expect(shown.find((row) => row.node.kind === "indexSection")?.node).toMatchObject({ count: 3 });
  });

  it("givenShownListUnderThreshold_whenBuildingRows_thenNoFilterRow", () => {
    const many = Array.from({ length: INDEX_FILTER_THRESHOLD + 1 }, (_, at) =>
      index(`app-${String(at).padStart(4, "0")}`),
    );
    const datasource = { ...DATASOURCE, shownIndices: ["app-0000", "app-0001"] };
    const shown = rows({ ...EMPTY_INDICES, targets: many }, OPEN_SECTIONS, datasource);
    expect(outline(shown)).toEqual(["indexSection:Indices", "  searchTarget:app-0000", "  searchTarget:app-0001"]);
    expect(showsIndexFilter({ ...EMPTY_INDICES, targets: many }, 2)).toBe(false);
  });

  it("givenShownListAndFilter_whenBuildingRows_thenFilterCountsOverListed", () => {
    const datasource = { ...DATASOURCE, shownIndices: ["logs-checkout-*", "orders", "products"] };
    const shown = rows({ ...INDICES, filter: "o" }, [], datasource);
    expect(shown[1]?.node).toMatchObject({ kind: "indexFilter", matched: 6, total: 6 });
    const narrow = rows({ ...INDICES, filter: "orders" }, [], datasource);
    expect(narrow[1]?.node).toMatchObject({ kind: "indexFilter", matched: 1, total: 6 });
  });

  it("givenShownList_whenStatusText_thenCountsListedIndices", () => {
    const datasource = { shownIndices: ["logs-checkout-*", "orders"] };
    expect(indexStatusText(INDICES, shownIndexFilter(datasource))).toBe("4 indices");
    expect(indexStatusText(INDICES, shownIndexFilter({}))).toBe("7 indices");
  });
});
