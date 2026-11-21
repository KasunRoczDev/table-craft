import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { EDITOR_THEME } from "@table-craft/desktop/renderer/console/editorTheme.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/**
 * An editable value in a dialog, highlighted as JSON: a produced message, a schema to register.
 * The editor owns its text while it is mounted; `text` reaches it again only when it changes from
 * outside, as Format JSON does.
 */
export function CodeField({
  text,
  label,
  testId,
  className,
  onChange,
}: {
  readonly text: string;
  readonly label: string;
  readonly testId?: string;
  readonly className?: string;
  readonly onChange: (text: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef({ text, onChange });
  useEffect(() => {
    latest.current = { text, onChange };
  });
  useEffect(() => {
    if (host.current === null) return;
    const created = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: latest.current.text,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          json(),
          EDITOR_THEME,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [label]);
  useEffect(() => {
    const current = view.current;
    if (current === null || current.state.doc.toString() === text) return;
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: text } });
  }, [text]);
  return (
    <div
      ref={host}
      data-testid={testId}
      className={cn(
        "min-h-24 overflow-auto rounded border border-line bg-canvas focus-within:border-accent",
        className,
      )}
    />
  );
}
