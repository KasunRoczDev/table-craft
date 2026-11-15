import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fetchChangelog,
  releaseMarkdown,
  toChangelogEntry,
  type Fetch,
  type GitHubRelease,
} from "../../packages/website/scripts/releases.js";

const ROOT = join(import.meta.dirname, "..", "..");
const REPOSITORY = "https://github.com/tranphucbol/table-craft";
const INSTALL_NOTES = readFileSync(join(ROOT, ".github", "release-notes-install.md"), "utf8");

function release(overrides: Partial<GitHubRelease> = {}): GitHubRelease {
  return {
    tag_name: "v1.2.0",
    name: "v1.2.0",
    html_url: `${REPOSITORY}/releases/tag/v1.2.0`,
    published_at: "2026-11-01T10:00:00Z",
    draft: false,
    prerelease: false,
    body: "## New features\n* Something by @someone in #1",
    ...overrides,
  };
}

function answering(body: unknown, status = 200): Fetch {
  return () =>
    Promise.resolve({ ok: status < 400, status, statusText: "Forbidden", json: () => Promise.resolve(body) });
}

describe("the website's changelog", () => {
  it("givenDraftOrPrerelease_whenConverted_thenItIsLeftOut", () => {
    expect(toChangelogEntry(release({ draft: true }))).toBeUndefined();
    expect(toChangelogEntry(release({ prerelease: true }))).toBeUndefined();
    expect(toChangelogEntry(release({ published_at: null }))).toBeUndefined();
    expect(toChangelogEntry(release())?.version).toBe("v1.2.0");
  });

  it("givenReleaseBody_whenConverted_thenInstallBlockIsDropped", () => {
    const body = [
      INSTALL_NOTES.trim(),
      "",
      "<!-- Release notes generated using configuration in .github/release.yml at main -->",
      "",
      "## New features",
      "* Explain plans by @tranphucbol",
    ].join("\n");

    const markdown = releaseMarkdown(body);

    expect(markdown).not.toContain("## Install");
    expect(markdown).not.toContain("<!--");
    expect(markdown).not.toContain("TableCraft-arm64.dmg");
    expect(markdown).toMatch(
      /^### New features\n\* Explain plans by \[@tranphucbol\]\(https:\/\/github.com\/tranphucbol\)$/,
    );
  });

  it("givenPluginPackageList_whenConverted_thenItIsFoldedWithItsCount", () => {
    const body = [
      "## New features",
      "* Explain plans",
      "",
      "### Plugins on npm",
      "",
      "- [`@tablecraft-app/plugin-etcd@1.37.0`](https://www.npmjs.com/package/@tablecraft-app/plugin-etcd/v/1.37.0) (`latest`)",
      "- [`@tablecraft-app/plugin-redis@1.37.0`](https://www.npmjs.com/package/@tablecraft-app/plugin-redis/v/1.37.0) (`latest`)",
    ].join("\n");

    const html = toChangelogEntry(release({ body }))?.html ?? "";

    expect(html).toContain('<details class="tc-packages"><summary>Plugins on npm (2)</summary>');
    expect(html).not.toContain(" open");
    expect(html).toMatch(/<details[^>]*>[\s\S]*<li><a href="https:\/\/www\.npmjs\.com[\s\S]*<\/details>/);
    expect(html.indexOf("Explain plans")).toBeLessThan(html.indexOf("<details"));
  });

  it("givenGuideAndPullLinks_whenConverted_thenTheyPointIntoTheSiteAndReadAsNumbers", () => {
    const markdown = releaseMarkdown(
      [
        `* Redis Cluster in ${REPOSITORY}/pull/412, see [the guide](${REPOSITORY}/blob/main/docs/guide/redis.md#cluster)`,
        `**Full Changelog**: ${REPOSITORY}/compare/v1.1.0...v1.2.0`,
      ].join("\n"),
    );

    expect(markdown).toContain(`[#412](${REPOSITORY}/pull/412)`);
    expect(markdown).toContain("[the guide](/docs/redis/#cluster)");
    expect(markdown).toContain(`[v1.1.0...v1.2.0](${REPOSITORY}/compare/v1.1.0...v1.2.0)`);
  });

  it("givenReleases_whenFetched_thenNewestComesFirstAsHtml", async () => {
    const changelog = await fetchChangelog(
      answering([
        release({ tag_name: "v1.1.0", published_at: "2026-10-01T10:00:00Z" }),
        release({ tag_name: "v1.3.0-beta.1", prerelease: true }),
        release({ tag_name: "v1.2.0" }),
      ]),
    );

    expect(changelog.error).toBeUndefined();
    expect(changelog.entries.map((entry) => entry.version)).toEqual(["v1.2.0", "v1.1.0"]);
    expect(changelog.entries[0]?.html).toContain("<h3>New features</h3>");
  });

  it("givenFetchFailure_whenFetchingReleases_thenItReturnsNoEntries", async () => {
    const offline: Fetch = () => Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com"));

    expect(await fetchChangelog(offline)).toEqual({ entries: [], error: "getaddrinfo ENOTFOUND api.github.com" });
    expect(await fetchChangelog(answering({}, 403))).toEqual({ entries: [], error: "GitHub answered 403 Forbidden" });
  });

  it("givenToken_whenFetchingReleases_thenItIsSentAsBearer", async () => {
    let headers: Record<string, string> = {};
    const capture: Fetch = (_url, init) => {
      headers = init.headers;
      return answering([])(_url, init);
    };

    await fetchChangelog(capture, "secret");

    expect(headers.Authorization).toBe("Bearer secret");
  });
});
