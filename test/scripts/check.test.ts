import { PluginError, type DatasourcePlugin } from "@table-craft/plugin-api";
import plugin from "@table-craft/plugin-kafka";
import { describe, expect, it } from "vitest";
import { PackageCheckError, runOffline } from "../../scripts/plugins/check.js";

const FILE = "kafka.tgz";
/** Three tries of a one-second request against a broker that never answers, with room to spare. */
const SILENT_BROKER_TIMEOUT_MS = 20_000;

function kafkaConfig(port: number): unknown {
  return { bootstrapServers: `127.0.0.1:${String(port)}`, requestTimeout: 1 };
}

function failingWith(error: unknown): DatasourcePlugin {
  return {
    ...plugin,
    connect: () => Promise.reject(error instanceof Error ? error : new Error(String(error))),
  };
}

describe("offline plugin smoke", () => {
  it(
    "givenKafkaPlugin_whenConnectedToASilentBroker_thenFailsAsAConnectionFailureAndPasses",
    async () => {
      await expect(runOffline(FILE, plugin, kafkaConfig)).resolves.toBeUndefined();
    },
    SILENT_BROKER_TIMEOUT_MS,
  );

  it("givenDriverMissingAModule_whenSmoked_thenTheCheckNamesTheModule", async () => {
    const missing = new Error("Cannot find module 'ajv'", { cause: { code: "MODULE_NOT_FOUND" } });
    const wrapped = new PluginError("connectionFailed", "Cannot reach the bootstrap servers", { cause: missing });

    const smoke = runOffline(FILE, failingWith(wrapped), kafkaConfig);

    await expect(smoke).rejects.toBeInstanceOf(PackageCheckError);
    await expect(smoke).rejects.toThrow(/run time: Cannot find module 'ajv'/);
  });

  it("givenAnotherFailure_whenSmoked_thenTheCheckFails", async () => {
    await expect(runOffline(FILE, failingWith(new TypeError("boom")), kafkaConfig)).rejects.toThrow(
      /silent server with boom/,
    );
  });

  it("givenPluginThatConnects_whenSmoked_thenTheCheckFails", async () => {
    let closed = false;
    const connecting: DatasourcePlugin = {
      ...plugin,
      connect: () =>
        Promise.resolve({
          close: () => {
            closed = true;
            return Promise.resolve();
          },
        } as unknown as Awaited<ReturnType<DatasourcePlugin["connect"]>>),
    };

    await expect(runOffline(FILE, connecting, kafkaConfig)).rejects.toThrow(/never answered/);
    expect(closed).toBe(true);
  });
});
