import type { PartitionLag, ResetPartition, ResetPreview, ResetTarget } from "@table-craft/desktop/engine/protocol.js";
import { bigOf, DEFAULT_LAG_WARNING } from "@table-craft/desktop/renderer/model/streamTree.js";
import { instantOf } from "@table-craft/desktop/renderer/model/topicRead.js";

/** A partition is hot when it lags this many times the median of its table's partitions. */
export const HOT_LAG_FACTOR = 3n;
const STEPS = [1n, 2n, 5n] as const;
const TEN = 10n;
const PERCENT = 100;

/** The smallest of 1, 2, 5 × 10ⁿ at or above `value`, so the ruler's axis reads in round numbers. */
export function niceCeiling(value: bigint): bigint {
  if (value <= 1n) return 1n;
  for (let power = 1n; ; power *= TEN) {
    for (const step of STEPS) if (step * power >= value) return step * power;
  }
}

/** One scale for every partition of a table, its far end the largest lag shown, rounded up. */
export interface LagScale {
  readonly max: bigint;
  /** Left to right: the far end, its half, and the head. */
  readonly ticks: readonly bigint[];
}

export function lagScale(lags: readonly (bigint | null)[]): LagScale {
  const largest = lags.reduce<bigint>((most, lag) => (lag !== null && lag > most ? lag : most), 0n);
  const max = niceCeiling(largest);
  return { max, ticks: [max, max / 2n, 0n] };
}

/** How far left of the head `lag` reaches on `scale`, as a percentage of the ruler. */
export function rulerPercent(lag: bigint | null, scale: LagScale): number {
  if (lag === null || lag <= 0n) return 0;
  const clamped = lag > scale.max ? scale.max : lag;
  return (Number(clamped) / Number(scale.max)) * PERCENT;
}

/** The axis's labels: the far end and its half grouped, then `head`; a half that is no whole number stays blank. */
export function axisLabels(scale: LagScale): readonly string[] {
  return scale.ticks.map((tick, index) => {
    if (index === scale.ticks.length - 1) return "head";
    if (index > 0 && tick * 2n !== scale.max) return "";
    return tick.toLocaleString("en-US");
  });
}

/**
 * Which of `lags` run hot: above `HOT_LAG_FACTOR` times the median, so two stuck partitions of
 * twelve stand out where a mean they inflate themselves would hide them.
 */
export function hotLags(lags: readonly (bigint | null)[]): readonly boolean[] {
  const known = lags.filter((lag): lag is bigint => lag !== null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const median = known[Math.floor((known.length - 1) / 2)];
  if (median === undefined) return lags.map(() => false);
  return lags.map((lag) => lag !== null && lag > 0n && lag > median * HOT_LAG_FACTOR);
}

export interface LagFinding {
  readonly total: bigint;
  readonly topics: readonly string[];
  /** The hot partitions as `topic` and number, and their share of the total in whole percent. */
  readonly hot: readonly { readonly topic: string; readonly partition: number }[];
  readonly hotShare: number;
}

/** The group tab's finding line: how far behind, and where the lag sits; null when nothing lags. */
export function lagFinding(offsets: readonly PartitionLag[]): LagFinding | null {
  const lags = offsets.map((offset) => bigOf(offset.lag));
  const total = lags.reduce<bigint>((sum, lag) => sum + (lag ?? 0n), 0n);
  if (total <= 0n) return null;
  const hotness = hotLags(lags);
  const hot = offsets.filter((_, index) => hotness[index] === true);
  const hotTotal = lags.reduce<bigint>((sum, lag, index) => sum + (hotness[index] === true ? (lag ?? 0n) : 0n), 0n);
  return {
    total,
    topics: [...new Set(offsets.map((offset) => offset.topic))],
    hot: hot.map(({ topic, partition }) => ({ topic, partition })),
    hotShare: Number((hotTotal * BigInt(PERCENT)) / total),
  };
}

/** `3 and 7`, `0, 3 and 7`: partitions named in a sentence. */
export function partitionList(partitions: readonly number[]): string {
  const names = partitions.map(String);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

export const RESET_KINDS = ["earliest", "latest", "timestamp", "offset", "shift"] as const;
export type ResetKind = (typeof RESET_KINDS)[number];

export const RESET_KIND_LABELS: Readonly<Record<ResetKind, string>> = {
  earliest: "Earliest",
  latest: "Latest",
  timestamp: "Timestamp",
  offset: "Offset",
  shift: "Shift By",
};

/** The Reset Offsets dialog's fields as typed. */
export interface ResetDraft {
  readonly kind: ResetKind;
  /** Blank for every partition of the scope, or a list such as `7` or `0, 3`. */
  readonly partitions: string;
  readonly timestamp: string;
  readonly offset: string;
  readonly shift: string;
}

/** The target the draft asks for, or what to fix first. */
export function resetTargetOf(draft: ResetDraft): ResetTarget | string {
  switch (draft.kind) {
    case "earliest":
    case "latest":
      return { kind: draft.kind };
    case "timestamp": {
      const timestamp = instantOf(draft.timestamp);
      return timestamp === null
        ? "Timestamp reads like 2026-11-21 09:00:00 (local time) or an ISO 8601 instant."
        : { kind: "timestamp", timestamp };
    }
    case "offset":
      return /^\d+$/.test(draft.offset.trim())
        ? { kind: "offset", offset: draft.offset.trim() }
        : "Offset is a whole number.";
    case "shift": {
      const by = draft.shift.trim().replace(/^\+/, "");
      return /^-?\d+$/.test(by) && by !== "0" && by !== "-0"
        ? { kind: "shift", by }
        : "Shift by a whole number of messages: negative to read again, positive to skip.";
    }
  }
}

export interface ResetApply {
  readonly label: string;
  readonly variant: "primary" | "warning";
  readonly disabled: boolean;
  /** Why Apply is off; null while it can run. */
  readonly reason: string | null;
}

const APPLY_LABEL = "Apply Reset";

/**
 * The dialog's Apply button (decision 11), whose label always states the consequence: `Apply and
 * Skip N`, `Apply and Re-read N`, or both. It warns when anything is skipped or more is read again
 * than `lagWarning`, and is off while the broker refuses or nothing is previewed.
 */
export function resetApply(preview: ResetPreview | null, lagWarning: number = DEFAULT_LAG_WARNING): ResetApply {
  if (preview === null)
    return { label: APPLY_LABEL, variant: "primary", disabled: true, reason: "Preview the reset first." };
  if (preview.token === null)
    return {
      label: APPLY_LABEL,
      variant: "primary",
      disabled: true,
      reason: preview.refusal ?? "The broker would not take this reset.",
    };
  const skipped = bigOf(preview.skipped) ?? 0n;
  const reread = bigOf(preview.reread) ?? 0n;
  const skip = skipped.toLocaleString("en-US");
  const again = reread.toLocaleString("en-US");
  const label =
    skipped > 0n && reread > 0n
      ? `Apply: Skip ${skip}, Re-read ${again}`
      : skipped > 0n
        ? `Apply and Skip ${skip}`
        : reread > 0n
          ? `Apply and Re-read ${again}`
          : APPLY_LABEL;
  const warning = skipped > 0n || reread > BigInt(Math.floor(lagWarning));
  return { label, variant: warning ? "warning" : "primary", disabled: false, reason: null };
}

/** The change of one previewed partition: positive moves forward and skips, negative reads again. */
export function resetChange(partition: ResetPartition): bigint | null {
  const change = bigOf(partition.change);
  if (change !== null) return change;
  const current = bigOf(partition.current);
  const next = bigOf(partition.next);
  return current === null || next === null ? null : next - current;
}

export interface ResetConsequence {
  /** Something gets skipped, which the dialog says in `--tc-warning`. */
  readonly warning: boolean;
  /** The partitions that move forward, as `topic` and number. */
  readonly forward: readonly { readonly topic: string; readonly partition: number }[];
  readonly skipped: bigint;
  readonly reread: bigint;
}

export function resetConsequence(preview: ResetPreview): ResetConsequence {
  const forward = preview.partitions.filter((partition) => (resetChange(partition) ?? 0n) > 0n);
  const skipped = bigOf(preview.skipped) ?? 0n;
  return {
    warning: skipped > 0n,
    forward: forward.map(({ topic, partition }) => ({ topic, partition })),
    skipped,
    reread: bigOf(preview.reread) ?? 0n,
  };
}

/** `−4,292`, `+2,334` or `0`: a signed change with a true minus. */
export function signedCount(value: bigint | null): string {
  if (value === null) return "";
  if (value === 0n) return "0";
  const magnitude = (value < 0n ? -value : value).toLocaleString("en-US");
  return value < 0n ? `\u2212${magnitude}` : `+${magnitude}`;
}

/** A decimal count grouped, or empty when unknown. */
export function grouped(text: string | null): string {
  const value = bigOf(text);
  return value === null ? "" : value.toLocaleString("en-US");
}

/** `1 message behind`, `38 messages behind`. */
export function behindText(total: bigint): string {
  return `${total.toLocaleString("en-US")} ${total === 1n ? "message" : "messages"} behind`;
}

/** Kafka reports a member's host as the `InetAddress` string, `/10.0.0.7`; the slash means no hostname. */
export function memberHost(host: string): string {
  return host.startsWith("/") ? host.slice(1) : host;
}
