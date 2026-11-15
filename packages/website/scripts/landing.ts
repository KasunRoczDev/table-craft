import type { DatasourceTint } from "../../desktop/src/appearance/themes.js";
import { docsRoute } from "./guide.js";

/** The README's tagline, cut to stay within two lines on a phone. */
export const HERO_TITLE = "A database IDE in the spirit of DataGrip";
export const HERO_LEAD =
  "Free and open source for macOS, Windows and Linux. Connections, a database explorer, SQL consoles with schema-aware completion, a result grid, a table data editor, query history and EXPLAIN plans, with every database a plugin.";

export interface Chord {
  /** Glyphs as the shortcuts guide writes them for macOS, one keycap each. */
  keys: readonly string[];
  /** The action's name in the shortcuts guide's table. */
  action: string;
}

/** DataGrip's chords the landing page shows; each is a row of `docs/guide/shortcuts.md`. */
export const CHORDS: readonly Chord[] = [
  { keys: ["⇧", "⇧"], action: "Search Everywhere" },
  { keys: ["⇧", "⌘", "A"], action: "Find Action…" },
  { keys: ["⇧", "⌘", "L"], action: "New Console" },
  { keys: ["⌘", "↩"], action: "Run" },
  { keys: ["⇧", "⌘", "E"], action: "Explain Plan" },
  { keys: ["F4"], action: "Open Data" },
  { keys: ["⌘", "B"], action: "Go to DDL" },
  { keys: ["⌥", "⌘", "L"], action: "Reformat Code" },
];

export interface Highlight {
  title: string;
  text: string;
  href: string;
  /** A GIF in `docs/media/`. */
  media?: string;
}

/** The README's Highlights, in the words a visitor scans first; the ones with media get a row of their own. */
export const HIGHLIGHTS: readonly Highlight[] = [
  {
    title: "Completion that knows your schema",
    text: "Tables after FROM, whole join conditions after JOIN, and the columns of an alias after o. — from the catalog of the data source you are on.",
    href: docsRoute("completion"),
    media: "completion.gif",
  },
  {
    title: "Large results stay responsive",
    text: "Rows stay in the engine process and the grid reads windows of them, so a million-row result does not freeze the window. Sorting, copying and exporting happen there too.",
    href: docsRoute("data", "#result-grid"),
    media: "grid.gif",
  },
  {
    title: "A table editor that shows its SQL",
    text: "Edit cells, add and delete rows, preview the statements, and submit them in one transaction.",
    href: docsRoute("data", "#table-data-editor"),
    media: "table-editor.gif",
  },
  {
    title: "Explain Plan as a tree",
    text: "Estimated and actual rows, costs and timings, with each node's share drawn in its cell. Explain Analyse asks before it runs a write.",
    href: docsRoute("console", "#explain"),
    media: "explain.gif",
  },
  {
    title: "An ER diagram that guesses keys",
    text: "A schema's tables and keys, with the customer_id columns a database never declared drawn dashed. Hide a wrong guess, add a missed one.",
    href: docsRoute("explorer", "#er-diagram"),
    media: "diagram.gif",
  },
  {
    title: "An MCP server for AI agents",
    text: "Claude Code, OpenCode or Cursor list schemas and run queries. Each data source starts off, and writes wait for your approval.",
    href: docsRoute("agents"),
    media: "agents-approval.gif",
  },
  {
    title: "Import your connections",
    text: "From DataGrip, TablePro, MySQL Workbench or Beekeeper Studio, with SSH tunnels, folders and colours.",
    href: docsRoute("connections", "#import-from-datagrip-tablepro-mysql-workbench-or-beekeeper-studio"),
  },
  {
    title: "Query history and a Services tree",
    text: "Every statement you ran, per data source, with its outcome, row count and duration.",
    href: docsRoute("monitoring", "#query-history-and-services"),
  },
  {
    title: "Themes, fonts and density",
    text: "Dark, Light, High contrast, 43 ported themes such as Gruvbox, Nord and Solarized, or your own theme file.",
    href: docsRoute("themes"),
  },
  {
    title: "Redis, standalone and Cluster",
    text: "A key tree that scans instead of blocking, typed key tabs with guarded edits and a redis-cli console.",
    href: docsRoute("redis"),
  },
  {
    title: "etcd, from keys to cluster",
    text: "Guarded key editing with history and merge, leases, live Watch, members, users and roles.",
    href: docsRoute("etcd"),
  },
  {
    title: "Plugins for any database",
    text: "Every database is a plugin, loaded the same way yours would be. Write one against a versioned API and a contract suite.",
    href: docsRoute("writing-plugins"),
  },
];

export interface Database {
  name: string;
  tint: DatasourceTint;
  builtIn: boolean;
}

/** The README's Supported databases table: in the box, or downloaded the first time you add one. */
export const DATABASES: readonly Database[] = [
  { name: "SQLite", tint: "blue", builtIn: true },
  { name: "MySQL, MariaDB, TiDB", tint: "orange", builtIn: true },
  { name: "PostgreSQL", tint: "blue", builtIn: false },
  { name: "SQL Server, Azure SQL", tint: "red", builtIn: false },
  { name: "Oracle", tint: "red", builtIn: false },
  { name: "DuckDB", tint: "yellow", builtIn: false },
  { name: "Redis", tint: "red", builtIn: false },
  { name: "etcd", tint: "green", builtIn: false },
];
