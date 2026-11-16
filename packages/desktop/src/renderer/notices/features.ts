import type { FeatureNotice } from "@table-craft/desktop/renderer/model/notices.js";

/**
 * Features the bell announces once to people updating from a release without them (plan 145
 * ruling 15). The pull request that ships a user-visible feature adds its entry; an entry leaves
 * two releases later (`RELEASING.md`).
 */
export const FEATURE_NOTICES: readonly FeatureNotice[] = [
  {
    id: "agent-approval-formatted",
    title: "Approvals show the agent's statement formatted",
    body: "When an agent asks to run a statement, the approval now lays it out with your Reformat Code settings and colours it like the console. Turn Format off to read it exactly as the agent sent it; Allow always runs it as sent.",
  },
  {
    id: "agent-catalog-search",
    title: "Agents find tables and columns by name",
    body: "An agent can now search every schema you show it for tables, views and columns by name in one call, instead of listing each schema and guessing. It reads names only, so it never asks for approval, and hidden schemas stay hidden.",
  },
];
