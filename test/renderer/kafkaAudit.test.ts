import { describe, expect, it } from "vitest";
import type { FilterChip, Row, TopicTailSummary } from "@table-craft/desktop/engine/protocol.js";
import { produceSchemaOf } from "@table-craft/desktop/renderer/actions/topicActions.js";
import { groupStateTone } from "@table-craft/desktop/renderer/model/streamTree.js";
import { LISTED_ATTEMPTS, untilListed } from "@table-craft/desktop/renderer/state/streams.js";
import { isFieldEnter } from "@table-craft/desktop/renderer/streams/enterKey.js";
import { zoneLabel, localZoneSuffix, utcInstantText } from "@table-craft/desktop/renderer/model/timeZone.js";
import {
  collidingTopic,
  configRowsOf,
  deleteRecordsNeedsName,
  typedMatches,
} from "@table-craft/desktop/renderer/model/topicAdmin.js";
import { messageCommand, messageJson, messageOf } from "@table-craft/desktop/renderer/model/topicMessage.js";
import {
  filteredPartition,
  scannedText,
  searchesOnlyNewest,
  stripSummary,
  toggledPartitionFilter,
} from "@table-craft/desktop/renderer/model/topicRead.js";
import {
  drawnTailRows,
  TAIL_DRAWN_ROWS,
  tailMatcher,
  tailStatus,
  tailTimestamp,
  type TailRow,
} from "@table-craft/desktop/renderer/tail/store.js";

const COLUMNS = ["partition", "offset", "timestamp", "key", "value", "headers", "size", "keySchema", "valueSchema"].map(
  (name) => ({ name }),
);

describe("typed-name gates", () => {
  it("givenTypedName_whenMatches_thenOnlyTheExactName", () => {
    expect(typedMatches(" orders.v1 ", "orders.v1")).toBe(true);
    expect(typedMatches("orders.V1", "orders.v1")).toBe(false);
    expect(typedMatches("", "orders.v1")).toBe(false);
  });

  it("givenDeleteRecordsPreview_whenAnythingRemoved_thenNameAsked", () => {
    expect(deleteRecordsNeedsName("12")).toBe(true);
    expect(deleteRecordsNeedsName("0")).toBe(false);
    expect(deleteRecordsNeedsName(null)).toBe(false);
  });
});

describe("create topic", () => {
  it("givenDotAndUnderscore_whenColliding_thenTheExistingTopic", () => {
    expect(collidingTopic("orders.v1", ["orders_v1", "audit"])).toBe("orders_v1");
    expect(collidingTopic("orders.v1", ["orders.v1"])).toBeNull();
    expect(collidingTopic("fresh", ["orders_v1"])).toBeNull();
  });

  it("givenConfigRows_whenRead_thenNamedRowsOrProblem", () => {
    expect(
      configRowsOf([
        { name: "retention.ms", value: " 60000 " },
        { name: "", value: "" },
      ]),
    ).toEqual([{ name: "retention.ms", value: "60000" }]);
    expect(configRowsOf([{ name: "retention.ms", value: "" }])).toMatch(/value/);
    expect(
      configRowsOf([
        { name: "a", value: "1" },
        { name: "a", value: "2" },
      ]),
    ).toMatch(/twice/);
  });
});

describe("group state badge", () => {
  it("givenStates_whenTone_thenEmptyCalmUnlessLagging", () => {
    expect(groupStateTone("Empty", false)).toBe("neutral");
    expect(groupStateTone("Empty", true)).toBe("warning");
    expect(groupStateTone("Stable", false)).toBe("success");
    expect(groupStateTone("PreparingRebalance", false)).toBe("warning");
    expect(groupStateTone("Dead", false)).toBe("danger");
  });
});

describe("partition strip", () => {
  it("givenStripClick_whenToggled_thenFilterChipOnThenOff", () => {
    const other: FilterChip = { column: 3, op: "notEquals", text: "cust" };
    const on = toggledPartitionFilter(COLUMNS, [other], 4);
    expect(filteredPartition(COLUMNS, on)).toBe(4);
    expect(on).toContainEqual(other);
    const moved = toggledPartitionFilter(COLUMNS, on, 2);
    expect(filteredPartition(COLUMNS, moved)).toBe(2);
    expect(toggledPartitionFilter(COLUMNS, moved, 2)).toEqual([other]);
    expect(toggledPartitionFilter([{ name: "key" }], [], 1)).toEqual([]);
  });

  it("givenManyPartitions_whenFolded_thenSummaryLine", () => {
    expect(stripSummary([0, 3, 0, 9])).toBe("Rows in 2 of 4 partitions");
  });
});

describe("read footer", () => {
  it("givenFilterUnderLatestN_whenFooter_thenSaysOnlyTheNewestWereSearched", () => {
    const request = {
      topic: "orders",
      partitions: null,
      from: { kind: "latestN" as const, count: 500 },
      limit: 500,
      keyFormat: "auto" as const,
      valueFormat: "auto" as const,
      filter: "cust-42",
      maxScan: null,
      resume: null,
    };
    expect(searchesOnlyNewest(request)).toBe(500);
    expect(searchesOnlyNewest({ ...request, filter: null })).toBeNull();
    expect(searchesOnlyNewest({ ...request, from: { kind: "earliest" } })).toBeNull();
    expect(scannedText({ scanned: "6000", matched: "0" }, true, 0, 500)).toBe(
      "Scanned 6,000 · 0 matched in the newest 500 of each partition",
    );
  });
});

describe("time zone", () => {
  it("givenOffsets_whenLabelled_thenUtcSigned", () => {
    expect(zoneLabel(420)).toBe("UTC+07:00");
    expect(zoneLabel(-210)).toBe("UTC\u221203:30");
    expect(zoneLabel(0)).toBe("UTC");
    expect(localZoneSuffix(new Date())).toMatch(/^Local \(UTC/);
  });

  it("givenTypedInstant_whenResolved_thenUtcText", () => {
    expect(utcInstantText("2026-11-21T09:00:00+07:00")).toBe("= 2026-11-21 02:00:00 UTC");
    expect(utcInstantText("not a time")).toBeNull();
  });
});

describe("message panel", () => {
  const row: Row = [
    3,
    { kind: "bigint", value: "1204331" },
    { kind: "date", iso: "2026-11-21T02:00:00.000Z" },
    "cust-42",
    { kind: "json", text: '{"id":1}' },
    { kind: "json", text: '[{"name":"trace","value":"abc"}]' },
    120,
    null,
    "AVRO id 12",
  ] as unknown as Row;

  it("givenRow_whenMessage_thenCellsHeadersAndSchema", () => {
    const message = messageOf(COLUMNS, row);
    expect(message).toMatchObject({
      partition: 3,
      offset: "1204331",
      key: "cust-42",
      valueJson: true,
      headers: [{ name: "trace", value: "abc" }],
      valueSchema: "AVRO id 12",
    });
    expect(JSON.parse(messageJson(message))).toMatchObject({ value: { id: 1 } });
    expect(messageCommand("orders.v1", message)).toBe("consume orders.v1 -p 3 --from offset:1204331 --limit 1");
    expect(messageCommand("odd name", message)).toContain('consume "odd name"');
  });
});

describe("produce schema", () => {
  it("givenValueSubject_whenProduce_thenItsLatestVersionPreselected", () => {
    const subjects = [{ subject: "orders-value", latestVersion: 2, type: "AVRO" as const }];
    expect(produceSchemaOf("orders", subjects, null)).toEqual({ subject: "orders-value", version: 2, type: "AVRO" });
    expect(produceSchemaOf("other", subjects, null)).toBeNull();
  });
});

describe("live tail pane", () => {
  const message = (sequence: number, key: string): TailRow => ({
    kind: "message",
    sequence: String(sequence),
    message: {
      partition: 0,
      offset: String(sequence),
      timestamp: "2026-11-21T02:00:00.000Z",
      key,
      value: "{}",
      headers: [],
      size: 2,
      keySchema: null,
      valueSchema: null,
    },
  });

  it("givenBurst_whenDrawn_thenOnlyTheNewestRowsAndHowManyHidden", () => {
    const rows = Array.from({ length: 2_000 }, (_, at) => message(at, `k${String(at)}`));
    const drawn = drawnTailRows(rows, "");
    expect(drawn.rows).toHaveLength(TAIL_DRAWN_ROWS);
    expect(drawn.hidden).toBe(1_000);
    expect(drawn.rows.at(-1)?.sequence).toBe("1999");
    expect(drawnTailRows(rows, "/^k1$/").rows.map((row) => row.sequence)).toEqual(["1"]);
  });

  it("givenRegexFilter_whenMatcher_thenRegexOrTextOrNull", () => {
    expect(tailMatcher("/cust-4\\d/")?.("cust-42")).toBe(true);
    expect(tailMatcher("CUST")?.("cust-42")).toBe(true);
    expect(tailMatcher("/(/")).toBeNull();
  });

  it("givenPausedTail_whenStatus_thenSaysItStillRuns", () => {
    const summary = { tailId: "t", state: "live", dropped: "3" } as unknown as TopicTailSummary;
    const retained = [message(1, "a")];
    expect(tailStatus({ paused: true, pending: 1_200, retained, summary })).toBe(
      "Paused · 1,200 new (tail still running) · 1 message · 3 dropped",
    );
    expect(tailStatus({ paused: false, pending: 0, retained, summary: { ...summary, dropped: "0" } })).toBe(
      "Live · 1 message",
    );
    expect(tailTimestamp("2026-11-21T02:00:00.000Z")).toBe("2026-11-21 02:00:00.000");
  });
});

describe("untilListed", () => {
  it("givenTopicListedOnTheThirdListing_whenCreated_thenListsUntilItShows", async () => {
    let listings = 0;
    const waits: number[] = [];
    const listed = await untilListed(
      () => {
        listings += 1;
        return Promise.resolve();
      },
      () => listings >= 3,
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    );
    expect(listed).toBe(true);
    expect(listings).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it("givenTopicNeverListed_whenCreated_thenStopsAfterTheAttempts", async () => {
    let listings = 0;
    const listed = await untilListed(
      () => {
        listings += 1;
        return Promise.resolve();
      },
      () => false,
      () => Promise.resolve(),
    );
    expect(listed).toBe(false);
    expect(listings).toBe(LISTED_ATTEMPTS);
  });
});

describe("isFieldEnter", () => {
  it("givenEnterInATextField_whenPressed_thenTheDialogRunsItsEnterStep", () => {
    expect(isFieldEnter("Enter", false, { tagName: "INPUT", type: "text" })).toBe(true);
    expect(isFieldEnter("Enter", false, { tagName: "INPUT" })).toBe(true);
  });

  it("givenEnterOnAButtonCheckboxOrEditor_whenPressed_thenLeftToTheControl", () => {
    expect(isFieldEnter("Enter", false, { tagName: "BUTTON", type: "button" })).toBe(false);
    expect(isFieldEnter("Enter", false, { tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isFieldEnter("Enter", false, { tagName: "DIV" })).toBe(false);
    expect(isFieldEnter("Enter", true, { tagName: "INPUT", type: "text" })).toBe(false);
    expect(isFieldEnter("Tab", false, { tagName: "INPUT", type: "text" })).toBe(false);
  });
});
