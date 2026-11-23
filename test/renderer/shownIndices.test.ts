import { describe, expect, it } from "vitest";
import type { SearchTarget } from "@table-craft/desktop/engine/protocol.js";
import {
  familyEntry,
  shownIndexCount,
  shownIndexEntries,
  shownIndexFilter,
} from "@table-craft/desktop/renderer/model/shownIndices.js";

function index(name: string, hidden = name.startsWith(".")): SearchTarget {
  return {
    name,
    kind: "index",
    hidden,
    health: "green",
    status: "open",
    docs: "10",
    bytes: "2048",
    indices: [name],
    writeIndex: null,
  };
}

function alias(name: string, indices: readonly string[], writeIndex: string | null = null): SearchTarget {
  return { ...index(name), kind: "alias", docs: null, bytes: null, health: null, indices, writeIndex };
}

function dataStream(name: string): SearchTarget {
  return { ...index(name), kind: "dataStream", docs: null, bytes: null, indices: [`.ds-${name}-2026.11.23-000001`] };
}

function keeps(shownIndices: readonly string[], target: SearchTarget): boolean {
  const filter = shownIndexFilter({ shownIndices });
  if (filter === null) throw new Error("expected a filter");
  return filter(target);
}

const TARGETS: readonly SearchTarget[] = [
  index("orders-000411"),
  index("orders-000412"),
  index("payments-2026.11.23"),
  index("products"),
  index(".security-7"),
  alias("orders", ["orders-000411", "orders-000412"], "orders-000412"),
  alias("orders-read", ["orders-000411", "orders-000412"]),
  alias("catalog", ["products"], "products"),
  dataStream("logs"),
];

describe("shown indices", () => {
  it("givenNoList_whenFiltering_thenNull", () => {
    expect(shownIndexFilter({})).toBeNull();
    expect(shownIndexFilter({ shownIndices: undefined })).toBeNull();
  });

  it("givenFamilyEntry_whenNewDailyIndexAppears_thenShown", () => {
    expect(familyEntry("orders")).toBe("orders-*");
    expect(keeps(["orders-*"], index("orders-2026.11.24"))).toBe(true);
  });

  it("givenFamilyEntry_whenRolloverIndex_thenShown", () => {
    expect(keeps(["orders-*"], index("orders-000413"))).toBe(true);
  });

  it("givenExactIndexName_whenSiblingDay_thenHidden", () => {
    expect(keeps(["orders-2026.11.23"], index("orders-2026.11.24"))).toBe(false);
    expect(keeps(["orders-2026.11.23"], index("orders-2026.11.23"))).toBe(true);
    expect(keeps(["payments-000001"], index("payments-000001"))).toBe(true);
  });

  it("givenFamilyEntry_whenWriteAliasOfMember_thenAliasShown", () => {
    const writer = alias("orders", ["orders-000412"], "orders-000412");
    expect(keeps(["orders-*"], writer)).toBe(true);
    expect(keeps(["orders"], writer)).toBe(true);
  });

  it("givenFamilyEntry_whenWriteIndexRollsOver_thenAliasStillShown", () => {
    expect(keeps(["orders-*"], alias("orders", ["orders-000413"], "orders-000413"))).toBe(true);
  });

  it("givenFamilyEntry_whenReadAliasWithoutWriteIndex_thenAliasHidden", () => {
    expect(keeps(["orders-*"], alias("orders-read", ["orders-000411", "orders-000412"]))).toBe(false);
  });

  it("givenAliasEntry_whenItsIndicesUnlisted_thenIndicesHidden", () => {
    expect(keeps(["orders"], index("orders-000412"))).toBe(false);
  });

  it("givenDataStreamEntry_whenFiltering_thenShown", () => {
    expect(keeps(["logs"], dataStream("logs"))).toBe(true);
  });

  it("givenList_whenHiddenTargetUnlisted_thenHidden", () => {
    expect(keeps(["orders-*"], index(".security-7"))).toBe(false);
    expect(keeps(["orders-*"], index("orders-000413", true))).toBe(false);
    expect(keeps([".security-7"], index(".security-7"))).toBe(true);
  });

  it("givenEmptyList_whenFiltering_thenNothingShown", () => {
    expect(TARGETS.some((target) => keeps([], target))).toBe(false);
  });

  it("givenGlobOtherThanFamily_whenFiltering_thenMatchesNothing", () => {
    expect(keeps(["ord*"], index("orders-000412"))).toBe(false);
    expect(keeps(["*"], index("products"))).toBe(false);
  });

  it("givenWriteAliasOfFamily_whenListingEntries_thenFoldedIntoFamilyRow", () => {
    const entries = shownIndexEntries(TARGETS);
    expect(entries.find((entry) => entry.name === "orders-*")).toEqual({
      name: "orders-*",
      kind: "family",
      members: 2,
      hidden: false,
      writeAliases: ["orders"],
    });
    expect(entries.some((entry) => entry.name === "orders")).toBe(false);
  });

  it("givenAliasWritingToLooseIndex_whenListingEntries_thenOwnRow", () => {
    const entries = shownIndexEntries(TARGETS);
    expect(entries.find((entry) => entry.name === "catalog")).toMatchObject({ kind: "alias", writeAliases: [] });
    expect(entries.find((entry) => entry.name === "orders-read")).toMatchObject({ kind: "alias" });
  });

  it("givenSingleSuffixedIndex_whenListingEntries_thenOfferedAsFamily", () => {
    expect(shownIndexEntries([index("payments-2026.11.23")])).toEqual([
      { name: "payments-*", kind: "family", members: 1, hidden: false, writeAliases: [] },
    ]);
  });

  it("givenTargets_whenListingEntries_thenFamiliesThenNamesSorted", () => {
    expect(shownIndexEntries(TARGETS).map((entry) => entry.name)).toEqual([
      "orders-*",
      "payments-*",
      ".security-7",
      "catalog",
      "logs",
      "orders-read",
      "products",
    ]);
  });

  it("givenHiddenFamilyMembers_whenListingEntries_thenListedByNameWithHiddenFlag", () => {
    const entries = shownIndexEntries([index(".ds-logs-2026.11.23-000001"), index("orders-000001", true)]);
    expect(entries).toEqual([
      { name: ".ds-logs-2026.11.23-000001", kind: "index", members: 0, hidden: true, writeAliases: [] },
      { name: "orders-000001", kind: "index", members: 0, hidden: true, writeAliases: [] },
    ]);
  });

  it("givenList_whenCounting_thenFamilyCountsOnceAndHiddenOnNeitherSide", () => {
    expect(shownIndexCount({ shownIndices: ["orders-*", "logs", ".security-7"] }, TARGETS)).toEqual({
      shown: 2,
      total: 6,
    });
  });

  it("givenSavedEntryNotInCluster_whenCounting_thenNotCounted", () => {
    expect(shownIndexCount({ shownIndices: ["orders-*", "gone-*", "deleted"] }, TARGETS)).toEqual({
      shown: 1,
      total: 6,
    });
  });

  it("givenTargetsNotListed_whenCounting_thenNull", () => {
    expect(shownIndexCount({ shownIndices: ["orders-*"] }, null)).toBeNull();
    expect(shownIndexCount({}, TARGETS)).toBeNull();
  });
});
