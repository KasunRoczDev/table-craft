import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "elasticsearch-large-clusters",
    title: "Filter large Elasticsearch index trees",
    body: "A cluster with more than 200 indices gets a filter above its index tree that matches across families, with * as a wildcard. Monthly indices such as logs-2026-10-0001 group into one family, and the first page of hits keeps nothing open on the server.",
  },
  {
    id: "agent-open-index",
    title: "Agents can open an index search for you",
    body: "An AI agent connected to TableCraft can now open an Elasticsearch or OpenSearch index in your window with its query, sort and time range filled in, and change them when you ask. On a data source where agents ask before reading, it fills in the search and you run it.",
  },
  {
    id: "manage-shown-indices",
    title: "Choose which Elasticsearch indices the tree shows",
    body: "Right-click an Elasticsearch or OpenSearch data source or one of its indices and pick Manage Shown Indices… to list only the indices you work with. Ticking a family such as logs-* keeps its new daily or rollover indices and its write alias in the tree, and ticking All indices brings every index back.",
  },
];
