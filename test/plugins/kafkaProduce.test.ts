import { describe, expect, it } from "vitest";
import { untilLeaderReady } from "@table-craft/plugin-kafka/produce";

const NO_PAUSE = () => Promise.resolve();

function protocolError(apiId: string): Error {
  return Object.assign(new Error("Producing messages failed."), {
    errors: [Object.assign(new Error(apiId), { code: "PLT_KFK_PROTOCOL", apiId })],
  });
}

describe("kafka produce", () => {
  it("givenLeaderNotElectedYet_whenProduce_thenSentAgainAfterRefresh", async () => {
    let sends = 0;
    let refreshes = 0;
    const result = await untilLeaderReady(
      () => {
        sends += 1;
        return sends < 3 ? Promise.reject(protocolError("NOT_LEADER_OR_FOLLOWER")) : Promise.resolve("sent");
      },
      () => {
        refreshes += 1;
        return Promise.resolve();
      },
      NO_PAUSE,
    );
    expect(result).toBe("sent");
    expect([sends, refreshes]).toEqual([3, 2]);
  });

  it("givenOtherRefusal_whenProduce_thenNotSentAgain", async () => {
    let sends = 0;
    const refusal = protocolError("MESSAGE_TOO_LARGE");
    const pending = untilLeaderReady(
      () => {
        sends += 1;
        return Promise.reject(refusal);
      },
      () => Promise.resolve(),
      NO_PAUSE,
    );
    await expect(pending).rejects.toBe(refusal);
    expect(sends).toBe(1);
  });

  it("givenLeaderNeverReady_whenProduce_thenGivesUpWithTheRefusal", async () => {
    let sends = 0;
    const pending = untilLeaderReady(
      () => {
        sends += 1;
        return Promise.reject(protocolError("LEADER_NOT_AVAILABLE"));
      },
      () => Promise.resolve(),
      NO_PAUSE,
    );
    await expect(pending).rejects.toThrow("Producing messages failed.");
    expect(sends).toBe(5);
  });
});
