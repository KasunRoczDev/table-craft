import type { DatasourceTint } from "../../desktop/src/appearance/themes.js";
import type { WebsiteClip } from "./clips.js";
import { docsRoute } from "./guide.js";

/** The README's tagline, cut to stay within two lines on a phone. */
export const HERO_TITLE = "A database IDE in the spirit of DataGrip";
export const HERO_LEAD =
  "Free and open source for macOS, Windows and Linux. Connections, a database explorer, SQL consoles with schema-aware completion, a result grid, a table data editor, query history and EXPLAIN plans, with every database a plugin.";

export interface AgentAccess {
  /** The level's name as the Data Sources dialog and `docs/guide/agents.md` write it. */
  level: string;
  text: string;
}

/** The access levels an agent gets per data source, from least to most, as `docs/guide/agents.md` orders them. */
export const AGENT_ACCESS: readonly AgentAccess[] = [
  { level: "Off", text: "Where every data source starts. Agents do not see it." },
  { level: "Ask before reads", text: "Agents browse schemas and tables; every query that returns rows waits for you." },
  { level: "Read only", text: "SELECTs, DDL, explain and format, in a read-only session. Anything else is refused." },
  {
    level: "Ask before writes",
    text: "One change at a time, run only after you read it and its reason and choose Allow once.",
  },
];

export interface Highlight {
  title: string;
  /** A short name for the landing page's tab, on highlights with media. */
  tab?: string;
  text: string;
  href: string;
  /** A GIF in `docs/media/`. */
  media?: string;
  /** The website's own recording of the same scene, played instead of the GIF. */
  clip?: WebsiteClip;
}

/** The README's Highlights, in the words a visitor scans first; the ones with media get a row of their own. */
export const HIGHLIGHTS: readonly Highlight[] = [
  {
    title: "Completion that knows your schema",
    tab: "Completion",
    text: "Tables after FROM, whole join conditions after JOIN, and the columns of an alias after o. — from the catalog of the data source you are on.",
    href: docsRoute("completion"),
    media: "completion.gif",
    clip: "completion",
  },
  {
    title: "Large results stay responsive",
    tab: "Results",
    text: "Rows stay in the engine process and the grid reads windows of them, so a million-row result does not freeze the window. Sorting, copying and exporting happen there too.",
    href: docsRoute("data", "#result-grid"),
    media: "grid.gif",
    clip: "grid",
  },
  {
    title: "A table editor that shows its SQL",
    tab: "Table editor",
    text: "Edit cells, add and delete rows, preview the statements, and submit them in one transaction.",
    href: docsRoute("data", "#table-data-editor"),
    media: "table-editor.gif",
    clip: "table-editor",
  },
  {
    title: "Explain Plan as a tree",
    tab: "Explain",
    text: "Estimated and actual rows, costs and timings, with each node's share drawn in its cell. Explain Analyse asks before it runs a write.",
    href: docsRoute("console", "#explain"),
    media: "explain.gif",
    clip: "explain",
  },
  {
    title: "An ER diagram that guesses keys",
    tab: "ER diagram",
    text: "A schema's tables and keys, with the customer_id columns a database never declared drawn dashed. Hide a wrong guess, add a missed one.",
    href: docsRoute("explorer", "#er-diagram"),
    media: "diagram.gif",
    clip: "diagram",
  },
  {
    title: "An MCP server for AI agents",
    tab: "Agents",
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
    title: "Apache Kafka without a consumer group",
    text: "Reads that never join a group, Avro and Protobuf through the Schema Registry, consumer lag and offset resets.",
    href: docsRoute("kafka"),
  },
  {
    title: "Elasticsearch and OpenSearch, time first",
    text: "Index tabs open on the last 15 minutes with a histogram, Lucene or query DSL, mappings and analyzers.",
    href: docsRoute("elasticsearch"),
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
  { name: "Apache Kafka", tint: "violet", builtIn: false },
  { name: "Elasticsearch, OpenSearch", tint: "yellow", builtIn: false },
];
