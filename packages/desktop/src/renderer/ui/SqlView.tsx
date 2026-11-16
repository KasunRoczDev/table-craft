import { sql } from "@codemirror/lang-sql";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { dialectOf } from "@table-craft/desktop/renderer/console/Editor.js";
import { EDITOR_THEME } from "@table-craft/desktop/renderer/console/editorTheme.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

function sqlLanguage(highlight: string | null | undefined): Extension {
  return sql({ dialect: dialectOf(highlight), upperCaseKeywords: true });
}

/**
 * SQL shown read-only and highlighted in the datasource's dialect: a DDL tab's definition, the SQL
 * Generator's preview (plan 010), an agent's statement waiting for approval. Text can still be
 * selected and copied. `language`, when given, replaces the dialect named by `highlight`, so a
 * command datasource can bring its own; keep it stable across renders, as a change reconfigures.
 */
export function SqlView({
  text,
  highlight,
  language,
  wrap = false,
  label,
  testId,
  className,
}: {
  readonly text: string;
  readonly highlight?: string | null;
  readonly language?: Extension;
  readonly wrap?: boolean;
  readonly label: string;
  readonly testId?: string;
  readonly className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const dialect = useRef(new Compartment());
  const latest = useRef({ text, highlight, language });
  useEffect(() => {
    latest.current = { text, highlight, language };
  });
  useEffect(() => {
    if (host.current === null) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.text,
        extensions: [
          lineNumbers(),
          dialect.current.of(latest.current.language ?? sqlLanguage(latest.current.highlight)),
          EDITOR_THEME,
          EditorState.readOnly.of(true),
          EditorView.contentAttributes.of({ "aria-label": label }),
          wrap ? EditorView.lineWrapping : [],
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [label, wrap]);
  useEffect(() => {
    view.current?.dispatch({ effects: dialect.current.reconfigure(language ?? sqlLanguage(highlight)) });
  }, [highlight, language]);
  useEffect(() => {
    const current = view.current;
    if (current === null || current.state.doc.toString() === text) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } });
  }, [text]);
  return <div ref={host} data-testid={testId} className={cn("min-h-0 overflow-hidden", className)} />;
}
