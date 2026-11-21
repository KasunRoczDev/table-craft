import { describe, expect, it, vi } from "vitest";
import type { EngineClient } from "@table-craft/desktop/renderer/engine/client.js";
import { createGroupTabsStore } from "@table-craft/desktop/renderer/state/groupTabs.js";
import { createSubjectTabsStore } from "@table-craft/desktop/renderer/state/subjectTabs.js";

const TARGET = { datasourceId: "kafka", group: "billing" };

function groupStore(connected: () => boolean) {
  const call = vi.fn(() => Promise.resolve({ group: "billing" }));
  const connect = vi.fn(() => Promise.resolve({ call } as unknown as EngineClient));
  return { store: createGroupTabsStore({ connect, connected }), connect };
}

describe("group tabs", () => {
  it("givenDisconnectedDatasource_whenTimerRefreshes_thenItDoesNotConnect", async () => {
    let online = true;
    const { store, connect } = groupStore(() => online);
    await store.getState().open("g1", TARGET);
    online = false;
    store.getState().detach("kafka");

    await store.getState().refresh("g1", true);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("givenDisconnectedDatasource_whenRefreshAsked_thenItConnects", async () => {
    const { store, connect } = groupStore(() => false);
    await store.getState().open("g1", TARGET);

    await store.getState().refresh("g1");

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("givenConnectedDatasource_whenTimerRefreshes_thenLagReadAgain", async () => {
    const { store, connect } = groupStore(() => true);
    await store.getState().open("g1", TARGET);

    await store.getState().refresh("g1", true);

    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe("subject tabs", () => {
  it("givenReadInFlight_whenDetached_thenItsAnswerIsDroppedAndLoadingEnds", async () => {
    let answer: (versions: number[]) => void = () => undefined;
    const call = vi.fn((type: string): Promise<unknown> =>
      type === "schemas.versions" ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(null),
    );
    const store = createSubjectTabsStore(() => Promise.resolve({ call } as unknown as EngineClient));
    const opened = store.getState().open("s1", { datasourceId: "kafka", subject: "orders-value" });
    await vi.waitFor(() => expect(call).toHaveBeenCalledWith("schemas.versions", expect.anything()));

    store.getState().detach("kafka");
    answer([1]);
    await opened;

    expect(store.getState().tabs.s1).toMatchObject({ loading: false, versions: null });
  });
});
