// Mirrors plugin-api's `groups.ts` (plan 164). Offsets, watermarks and lags are decimal strings;
// null means unknown or never committed.

/** Mirrors `GroupSummary` in plugin-api. */
export interface GroupSummary {
  readonly id: string;
  readonly state: string;
  readonly protocolType: string | null;
  readonly members: number | null;
  readonly lag: string | null;
}

/** Mirrors `GroupAssignment` in plugin-api. */
export interface GroupAssignment {
  readonly topic: string;
  readonly partitions: readonly number[];
}

/** Mirrors `GroupMember` in plugin-api. */
export interface GroupMember {
  readonly id: string;
  readonly instanceId: string | null;
  readonly clientId: string;
  readonly host: string;
  readonly assignments: readonly GroupAssignment[];
}

/** Mirrors `PartitionLag` in plugin-api. */
export interface PartitionLag {
  readonly topic: string;
  readonly partition: number;
  readonly committed: string | null;
  readonly high: string | null;
  readonly lag: string | null;
  readonly metadata: string | null;
}

/** Mirrors `GroupDescription` in plugin-api. */
export interface GroupDescription {
  readonly id: string;
  readonly state: string;
  readonly protocolType: string | null;
  readonly protocol: string | null;
  readonly members: readonly GroupMember[];
  readonly offsets: readonly PartitionLag[];
  readonly lag: string | null;
}

/** Mirrors `ResetTarget` in plugin-api. */
export type ResetTarget =
  | { readonly kind: "earliest" }
  | { readonly kind: "latest" }
  | { readonly kind: "offset"; readonly offset: string }
  | { readonly kind: "timestamp"; readonly timestamp: string }
  | { readonly kind: "shift"; readonly by: string };

/** Mirrors `ResetScope` in plugin-api. */
export interface ResetScope {
  readonly topic: string | null;
  readonly partitions: readonly number[] | null;
}

/** Mirrors `ResetPartition` in plugin-api. */
export interface ResetPartition {
  readonly topic: string;
  readonly partition: number;
  readonly current: string | null;
  readonly next: string;
  readonly high: string | null;
  readonly lagAfter: string | null;
  readonly change: string | null;
}

/** Mirrors `ResetPreview` in plugin-api: a null `token` is a refusal, `refusal` says why. */
export interface ResetPreview {
  readonly token: string | null;
  readonly group: string;
  readonly state: string;
  readonly refusal: string | null;
  readonly partitions: readonly ResetPartition[];
  readonly skipped: string;
  readonly reread: string;
}
