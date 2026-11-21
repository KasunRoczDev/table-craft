import type { KafkaAdmin } from "@table-craft/plugin-kafka/admin";
import { KafkaGroups, topicMap } from "@table-craft/plugin-kafka/groups";
import { describe, expect, it } from "vitest";

describe("topicMap", () => {
  it("givenGroupsCommittedOnTheSamePartition_whenMapped_thenEachPartitionIsAskedOnce", () => {
    const map = topicMap([
      { topic: "orders", partition: 0 },
      { topic: "orders", partition: 1 },
      { topic: "orders", partition: 0 },
      { topic: "audit", partition: 0 },
    ]);
    expect([...map.entries()]).toEqual([
      ["orders", [0, 1]],
      ["audit", [0]],
    ]);
  });
});

function groupAdmin(marks: Map<number, { low: bigint; high: bigint }>): KafkaAdmin {
  return {
    reader: {
      describeGroups: () => Promise.resolve(new Map([["billing", { state: "EMPTY", members: new Map() }]])),
      listConsumerGroupOffsets: () =>
        Promise.resolve([
          {
            groupId: "billing",
            topics: [{ name: "orders", partitions: [{ partitionIndex: 0, committedOffset: 4n, metadata: null }] }],
          },
        ]),
    },
    watermarks: () => Promise.resolve(new Map([["orders", marks]])),
  } as unknown as KafkaAdmin;
}

const ALL_TOPICS = { topic: null, partitions: null } as const;

describe("kafka group reset preview", () => {
  it("givenReadOnly_whenDryRunPrepared_thenPreviewWithRefusalAndNoToken", async () => {
    const groups = new KafkaGroups(groupAdmin(new Map([[0, { low: 0n, high: 9n }]])), {} as never, true, () => true);
    const preview = await groups.prepareReset("billing", ALL_TOPICS, { kind: "latest" });
    expect(preview.token).toBeNull();
    expect(preview.refusal).toMatch(/read-only/i);
    expect(preview.partitions[0]?.next).toBe("9");
  });

  it("givenPartitionWithoutWatermark_whenPrepared_thenRefusedNotSkipped", async () => {
    const groups = new KafkaGroups(groupAdmin(new Map()), {} as never, true, () => true);
    await expect(groups.prepareReset("billing", ALL_TOPICS, { kind: "latest" })).rejects.toThrow(/orders/);
  });
});
