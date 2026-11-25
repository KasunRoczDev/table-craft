import { describe, expect, it } from "vitest";
import { engineRequestSchema } from "@table-craft/desktop/engine/requests.js";

const INT32_MAX = 2_147_483_647;
const CREATE = { name: "orders", partitions: 3, replicationFactor: 1, configs: [] };

const parses = (request: object): boolean => engineRequestSchema.safeParse({ id: 1, ...request }).success;

describe("stream request sizes", () => {
  it("givenNumbersPastWhatKafkaSends_whenParsed_thenRefused", () => {
    expect(parses({ type: "topics.create", request: CREATE, validateOnly: false })).toBe(true);
    expect(
      parses({ type: "topics.create", request: { ...CREATE, partitions: INT32_MAX + 1 }, validateOnly: false }),
    ).toBe(false);
    expect(
      parses({ type: "topics.create", request: { ...CREATE, replicationFactor: 32_768 }, validateOnly: false }),
    ).toBe(false);
    expect(parses({ type: "topics.addPartitions", topic: "orders", total: INT32_MAX + 1, validateOnly: false })).toBe(
      false,
    );
    expect(parses({ type: "topics.message", handle: "h", partition: INT32_MAX + 1, offset: "1" })).toBe(false);
    expect(parses({ type: "topics.message", handle: "h".repeat(257), partition: 0, offset: "1" })).toBe(false);
  });
});
