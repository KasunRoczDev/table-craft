export const SITE_TITLE = "TableCraft";
export const SITE_TAGLINE = "A desktop database IDE in the spirit of JetBrains DataGrip";
export const SITE_DESCRIPTION =
  "Connections, a database explorer, SQL consoles with schema-aware completion, a result grid, a table data editor, DDL and SQL generation, query history and EXPLAIN plans.";

export const REPOSITORY_SLUG = "tranphucbol/table-craft";
export const REPOSITORY_URL = `https://github.com/${REPOSITORY_SLUG}`;
export const REPOSITORY_BRANCH = "main";
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const REPOSITORY_API_URL = `https://api.github.com/repos/${REPOSITORY_SLUG}`;
export const RELEASES_API_URL = `${REPOSITORY_API_URL}/releases`;
export const ISSUES_URL = `${REPOSITORY_URL}/issues/new`;
export const LATEST_DOWNLOAD_URL = `${RELEASES_URL}/latest/download`;

export const DOCS_ROUTE = "/docs/";
export const DOWNLOAD_ROUTE = "/download/";
export const CHANGELOG_ROUTE = "/changelog/";
export const MEDIA_ROUTE = "/media/";

/** The domain GitHub Pages serves the site on; its DNS and the Pages setting live outside the repository (RELEASING.md). */
export const SITE_URL = "https://tablecraft1.dev";

export interface MediaSize {
  width: number;
  height: number;
}

export type Platform = "macos" | "windows" | "linux";

export interface Download {
  platform: Platform;
  label: string;
  file: string;
  url: string;
}

function download(platform: Platform, label: string, file: string): Download {
  return { platform, label, file, url: `${LATEST_DOWNLOAD_URL}/${file}` };
}

/** The unversioned asset names CI copies onto every release (`ci.yml`, the `release` job). */
export const DOWNLOADS: readonly Download[] = [
  download("macos", "macOS (Apple silicon)", "TableCraft-arm64.dmg"),
  download("macos", "macOS (Intel)", "TableCraft-x64.dmg"),
  download("windows", "Windows x64", "TableCraft-x64.exe"),
  download("linux", "Linux x64", "TableCraft-x86_64.AppImage"),
];

export const PLATFORM_NAMES: Readonly<Record<Platform, string>> = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
};

/** A path in the repository as GitHub shows it on the default branch. */
export function repositoryFileUrl(path: string): string {
  return `${REPOSITORY_URL}/blob/${REPOSITORY_BRANCH}/${path}`;
}

export function repositoryEditUrl(path: string): string {
  return `${REPOSITORY_URL}/edit/${REPOSITORY_BRANCH}/${path}`;
}
