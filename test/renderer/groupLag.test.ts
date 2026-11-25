import { describe, expect, it } from "vitest";
import type { PartitionLag, ResetPreview } from "@table-craft/desktop/engine/protocol.js";
import {
  axisLabels,
  behindText,
  hotLags,
  lagFinding,
  lagScale,
  memberHost,
  niceCeiling,
  partitionList,
  resetApply,
  resetConsequence,
  resetTargetOf,
  rulerPercent,
  signedCount,
} from "@table-craft/desktop/renderer/model/groupLag.js";
import {
  configChangesOf,
  partitionTotalOf,
  recordsBeforeOf,
  topicCreateOf,
} from "@table-craft/desktop/renderer/model/topicAdmin.js";

function lag(partition: number, behind: string | null): PartitionLag {
  return { topic: "orders.v1", partition, committed: "1000", high: "2000", lag: behind, metadata: null };
}

const PREVIEW: ResetPreview = {
  token: "2fb18aa",
  group: "billing-worker",
  state: "Empty",
  refusal: null,
  partitions: [
    {
      topic: "orders.v1",
      partition: 0,
      current: "1613794",
      next: "1609502",
      high: "1614208",
      lagAfter: "4706",
      change: "-4292",
    },
    {
      topic: "orders.v1",
      partition: 3,
      current: "1581101",
      next: "1583435",
      high: "1588102",
      lagAfter: "4667",
      change: "2334",
    },
  ],
  skipped: "4891",
  reread: "43731",
};

describe("lag ruler", () => {
  it("givenLags_whenScaled_thenOneRoundScaleForEveryPartition", () => {
    expect(niceCeiling(7_669n)).toBe(10_000n);
    expect(niceCeiling(1_500n)).toBe(2_000n);
    expect(niceCeiling(400n)).toBe(500n);
    expect(niceCeiling(0n)).toBe(1n);
    const scale = lagScale([414n, 7_001n, null, 7_669n]);
    expect(scale.max).toBe(10_000n);
    expect(axisLabels(scale)).toEqual(["10,000", "5,000", "head"]);
    expect(rulerPercent(5_000n, scale)).toBe(50);
    expect(rulerPercent(20_000n, scale)).toBe(100);
    expect(rulerPercent(null, scale)).toBe(0);
  });

  it("givenOneMessageOfLag_whenScaled_thenTheHalfStaysBlankAndOnlyTheHeadSaysHead", () => {
    expect(axisLabels(lagScale([1n]))).toEqual(["1", "", "head"]);
    expect(axisLabels(lagScale([4n]))).toEqual(["5", "", "head"]);
    expect(axisLabels(lagScale([2n]))).toEqual(["2", "1", "head"]);
  });

  it("givenOneMessageBehind_whenWorded_thenSingular", () => {
    expect(behindText(1n)).toBe("1 message behind");
    expect(behindText(38_000n)).toBe("38,000 messages behind");
  });

  it("givenKafkaInetAddressHost_whenShown_thenTheSlashGoes", () => {
    expect(memberHost("/10.0.0.7")).toBe("10.0.0.7");
    expect(memberHost("worker-1/10.0.0.7")).toBe("worker-1/10.0.0.7");
  });

  it("givenTwoStuckPartitions_whenHot_thenOnlyThoseWarn", () => {
    const lags = [414n, 426n, 7_001n, 421n, 7_669n, 430n, null];
    expect(hotLags(lags)).toEqual([false, false, true, false, true, false, false]);
    expect(hotLags([0n, 0n])).toEqual([false, false]);
  });

  it("givenOffsets_whenFinding_thenTotalAndHotShare", () => {
    const finding = lagFinding([lag(0, "400"), lag(1, "400"), lag(3, "7000"), lag(7, "7600"), lag(8, "400")]);
    expect(finding).toMatchObject({ total: 15_800n, topics: ["orders.v1"], hotShare: 92 });
    expect(finding?.hot.map((each) => each.partition)).toEqual([3, 7]);
    expect(partitionList([3, 7])).toBe("3 and 7");
    expect(partitionList([0, 3, 7])).toBe("0, 3 and 7");
    expect(lagFinding([lag(0, "0"), lag(1, null)])).toBeNull();
  });
});

describe("reset offsets", () => {
  it("givenForwardAndBackPartitions_whenApply_thenWarningNamesBoth", () => {
    expect(resetApply(PREVIEW)).toEqual({
      label: "Apply: Skip 4,891, Re-read 43,731",
      variant: "warning",
      disabled: false,
      reason: null,
    });
  });

  it("givenOnePartitionForward_whenApply_thenWarningApplyAndSkipN", () => {
    expect(resetApply({ ...PREVIEW, skipped: "1", reread: "0" })).toMatchObject({
      label: "Apply and Skip 1",
      variant: "warning",
    });
  });

  it("givenRereadAboveTheLagWarning_whenApply_thenWarningApplyAndRereadN", () => {
    expect(resetApply({ ...PREVIEW, skipped: "0" })).toMatchObject({
      label: "Apply and Re-read 43,731",
      variant: "warning",
    });
    expect(resetApply({ ...PREVIEW, skipped: "0" }, 50_000)).toMatchObject({ variant: "primary" });
  });

  it("givenNothingMoves_whenApply_thenPrimaryApplyReset", () => {
    expect(resetApply({ ...PREVIEW, skipped: "0", reread: "0" })).toEqual({
      label: "Apply Reset",
      variant: "primary",
      disabled: false,
      reason: null,
    });
  });

  it("givenActiveGroup_whenApply_thenDisabledWithRefusal", () => {
    const refused = { ...PREVIEW, token: null, refusal: "Stop the group's consumers first: 3 members are active" };
    expect(resetApply(refused)).toMatchObject({ disabled: true, reason: refused.refusal });
    expect(resetApply(null)).toMatchObject({ disabled: true, label: "Apply Reset" });
  });

  it("givenPreview_whenConsequence_thenForwardSkippedAndReread", () => {
    const consequence = resetConsequence(PREVIEW);
    expect(consequence).toMatchObject({ warning: true, skipped: 4_891n, reread: 43_731n });
    expect(consequence.forward).toEqual([{ topic: "orders.v1", partition: 3 }]);
    expect(signedCount(-4_292n)).toBe("\u22124,292");
    expect(signedCount(2_334n)).toBe("+2,334");
  });

  it("givenDraft_whenTarget_thenTargetOrProblem", () => {
    const draft = { kind: "shift" as const, partitions: "", timestamp: "", offset: "", shift: "+1000" };
    expect(resetTargetOf(draft)).toEqual({ kind: "shift", by: "1000" });
    expect(resetTargetOf({ ...draft, shift: "0" })).toMatch(/whole number/);
    expect(resetTargetOf({ ...draft, kind: "latest" })).toEqual({ kind: "latest" });
    expect(resetTargetOf({ ...draft, kind: "timestamp", timestamp: "nope" })).toMatch(/Timestamp/);
  });
});

describe("topic admin", () => {
  it("givenFields_whenCreate_thenRequestOrProblem", () => {
    expect(
      topicCreateOf({
        name: " orders.v2 ",
        partitions: "12",
        replication: "",
        configs: [
          { name: "retention.ms", value: "1" },
          { name: "", value: "" },
        ],
      }),
    ).toEqual({
      name: "orders.v2",
      partitions: 12,
      replicationFactor: null,
      configs: [{ name: "retention.ms", value: "1" }],
    });
    expect(topicCreateOf({ name: "a b", partitions: "1", replication: "", configs: [] })).toMatch(/letters/);
    expect(topicCreateOf({ name: "t", partitions: "0", replication: "", configs: [] })).toMatch(/Partitions/);
    expect(
      topicCreateOf({ name: "t", partitions: "1", replication: "", configs: [{ name: "retention.ms", value: " " }] }),
    ).toMatch(/value/);
  });

  it("givenEdits_whenChanges_thenOnlyWhatDiffers", () => {
    const entry = {
      source: "Topic",
      isDefault: false,
      sensitive: false,
      readOnly: false,
      documentation: null,
    };
    const configs = [
      { ...entry, name: "retention.ms", value: "100" },
      { ...entry, name: "cleanup.policy", value: "delete" },
      { ...entry, name: "segment.ms", value: "5", readOnly: true },
    ];
    expect(
      configChangesOf(configs, {
        "retention.ms": { kind: "set", value: "100" },
        "cleanup.policy": { kind: "reset" },
        "segment.ms": { kind: "set", value: "9" },
      }),
    ).toEqual([{ name: "cleanup.policy", value: null }]);
    expect(partitionTotalOf("12", 12)).toMatch(/above 12/);
    expect(partitionTotalOf("16", 12)).toBe(16);
    expect(recordsBeforeOf("offset", "42")).toEqual({ kind: "offset", offset: "42" });
    expect(recordsBeforeOf("latest", "")).toEqual({ kind: "latest" });
  });
});
