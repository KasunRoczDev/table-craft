import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  docsOverview,
  readDocsIndex,
  rewriteLink,
  rewriteLinks,
  toStarlightPage,
  type DocsIndexEntry,
} from "../../packages/website/scripts/guide.js";

const ROOT = join(import.meta.dirname, "..", "..");
const GUIDE = join(ROOT, "docs", "guide");
const REPOSITORY = "https://github.com/tranphucbol/table-craft";
const ENTRY: DocsIndexEntry = { slug: "console", label: "SQL console", description: "Running statements." };

function guideSlugs(): string[] {
  return readdirSync(GUIDE)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();
}

describe("the website's docs index", () => {
  it("givenReadme_whenReadingDocsIndex_thenGroupsMatchTheGuidePages", () => {
    const groups = readDocsIndex(readFileSync(join(ROOT, "README.md"), "utf8"));

    expect(groups.map((group) => group.label)).toEqual(["Using TableCraft", "Databases", "Customising", "Extending"]);
    expect(groups.flatMap((group) => group.pages.map((page) => page.slug)).sort()).toEqual(guideSlugs());
    for (const page of groups.flatMap((group) => group.pages)) {
      expect(page.description, page.slug).toMatch(/^[A-Z].*\S$/);
      expect(page.description, page.slug).not.toMatch(/[`[\]]/);
    }
  });

  it("givenWrappedIndexLine_whenReadingDocsIndex_thenDescriptionIsJoined", () => {
    const readme = [
      "## Documentation",
      "",
      "**Using TableCraft**",
      "",
      "- [Connections](docs/guide/connections.md): data sources, `SSH` tunnels and",
      "  [Keychain](docs/guide/data-and-privacy.md) secrets.",
      "- [Install](docs/guide/install.md): downloads.",
      "",
      "## License",
      "- [Ignored](docs/guide/ignored.md): after the section.",
    ].join("\n");

    expect(readDocsIndex(readme)).toEqual([
      {
        label: "Using TableCraft",
        pages: [
          { slug: "connections", label: "Connections", description: "Data sources, SSH tunnels and Keychain secrets." },
          { slug: "install", label: "Install", description: "Downloads." },
        ],
      },
    ]);
  });
});

describe("a guide page on the website", () => {
  it("givenGuidePage_whenConverted_thenTitleComesFromTheHeadingAndIsRemovedFromTheBody", () => {
    const page = toStarlightPage("# SQL `console`\n\nFirst paragraph.\n", ENTRY);

    expect(page).toBe(
      [
        "---",
        'title: "SQL console"',
        'description: "Running statements."',
        `editUrl: "${REPOSITORY}/edit/main/docs/guide/console.md"`,
        "---",
        "",
        "First paragraph.",
        "",
      ].join("\n"),
    );
  });

  it("givenPageWithoutHeading_whenConverted_thenItSaysWhatToFix", () => {
    expect(() => toStarlightPage("Intro.\n", ENTRY)).toThrow(
      'docs/guide/console.md must start with its "# Title" line.',
    );
  });

  it("givenMediaLink_whenRewritten_thenItPointsAtPublicMedia", () => {
    expect(rewriteLink("../media/console.gif", "console")).toBe("/media/console.gif");
  });

  it("givenSiblingLinkWithAnchor_whenRewritten_thenItPointsAtTheDocsRoute", () => {
    expect(rewriteLink("explorer.md#arranging-data-sources", "console")).toBe("/docs/explorer/#arranging-data-sources");
    expect(rewriteLink("explorer.md", "console")).toBe("/docs/explorer/");
    expect(rewriteLink("#updates", "install")).toBe("#updates");
  });

  it("givenLinkOutsideTheGuide_whenRewritten_thenItPointsAtGitHub", () => {
    expect(rewriteLink("../design/specification.md#explain", "console")).toBe(
      `${REPOSITORY}/blob/main/docs/design/specification.md#explain`,
    );
    expect(rewriteLink("../../CONTRIBUTING.md#set-up", "install")).toBe(
      `${REPOSITORY}/blob/main/CONTRIBUTING.md#set-up`,
    );
    expect(rewriteLink("../decisions/", "plugins")).toBe(`${REPOSITORY}/tree/main/docs/decisions/`);
    expect(rewriteLink("https://example.com/a.md", "console")).toBe("https://example.com/a.md");
  });

  it("givenFencedCode_whenConverted_thenLinksInsideAreLeftAlone", () => {
    const markdown = [
      "See [the explorer](explorer.md) and `[not](a.md)`.",
      "```md",
      "[kept](explorer.md)",
      "```",
      "After [it](data.md#result-grid).",
    ].join("\n");

    expect(rewriteLinks(markdown, "console")).toBe(
      [
        "See [the explorer](/docs/explorer/) and `[not](a.md)`.",
        "```md",
        "[kept](explorer.md)",
        "```",
        "After [it](/docs/data/#result-grid).",
      ].join("\n"),
    );
  });

  it("givenEveryGuidePage_whenConverted_thenNoRelativeMarkdownLinkIsLeft", () => {
    for (const slug of guideSlugs()) {
      const page = toStarlightPage(readFileSync(join(GUIDE, `${slug}.md`), "utf8"), { ...ENTRY, slug });

      expect(page, slug).not.toMatch(/\]\((?!https?:|\/|#)[^)]*\)/);
    }
  });

  it("givenDocsIndex_whenWritingTheOverview_thenEveryPageIsACard", () => {
    const overview = docsOverview([{ label: "Extending", pages: [{ ...ENTRY, label: 'The "console"' }] }]);

    expect(overview).toContain("## Extending");
    expect(overview).toContain(
      '<LinkCard title="The \\"console\\"" description="Running statements." href="/docs/console/" />',
    );
  });
});
