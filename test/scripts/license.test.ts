import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const GPL = "GPL-3.0-or-later";
const MIT = "MIT";
const PLUGIN_API = join("packages", "plugin-api");
const WORKSPACE_DIRECTORIES = ["packages", "plugins"];
const GPL_V3_TITLE = /^\s*GNU GENERAL PUBLIC LICENSE\n\s*Version 3, 29 June 2007\n/;
const GPL_V3_END = "<https://www.gnu.org/licenses/why-not-lgpl.html>.\n";

function licenseOf(directory: string): unknown {
  return (JSON.parse(readFileSync(join(ROOT, directory, "package.json"), "utf8")) as { license?: unknown }).license;
}

function workspacePackages(): string[] {
  return WORKSPACE_DIRECTORIES.flatMap((parent) =>
    readdirSync(join(ROOT, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name)),
  );
}

describe("the repository's licence", () => {
  it("givenWorkspacePackages_whenRead_thenEveryLicenseIsGplExceptPluginApi", () => {
    const licenses = Object.fromEntries(
      ["", ...workspacePackages()].map((directory) => [directory, licenseOf(directory)]),
    );

    for (const [directory, license] of Object.entries(licenses)) {
      expect(license, directory || "the root package.json").toBe(directory === PLUGIN_API ? MIT : GPL);
    }
  });

  it("givenRootLicense_whenRead_thenItIsTheWholeGplV3Text", () => {
    const text = readFileSync(join(ROOT, "LICENSE"), "utf8");

    expect(text).toMatch(GPL_V3_TITLE);
    expect(text.endsWith(GPL_V3_END)).toBe(true);
  });

  it("givenPluginApi_whenItsLicenseIsRead_thenItIsMit", () => {
    expect(readFileSync(join(ROOT, PLUGIN_API, "LICENSE"), "utf8")).toMatch(/^MIT License\n/);
  });

  it("givenNotice_whenRead_thenItNamesTheOrLaterGrantAndTheExceptions", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");

    expect(notice).toContain("either version 3 of the\nLicense, or (at your option) any later version");
    expect(notice).toContain("LICENSE-EXCEPTION");
    expect(notice).toContain(join(PLUGIN_API, "LICENSE"));
  });
});
