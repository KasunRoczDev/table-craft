# 167: Approvals show the statement formatted

Status: Proposed.

## Decision

The approval dialog shows an agent's statement read-only in the console's editor, highlighted in the
datasource's language, and, when the plugin speaks SQL, laid out by its formatter with the user's
Reformat Code settings (decision 149).

- **Formatted by default.** A **Format** toggle at the right of the SQL | Plan row shows the
  statement as the agent sent it. The choice holds for every request until the app quits
  (`useMcp.approvalFormatted`, action Toggle Formatted Agent Request, `mcp.formatApproval`); it is
  not a setting.
- **Display only.** Allow, Allow for the session, Open in Console, the kind badge, the history and
  the log all keep the statement as sent. Formatting asks the datasource's language engine
  (`sql.format`), never a connection, and the request keeps waiting while it works.
- **As sent while it cannot.** Until the formatter answers, and when it fails, the dialog shows the
  statement as sent; a failure adds a muted line saying why.
- **Language from capabilities.** The highlighter comes from the plugin the way the console picks
  its own: a SQL dialect for `sql`, the command highlighter for `commands`. A command datasource has
  no formatter, so it has no toggle. A key request keeps its Key row.
- **Wrapped and bounded.** Lines wrap, and the editor scrolls inside a box as tall as the plan view.

## Rationale

Agents send one-line statements. A join with a few conditions, or a `cluster_statements_summary`
query with expressions in its select list, became a wall of text the user had to read inside a
60-second countdown, without the colours they read SQL by everywhere else in TableCraft. The
formatter already exists, in the plugin, behind Reformat Code and the Query History preview.

Formatting what runs was rejected: the user approves the exact statement, and a formatter that
changed a literal or a comment would change what they approved. Formatting off by default, as Query
History has it, was rejected because the dialog's whole job is to be read quickly; History lists
statements the user mostly wrote. A setting was rejected as too small a choice to persist; the
toggle remembers it for the run.

## Consequences

The first request on a datasource starts its language engine, which may take a moment; the
statement shows as sent meanwhile. A formatted statement is longer, so a large one scrolls sooner.
The SQL view is now a CodeMirror editor, so tests read it by line (`linesOf`) rather than by
`textContent`, which would include the line numbers.
