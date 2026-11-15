import { marked } from "marked";
import { docsRoute, GUIDE_DIRECTORY } from "./guide.js";
import { REPOSITORY_URL, RELEASES_API_URL, repositoryFileUrl } from "./site.js";

/** The fields of GitHub's "list releases" response the changelog reads. */
export interface GitHubRelease {
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  body: string | null;
}

export interface ChangelogEntry {
  version: string;
  title: string;
  url: string;
  date: string;
  html: string;
}

export interface Changelog {
  entries: ChangelogEntry[];
  /** Why the releases could not be read; the page then points at GitHub Releases instead. */
  error?: string;
}

const RELEASES_PER_PAGE = 50;
const INSTALL_HEADING = "## Install";
const GENERATED_NOTES_MARKER = "<!-- Release notes generated";
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^(#{1,5}) /gm;
const GUIDE_LINK = new RegExp(`${escapeRegExp(repositoryFileUrl(GUIDE_DIRECTORY))}/([a-z0-9-]+)\\.md(#[^)\\s]*)?`, "g");
const PULL_URL = new RegExp(`(?<!\\()${escapeRegExp(REPOSITORY_URL)}/pull/(\\d+)`, "g");
const COMPARE_URL = new RegExp(`(?<!\\()${escapeRegExp(REPOSITORY_URL)}/compare/([\\w.-]+\\.\\.\\.[\\w.-]+)`, "g");
const MENTION = /(^|\s)@([a-z\d](?:[a-z\d-]{0,38}))\b/gi;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Every release repeats the same install table (`.github/release-notes-install.md`); the site has a download page. */
export function dropInstallBlock(body: string): string {
  const lines = body.split("\n");
  const start = lines.indexOf(INSTALL_HEADING);
  if (start < 0) return body;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## ") || line.startsWith(GENERATED_NOTES_MARKER));
  return [...lines.slice(0, start), ...(end < 0 ? [] : rest.slice(end))].join("\n");
}

export function releaseMarkdown(body: string): string {
  return dropInstallBlock(body.replace(/\r\n/g, "\n"))
    .replace(HTML_COMMENT, "")
    .replace(GUIDE_LINK, (_match, slug: string, anchor: string | undefined) => docsRoute(slug, anchor ?? ""))
    .replace(PULL_URL, (url, number: string) => `[#${number}](${url})`)
    .replace(COMPARE_URL, (url, range: string) => `[${range}](${url})`)
    .replace(MENTION, (_match, space: string, user: string) => `${space}[@${user}](https://github.com/${user})`)
    .replace(HEADING, (_match, hashes: string) => `${hashes}# `)
    .trim();
}

/** One published release as a changelog row; drafts and prereleases are not on the site. */
export function toChangelogEntry(release: GitHubRelease): ChangelogEntry | undefined {
  if (release.draft || release.prerelease || !release.published_at) return undefined;
  const title = release.name?.trim() || release.tag_name;
  return {
    version: release.tag_name,
    title,
    url: release.html_url,
    date: release.published_at,
    html: marked.parse(releaseMarkdown(release.body ?? ""), { async: false, gfm: true }),
  };
}

export type Fetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>;

/** The latest published releases, newest first; a failure leaves the changelog empty rather than failing the build. */
export async function fetchChangelog(fetchImpl: Fetch, token?: string): Promise<Changelog> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "table-craft-website",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const response = await fetchImpl(`${RELEASES_API_URL}?per_page=${RELEASES_PER_PAGE}`, { headers });
    if (!response.ok) {
      return { entries: [], error: `GitHub answered ${response.status} ${response.statusText}` };
    }
    const releases = (await response.json()) as GitHubRelease[];
    const entries = releases.map(toChangelogEntry).filter((entry) => entry !== undefined);
    entries.sort((a, b) => b.date.localeCompare(a.date));
    return { entries };
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) };
  }
}
