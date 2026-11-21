// Offsets, watermarks and lags are decimal strings; null means unknown or never committed.

export interface GroupSummary {
  readonly id: string;
  /** The coordinator's word: `Stable`, `Empty`, `PreparingRebalance`, `Dead`, ... */
  readonly state: string;
  readonly protocolType: string | null;
  /** Null when only listed, not described. */
  readonly members: number | null;
  /** Summed over every committed partition; null when not computed. */
  readonly lag: string | null;
}

export interface GroupAssignment {
  readonly topic: string;
  readonly partitions: readonly number[];
}

export interface GroupMember {
  readonly id: string;
  readonly instanceId: string | null;
  readonly clientId: string;
  readonly host: string;
  readonly assignments: readonly GroupAssignment[];
}

export interface PartitionLag {
  readonly topic: string;
  readonly partition: number;
  readonly committed: string | null;
  readonly high: string | null;
  readonly lag: string | null;
  readonly metadata: string | null;
}

export interface GroupDescription {
  readonly id: string;
  readonly state: string;
  readonly protocolType: string | null;
  readonly protocol: string | null;
  readonly members: readonly GroupMember[];
  readonly offsets: readonly PartitionLag[];
  readonly lag: string | null;
}

export type ResetTarget =
  | { readonly kind: "earliest" }
  | { readonly kind: "latest" }
  | { readonly kind: "offset"; readonly offset: string }
  | { readonly kind: "timestamp"; readonly timestamp: string }
  /** Moves each committed offset by `by`, negative to read again; clamped to the log. */
  | { readonly kind: "shift"; readonly by: string };

export interface ResetScope {
  /** Null for every topic the group has committed offsets on. */
  readonly topic: string | null;
  /** Null for every partition. */
  readonly partitions: readonly number[] | null;
}

export interface ResetPartition {
  readonly topic: string;
  readonly partition: number;
  readonly current: string | null;
  readonly next: string;
  readonly high: string | null;
  readonly lagAfter: string | null;
  /** `next` minus `current`: positive skips that many messages, negative reads them again. */
  readonly change: string | null;
}

export interface ResetPreview {
  /** Null when the reset is refused; `refusal` says why. */
  readonly token: string | null;
  readonly group: string;
  readonly state: string;
  /** Such as "Stop the group's consumers first: 3 members are active". */
  readonly refusal: string | null;
  readonly partitions: readonly ResetPartition[];
  /** Messages skipped and read again, summed. */
  readonly skipped: string;
  readonly reread: string;
}

/**
 * The `consumerGroups` service (plan 164). Kafka moves a group's offsets only while it has no
 * members; the service never removes members to force it. Every write rejects with
 * `statementFailed` on a read-only session before anything is sent. A write that fails with
 * `statementFailed` was refused and changed nothing; one that may have reached the server first
 * (a timeout or a lost connection after sending) carries `outcome: "unknown"` on the error, which
 * the host reports as possibly applied.
 */
export interface GroupManager {
  list(): Promise<readonly GroupSummary[]>;
  describe(group: string): Promise<GroupDescription>;
  /** The groups with committed offsets on `topic`, with their lag there. */
  consumersOf(topic: string): Promise<readonly GroupSummary[]>;
  prepareReset(group: string, scope: ResetScope, target: ResetTarget): Promise<ResetPreview>;
  /** Commits exactly the prepared offsets; rejects when the group gained members since. */
  applyReset(token: string): Promise<void>;
  deleteOffsets(group: string, topic: string): Promise<void>;
  /** Refused while the group has members. */
  remove(group: string): Promise<void>;
}
