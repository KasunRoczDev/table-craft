import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "agent-rerun-approval",
    title: "An agent asks before it runs a query again",
    body: "When an agent pages past the rows TableCraft holds, the database reads every row again up to the last one asked. That page now waits for your approval, and shows in Services and Query History. Query History's preview also has a Format toggle for long statements.",
  },
  {
    id: "agent-catalog-search",
    title: "Agents find tables and columns by name",
    body: "An agent can now search every schema you show it for tables, views and columns by name in one call, instead of listing each schema and guessing. It reads names only, so it never asks for approval, and hidden schemas stay hidden.",
  },
];
