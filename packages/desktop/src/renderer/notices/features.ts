import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "open-sql-from-os",
    title: "Open .sql files from Finder, Explorer and file managers",
    body: "TableCraft now appears under Open With for .sql files, and opens a file you double-click or name on the command line as a file console. It never takes over as the default app for .sql; choose it yourself if you want it there.",
  },
  {
    id: "apache-kafka",
    title: "Apache Kafka data sources",
    body: "Add an Apache Kafka data source to browse topics, read and produce messages, follow a topic live, check consumer group lag, reset offsets and use a Schema Registry. Reading never joins a consumer group. TableCraft downloads the plugin the first time you pick Apache Kafka.",
  },
  {
    id: "manage-shown-topics",
    title: "Choose which Kafka topics the tree shows",
    body: "Right-click a Kafka data source or one of its topics and pick Manage Shown Topics… to list only the topics you work with. The data source row then reads how many of them are shown, and ticking All topics brings every topic back.",
  },
];
