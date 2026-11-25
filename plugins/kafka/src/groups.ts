import type { Group } from "@platformatic/kafka";
import type {
  GroupDescription,
  GroupManager,
  GroupMember,
  GroupSummary,
  PartitionLag,
  ResetPartition,
  ResetPreview,
  ResetScope,
  ResetTarget,
} from "@table-craft/plugin-api";
import type { KafkaAdmin, Watermarks } from "./admin.js";
import { failures, refused, unreportedOffsets, writeFailures } from "./failures.js";
import type { PreparedStore } from "./prepared.js";
import { timestampMillis } from "./readPlan.js";
import { guardWrite, readOnlyRefusal } from "./readOnly.js";

const RESET = "groupReset";
const NO_OFFSET = -1n;
/** States in which the coordinator accepts offsets from outside the group. */
const IDLE_STATES = new Set(["Empty", "Dead"]);
const STATE_WORD = /_([a-z])/g;

interface Committed {
  readonly topic: string;
  readonly partition: number;
  readonly offset: bigint;
  readonly metadata: string | null;
}

interface PreparedReset {
  readonly group: string;
  readonly offsets: readonly { readonly topic: string; readonly partition: number; readonly offset: bigint }[];
}

/** The coordinator's word for a state, `PreparingRebalance`, whichever case the driver hands over. */
export function stateWord(state: string): string {
  if (!state.includes("_") && state !== state.toUpperCase()) return state;
  const lower = state.toLowerCase().replace(STATE_WORD, (_, letter: string) => letter.toUpperCase());
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** The refusal of an offset change while members are active (decision 11); null when idle. */
export function activeRefusal(state: string, members: number): string | null {
  if (members === 0 && IDLE_STATES.has(state)) return null;
  if (members === 0) return `The group is ${state}; wait until it is Empty, then prepare the reset again.`;
  return `Stop the group's consumers first: ${String(members)} ${members === 1 ? "member is" : "members are"} active`;
}

function lagOf(committed: bigint | null, high: bigint | null): bigint | null {
  if (committed === null || high === null) return null;
  const lag = high - committed;
  return lag < 0n ? 0n : lag;
}

/** Each partition once: a ListOffsets naming a partition twice fails whole with INVALID_REQUEST. */
export function topicMap(
  entries: readonly { readonly topic: string; readonly partition: number }[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const entry of entries) {
    const partitions = map.get(entry.topic) ?? [];
    if (!partitions.includes(entry.partition)) partitions.push(entry.partition);
    map.set(entry.topic, partitions);
  }
  return map;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/** The `consumerGroups` service (Phase 5 of plan 164). It never removes members to force a change. */
export class KafkaGroups implements GroupManager {
  readonly #admin: KafkaAdmin;
  readonly #prepared: PreparedStore;
  readonly #readOnly: boolean;
  readonly #listed: (name: string) => boolean;

  constructor(admin: KafkaAdmin, prepared: PreparedStore, readOnly: boolean, listed: (name: string) => boolean) {
    this.#admin = admin;
    this.#prepared = prepared;
    this.#readOnly = readOnly;
    this.#listed = listed;
  }

  async #committed(groups: readonly string[], topic: string | null = null): Promise<Map<string, Committed[]>> {
    const result = new Map<string, Committed[]>();
    if (groups.length === 0) return result;
    const listed = await failures(() =>
      this.#admin.reader.listConsumerGroupOffsets({ groups: groups.map((groupId) => ({ groupId })) }),
    );
    for (const group of listed) {
      const entries: Committed[] = [];
      for (const entry of group.topics) {
        if (topic !== null && entry.name !== topic) continue;
        for (const partition of entry.partitions) {
          if (partition.committedOffset < 0n) continue;
          entries.push({
            topic: entry.name,
            partition: partition.partitionIndex,
            offset: partition.committedOffset,
            metadata: partition.metadata ?? null,
          });
        }
      }
      result.set(group.groupId, entries);
    }
    return result;
  }

  async #marks(
    entries: readonly { topic: string; partition: number }[],
  ): Promise<Map<string, Map<number, Watermarks>>> {
    return this.#admin.watermarks(topicMap(entries)).catch(() => new Map<string, Map<number, Watermarks>>());
  }

  async #describeGroup(id: string): Promise<Group> {
    const described = await failures(() => this.#admin.reader.describeGroups({ groups: [id] }));
    const group = described.get(id);
    if (group === undefined) throw refused(`There is no consumer group ${id}.`);
    return group;
  }

  #totalLag(entries: readonly Committed[], marks: ReadonlyMap<string, ReadonlyMap<number, Watermarks>>): string | null {
    let total = 0n;
    let known = false;
    for (const entry of entries) {
      const lag = lagOf(entry.offset, marks.get(entry.topic)?.get(entry.partition)?.high ?? null);
      if (lag === null) continue;
      total += lag;
      known = true;
    }
    return known ? total.toString() : null;
  }

  async list(): Promise<readonly GroupSummary[]> {
    const groups = await failures(() => this.#admin.reader.listGroups());
    const ids = [...groups.keys()].filter(this.#listed).sort();
    const committed = await this.#committed(ids).catch(() => new Map<string, Committed[]>());
    const marks = await this.#marks([...committed.values()].flat());
    return ids.map((id) => {
      const group = groups.get(id);
      const entries = committed.get(id);
      return {
        id,
        state: stateWord(group?.state ?? "Unknown"),
        protocolType: group?.protocolType === undefined || group.protocolType === "" ? null : group.protocolType,
        members: null,
        lag: entries === undefined ? null : this.#totalLag(entries, marks),
      };
    });
  }

  async describe(id: string): Promise<GroupDescription> {
    const [group, committed] = await Promise.all([this.#describeGroup(id), this.#committed([id])]);
    const entries = committed.get(id) ?? [];
    const marks = await this.#marks(entries);
    const offsets = entries
      .map((entry): PartitionLag => {
        const high = marks.get(entry.topic)?.get(entry.partition)?.high ?? null;
        return {
          topic: entry.topic,
          partition: entry.partition,
          committed: entry.offset.toString(),
          high: high?.toString() ?? null,
          lag: lagOf(entry.offset, high)?.toString() ?? null,
          metadata: entry.metadata === "" ? null : entry.metadata,
        };
      })
      .sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition);
    const members = [...group.members.values()].map((member): GroupMember => ({
      id: member.id,
      instanceId: member.groupInstanceId ?? null,
      clientId: member.clientId,
      host: member.clientHost,
      assignments: [...(member.assignments?.values() ?? [])].map((assignment) => ({
        topic: assignment.topic,
        partitions: [...assignment.partitions].sort((a, b) => a - b),
      })),
    }));
    return {
      id,
      state: stateWord(group.state),
      protocolType: group.protocolType === "" ? null : group.protocolType,
      protocol: group.protocol === "" ? null : group.protocol,
      members,
      offsets,
      lag: this.#totalLag(entries, marks),
    };
  }

  async consumersOf(topic: string): Promise<readonly GroupSummary[]> {
    const groups = await failures(() => this.#admin.reader.listGroups());
    const committed = await this.#committed([...groups.keys()].filter(this.#listed), topic);
    const marks = await this.#marks([...committed.values()].flat());
    return [...committed.entries()]
      .filter(([, entries]) => entries.length > 0)
      .map(([id, entries]) => {
        const group = groups.get(id);
        return {
          id,
          state: stateWord(group?.state ?? "Unknown"),
          protocolType: group?.protocolType === undefined || group.protocolType === "" ? null : group.protocolType,
          members: null,
          lag: this.#totalLag(entries, marks),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async #targets(
    scope: ResetScope,
    entries: readonly Committed[],
  ): Promise<{ topic: string; partition: number; current: bigint | null }[]> {
    if (scope.topic === null) {
      return entries
        .filter((entry) => scope.partitions === null || scope.partitions.includes(entry.partition))
        .map((entry) => ({ topic: entry.topic, partition: entry.partition, current: entry.offset }));
    }
    const topic = scope.topic;
    const count = (await this.#admin.topic(topic)).partitionsCount;
    const partitions = scope.partitions ?? range(count);
    const outside = partitions.filter((partition) => partition < 0 || partition >= count);
    if (outside.length > 0) throw refused(`${topic} has no partition ${outside.join(", ")}.`);
    return partitions.map((partition) => ({
      topic,
      partition,
      current: entries.find((entry) => entry.topic === topic && entry.partition === partition)?.offset ?? null,
    }));
  }

  /**
   * The preview of a reset. On a read-only datasource it is still shown, as `--dry-run` asks, but
   * carries the read-only refusal and no token.
   */
  async prepareReset(group: string, scope: ResetScope, target: ResetTarget): Promise<ResetPreview> {
    const [described, committed] = await Promise.all([this.#describeGroup(group), this.#committed([group])]);
    const state = stateWord(described.state);
    const refusal = this.#readOnly
      ? readOnlyRefusal(`resetting the offsets of ${group}`).message
      : activeRefusal(state, described.members.size);
    const targets = await this.#targets(scope, committed.get(group) ?? []);
    if (targets.length === 0) {
      throw refused(
        `${group} has no committed offsets${scope.topic === null ? "" : ` on ${scope.topic}`}; name a topic to reset.`,
      );
    }
    const marks = await this.#admin.watermarks(topicMap(targets));
    const at =
      target.kind === "timestamp"
        ? await this.#admin.offsetsAt(topicMap(targets), timestampMillis(target.timestamp))
        : new Map<string, Map<number, bigint>>();
    if (
      (target.kind === "offset" && !/^\d+$/.test(target.offset)) ||
      (target.kind === "shift" && !/^[-+]?\d+$/.test(target.by))
    ) {
      throw refused("The reset target is not a whole number.");
    }
    let skipped = 0n;
    let reread = 0n;
    const partitions: ResetPartition[] = [];
    const offsets: PreparedReset["offsets"][number][] = [];
    for (const entry of targets) {
      const mark = marks.get(entry.topic)?.get(entry.partition);
      if (mark === undefined) throw refused(unreportedOffsets(entry.topic, entry.partition));
      let next: bigint;
      switch (target.kind) {
        case "earliest":
          next = mark.low;
          break;
        case "latest":
          next = mark.high;
          break;
        case "offset":
          next = BigInt(target.offset);
          break;
        case "timestamp": {
          const found = at.get(entry.topic)?.get(entry.partition) ?? NO_OFFSET;
          next = found < 0n ? mark.high : found;
          break;
        }
        case "shift":
          next = (entry.current ?? mark.low) + BigInt(target.by);
          break;
      }
      next = next < mark.low ? mark.low : next > mark.high ? mark.high : next;
      const change = entry.current === null ? null : next - entry.current;
      if (change !== null && change > 0n) skipped += change;
      if (change !== null && change < 0n) reread -= change;
      partitions.push({
        topic: entry.topic,
        partition: entry.partition,
        current: entry.current?.toString() ?? null,
        next: next.toString(),
        high: mark.high.toString(),
        lagAfter: (mark.high - next).toString(),
        change: change?.toString() ?? null,
      });
      offsets.push({ topic: entry.topic, partition: entry.partition, offset: next });
    }
    const token = refusal === null ? this.#prepared.put(RESET, { group, offsets } satisfies PreparedReset) : null;
    return { token, group, state, refusal, partitions, skipped: skipped.toString(), reread: reread.toString() };
  }

  async applyReset(token: string): Promise<void> {
    guardWrite(this.#readOnly, "resetting offsets");
    const prepared = this.#prepared.take<PreparedReset>(RESET, token);
    const described = await this.#describeGroup(prepared.group);
    const refusal = activeRefusal(stateWord(described.state), described.members.size);
    if (refusal !== null) throw refused(`${refusal}. Nothing was changed.`);
    const topics = [...topicMap(prepared.offsets).keys()].map((name) => ({
      name,
      partitionOffsets: prepared.offsets
        .filter((entry) => entry.topic === name)
        .map((entry) => ({ partition: entry.partition, offset: entry.offset })),
    }));
    await writeFailures(
      () => this.#admin.writer.alterConsumerGroupOffsets({ groupId: prepared.group, topics }),
      `Kafka refused the new offsets of ${prepared.group}: `,
    );
  }

  async deleteOffsets(group: string, topic: string): Promise<void> {
    guardWrite(this.#readOnly, `deleting the offsets of ${group} on ${topic}`);
    const entries = (await this.#committed([group], topic)).get(group) ?? [];
    if (entries.length === 0) throw refused(`${group} has no committed offsets on ${topic}.`);
    await writeFailures(
      () =>
        this.#admin.writer.deleteConsumerGroupOffsets({
          groupId: group,
          topics: [{ name: topic, partitionIndexes: entries.map((entry) => entry.partition) }],
        }),
      `Kafka refused to delete the offsets of ${group} on ${topic}: `,
    );
  }

  async remove(group: string): Promise<void> {
    guardWrite(this.#readOnly, `deleting group ${group}`);
    const described = await this.#describeGroup(group);
    if (described.members.size > 0) {
      throw refused(
        `${activeRefusal(stateWord(described.state), described.members.size) ?? ""}; a group with members cannot be deleted.`,
      );
    }
    await writeFailures(
      () => this.#admin.writer.deleteGroups({ groups: [group] }),
      `Kafka refused to delete ${group}: `,
    );
  }
}
