// Writes everything the site reads from the rest of the repository, before `astro dev` and
// `astro build` (plan 161, decision 165). Every output is git-ignored.
//   bun run --cwd packages/website sync
// TABLE_CRAFT_WEBSITE_OFFLINE=1 skips the GitHub releases fetch; GITHUB_TOKEN raises its rate limit.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { DARK_COLORS, LIGHT_COLORS } from "../../desktop/src/appearance/themes.js";
import { docsOverview, GUIDE_DIRECTORY, readDocsIndex, toStarlightPage } from "./guide.js";
import { fetchChangelog, type Changelog } from "./releases.js";
import { tokensCss } from "./tokens.js";
import { DOCS_ROUTE, type MediaSize } from "./site.js";

const WEBSITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = join(WEBSITE, "..", "..");
const DOCS_OUTPUT = join(WEBSITE, "src", "content", "docs", "docs");
const GENERATED = join(WEBSITE, "src", "generated");
const PUBLIC_MEDIA = join(WEBSITE, "public", "media");
const PUBLIC_ICONS = join(WEBSITE, "public", "icons");
const MEDIA_SOURCE = join(REPOSITORY, "docs", "media");
const ICON_SOURCE = join(REPOSITORY, "packages", "desktop", "build", "icon.png");
/** The favicon and the Apple touch icon. */
const ICON_SIZES = [32, 180] as const;
/** Twice the largest size a page draws the logo at, the landing hero's 128px. */
const LOGO_SIZE = 256;

/** Starlight warns at build time without a `404` entry in the docs collection. */
const NOT_FOUND_PAGE = `---
title: "Page not found"
template: splash
editUrl: false
pagefind: false
---

That page is not here. Try the search above or the [documentation](${DOCS_ROUTE}).
`;

class SyncError extends Error {
  override name = "SyncError";
}

async function syncGuide(): Promise<number> {
  const readme = await readFile(join(REPOSITORY, "README.md"), "utf8");
  const groups = readDocsIndex(readme);
  const indexed = new Set(groups.flatMap((group) => group.pages.map((page) => page.slug)));
  const pages = (await readdir(join(REPOSITORY, GUIDE_DIRECTORY))).filter((file) => file.endsWith(".md"));
  const missing = pages.map((file) => file.slice(0, -".md".length)).filter((slug) => !indexed.has(slug));
  if (missing.length > 0) {
    throw new SyncError(`List ${missing.join(", ")} in README.md's Documentation index; the sidebar is built from it.`);
  }
  await mkdir(DOCS_OUTPUT, { recursive: true });
  for (const group of groups) {
    for (const entry of group.pages) {
      const markdown = await readFile(join(REPOSITORY, GUIDE_DIRECTORY, `${entry.slug}.md`), "utf8");
      await writeFile(join(DOCS_OUTPUT, `${entry.slug}.md`), toStarlightPage(markdown, entry));
    }
  }
  await writeFile(join(DOCS_OUTPUT, "index.mdx"), docsOverview(groups));
  await writeFile(join(DOCS_OUTPUT, "..", "404.md"), NOT_FOUND_PAGE);
  return indexed.size;
}

/** Copies the GIFs and records their sizes, so pages reserve the right box before a GIF loads. */
async function syncMedia(): Promise<number> {
  await mkdir(PUBLIC_MEDIA, { recursive: true });
  const files = (await readdir(MEDIA_SOURCE)).filter((file) => file.endsWith(".gif")).sort();
  const sizes: Record<string, MediaSize> = {};
  for (const file of files) {
    await copyFile(join(MEDIA_SOURCE, file), join(PUBLIC_MEDIA, file));
    const { width, height } = await sharp(join(MEDIA_SOURCE, file)).metadata();
    sizes[file] = { width, height };
  }
  await writeFile(join(GENERATED, "media.json"), `${JSON.stringify(sizes, null, 2)}\n`);
  return files.length;
}

async function syncIcons(): Promise<void> {
  await mkdir(PUBLIC_ICONS, { recursive: true });
  await Promise.all([
    ...ICON_SIZES.map((size) =>
      sharp(ICON_SOURCE)
        .resize(size, size)
        .png()
        .toFile(join(PUBLIC_ICONS, `icon-${size}.png`)),
    ),
    sharp(ICON_SOURCE).resize(LOGO_SIZE, LOGO_SIZE).png().toFile(join(GENERATED, "logo.png")),
  ]);
}

async function syncChangelog(): Promise<Changelog> {
  const changelog: Changelog =
    process.env.TABLE_CRAFT_WEBSITE_OFFLINE === "1"
      ? { entries: [], error: "TABLE_CRAFT_WEBSITE_OFFLINE=1" }
      : await fetchChangelog(fetch, process.env.GITHUB_TOKEN);
  await writeFile(join(GENERATED, "changelog.json"), `${JSON.stringify(changelog, null, 2)}\n`);
  return changelog;
}

async function main(): Promise<void> {
  await Promise.all(
    [join(WEBSITE, "src", "content", "docs"), GENERATED, PUBLIC_MEDIA, PUBLIC_ICONS].map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  await mkdir(GENERATED, { recursive: true });
  await writeFile(join(GENERATED, "tokens.css"), tokensCss(DARK_COLORS, LIGHT_COLORS));
  const [pages, media, , changelog] = await Promise.all([syncGuide(), syncMedia(), syncIcons(), syncChangelog()]);
  const releases = changelog.error
    ? `no releases (${changelog.error}); the changelog links to GitHub`
    : `${changelog.entries.length} releases`;
  console.log(`website: ${pages} guide pages, ${media} GIFs, ${releases}`);
}

await main();
