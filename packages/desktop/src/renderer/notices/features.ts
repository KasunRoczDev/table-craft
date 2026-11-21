import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "manage-shown-topics",
    title: "Choose which Kafka topics the tree shows",
    body: "Right-click a Kafka data source or one of its topics and pick Manage Shown Topics… to list only the topics you work with. The data source row then reads how many of them are shown, and ticking All topics brings every topic back.",
  },
  {
    id: "elasticsearch",
    title: "Elasticsearch and OpenSearch data sources",
    body: "Add an Elasticsearch or OpenSearch data source to browse indices, aliases and rollover families, search documents with Lucene or Query DSL over a time range, read a mapping, see how an analyzer splits your words and run Dev Tools requests, SQL and PPL in a console. TableCraft downloads the plugin the first time you pick Elasticsearch.",
  },
  {
    id: "elasticsearch-large-clusters",
    title: "Filter large Elasticsearch index trees",
    body: "A cluster with more than 200 indices gets a filter above its index tree that matches across families, with * as a wildcard. Monthly indices such as logs-2026-10-0001 group into one family, and the first page of hits keeps nothing open on the server.",
  },
];
