import { describe, expect, it } from "vitest";
import { topicMap } from "@table-craft/plugin-kafka/groups";

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
