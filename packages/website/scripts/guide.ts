import { posix } from "node:path";
import {
  DOCS_ROUTE,
  MEDIA_ROUTE,
  REPOSITORY_URL,
  REPOSITORY_BRANCH,
  repositoryEditUrl,
  repositoryFileUrl,
} from "./site.js";

export const GUIDE_DIRECTORY = "docs/guide";
const DOCUMENTATION_HEADING = "## Documentation";
const GROUP_LINE = /^\*\*(.+)\*\*$/;
const INDEX_ENTRY_LINE = /^- \[([^\]]+)\]\(docs\/guide\/([a-z0-9-]+)\.md\):\s*(.*)$/;
const CONTINUATION_LINE = /^ {2}\S/;
const FENCE = /^\s*(```|~~~)/;
const INLINE_CODE = /(`+[^`]*?`+)/;
const MARKDOWN_LINK = /(\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g;
const SIBLING_PAGE = /^([a-z0-9-]+)\.md(#.*)?$/;
const MEDIA_PREFIX = "../media/";
const EXTERNAL_TARGET = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;

export interface DocsIndexEntry {
  slug: string;
  label: string;
  description: string;
}

export interface DocsGroup {
  label: string;
  pages: DocsIndexEntry[];
}

export class DocsIndexError extends Error {
  override name = "DocsIndexError";
}

function documentationSection(readme: string): string[] {
  const lines = readme.split("\n");
  const start = lines.indexOf(DOCUMENTATION_HEADING);
  if (start < 0) {
    throw new DocsIndexError(
      `README.md has no "${DOCUMENTATION_HEADING}" section; restore it, the sidebar is built from it.`,
    );
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? lines.length : end);
}

/** Plain text for frontmatter and card attributes: drops Markdown code marks and link syntax. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The README's Documentation index: its bold group lines and the guide pages under each, in order. */
export function readDocsIndex(readme: string): DocsGroup[] {
  const groups: DocsGroup[] = [];
  let entry: DocsIndexEntry | undefined;
  for (const line of documentationSection(readme)) {
    const group = GROUP_LINE.exec(line);
    if (group) {
      groups.push({ label: group[1] ?? "", pages: [] });
      entry = undefined;
      continue;
    }
    const match = INDEX_ENTRY_LINE.exec(line);
    if (match) {
      const current = groups.at(-1);
      if (!current) {
        throw new DocsIndexError(`"${line}" in README.md comes before any **group** line; put it under one.`);
      }
      entry = { label: match[1] ?? "", slug: match[2] ?? "", description: match[3] ?? "" };
      current.pages.push(entry);
      continue;
    }
    if (entry && CONTINUATION_LINE.test(line)) {
      entry.description = `${entry.description} ${line.trim()}`;
      continue;
    }
    entry = undefined;
  }
  for (const group of groups) {
    for (const page of group.pages) page.description = sentence(plainText(page.description));
  }
  return groups.filter((group) => group.pages.length > 0);
}

export function docsRoute(slug: string, anchor = ""): string {
  return `${DOCS_ROUTE}${slug}/${anchor}`;
}

/**
 * Where a link in `docs/guide/<page>.md` points on the site: guide pages and media stay on the
 * site, anything else in the repository opens on GitHub, as the README's links do.
 */
export function rewriteLink(target: string, page: string): string {
  if (EXTERNAL_TARGET.test(target)) return target;
  if (target.startsWith(MEDIA_PREFIX)) return `${MEDIA_ROUTE}${target.slice(MEDIA_PREFIX.length)}`;
  const sibling = SIBLING_PAGE.exec(target);
  if (sibling) return docsRoute(sibling[1] ?? page, sibling[2] ?? "");
  const [path = "", anchor] = target.split("#", 2);
  const resolved = posix.normalize(posix.join(GUIDE_DIRECTORY, path)).replace(/\/$/, "");
  if (resolved.startsWith("..")) return target;
  const suffix = anchor === undefined ? "" : `#${anchor}`;
  if (path.endsWith("/")) return `${REPOSITORY_URL}/tree/${REPOSITORY_BRANCH}/${resolved}/${suffix}`;
  return `${repositoryFileUrl(resolved)}${suffix}`;
}

function rewriteLine(line: string, page: string): string {
  return line
    .split(INLINE_CODE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            MARKDOWN_LINK,
            (_match, open: string, target: string, close: string) => `${open}${rewriteLink(target, page)}${close}`,
          ),
    )
    .join("");
}

export function rewriteLinks(markdown: string, page: string): string {
  let fence: string | undefined;
  return markdown
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (marker && (fence === undefined || marker === fence)) {
        fence = fence === undefined ? marker : undefined;
        return line;
      }
      return fence === undefined ? rewriteLine(line, page) : line;
    })
    .join("\n");
}

export class GuidePageError extends Error {
  override name = "GuidePageError";
}

/** A guide page as a Starlight page: frontmatter from its heading and the README index, links for the site. */
export function toStarlightPage(markdown: string, entry: DocsIndexEntry): string {
  const [first = "", ...rest] = markdown.split("\n");
  if (!first.startsWith("# ")) {
    throw new GuidePageError(`${GUIDE_DIRECTORY}/${entry.slug}.md must start with its "# Title" line.`);
  }
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(plainText(first.slice(2)))}`,
    `description: ${JSON.stringify(entry.description)}`,
    `editUrl: ${JSON.stringify(repositoryEditUrl(`${GUIDE_DIRECTORY}/${entry.slug}.md`))}`,
    "---",
  ];
  const body = rewriteLinks(rest.join("\n"), entry.slug).replace(/^\n+/, "");
  return `${frontmatter.join("\n")}\n\n${body}`;
}

function attribute(value: string): string {
  return JSON.stringify(value);
}

/** The `/docs/` landing page: the README index as cards, in its groups. */
export function docsOverview(groups: readonly DocsGroup[]): string {
  const sections = groups.map((group) => {
    const cards = group.pages
      .map(
        (page) =>
          `  <LinkCard title=${attribute(page.label)} description=${attribute(page.description)} href=${attribute(docsRoute(page.slug))} />`,
      )
      .join("\n");
    return `## ${group.label}\n\n<CardGrid>\n${cards}\n</CardGrid>`;
  });
  return [
    "---",
    'title: "Documentation"',
    'description: "How to install, connect, query and extend TableCraft."',
    "editUrl: false",
    "---",
    "",
    'import { CardGrid, LinkCard } from "@astrojs/starlight/components";',
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
}
