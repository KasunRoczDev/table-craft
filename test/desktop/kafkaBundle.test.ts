import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importMurmur2Cache } from "../../packages/desktop/vite.plugins.config.js";

/** @platformatic/kafka as the kafka plugin depends on it, so the test follows the version the bundle takes. */
const fromKafkaPlugin = createRequire(join(import.meta.dirname, "..", "..", "plugins", "kafka", "package.json"));
const MURMUR2 = join(fromKafkaPlugin.resolve("@platformatic/kafka"), "..", "protocol", "murmur2.js");

describe("kafka driver bundling (plan 164)", () => {
  it("givenMurmur2Partitioner_whenRewritten_thenMnemonistIsImportedNotRequiredAtRunTime", () => {
    const code = importMurmur2Cache(readFileSync(MURMUR2, "utf8"), MURMUR2);
    expect(code).toContain("import { LRUCache } from 'mnemonist';");
    expect(code).not.toContain("require('mnemonist");
  });

  it("givenModuleWithoutTheRequire_whenRewritten_thenTheBuildFailsNamingWhatToUpdate", () => {
    expect(() => importMurmur2Cache("export const x = 1;", MURMUR2)).toThrow(/update MURMUR2_REQUIRE/);
  });
});
