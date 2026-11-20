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
    id: "open-sql-from-os",
    title: "Open .sql files from Finder, Explorer and file managers",
    body: "TableCraft now appears under Open With for .sql files, and opens a file you double-click or name on the command line as a file console. It never takes over as the default app for .sql; choose it yourself if you want it there.",
  },
];
