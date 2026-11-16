import { useEffect, useState } from "react";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";
import type { StatementFormatter } from "@table-craft/desktop/renderer/state/statementFormat.js";

export interface Formatted {
  readonly sql: string;
  readonly text: string | null;
  readonly error: string | null;
}

/** The statement through `format` while `on`; null while it is off, absent or still working. */
export function useFormatted(sql: string, format: StatementFormatter | undefined, on: boolean): Formatted | null {
  const [formatted, setFormatted] = useState<Formatted | null>(null);
  useEffect(() => {
    let current = true;
    if (on && format !== undefined && sql !== "") {
      format(sql).then(
        (text) => {
          if (current) setFormatted({ sql, text, error: null });
        },
        (cause: unknown) => {
          if (current) setFormatted({ sql, text: null, error: toError(cause).message });
        },
      );
    }
    return () => {
      current = false;
    };
  }, [sql, format, on]);
  return on && formatted?.sql === sql ? formatted : null;
}
