import * as Dialog from "@radix-ui/react-dialog";
import { isProduction, type DialogDatasource } from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TINT_SWATCH } from "@table-craft/desktop/renderer/ui/tint.js";

export const PRODUCTION_TEXT = "Production data source";

/**
 * A stream dialog's title, naming the data source it writes to with its colour (audit M8), and on
 * a production-coloured one a warning strip under it.
 */
export function StreamDialogTitle({
  text,
  datasource,
}: {
  readonly text: string;
  readonly datasource: DialogDatasource;
}) {
  return (
    <>
      <Dialog.Title data-testid="stream-dialog-title" className="flex min-w-0 items-center gap-cell font-semibold">
        <span className="truncate">
          {text} on {datasource.name}
        </span>
        {datasource.color === null ? null : (
          <span aria-hidden className={cn("size-2.5 shrink-0 rounded", TINT_SWATCH[datasource.color])} />
        )}
      </Dialog.Title>
      {isProduction(datasource) ? (
        <p
          role="note"
          data-testid="production-strip"
          className="flex items-center gap-cell rounded bg-danger/15 px-cell py-1 font-semibold text-danger"
        >
          <WarningIcon aria-hidden weight="fill" className="size-icon shrink-0" />
          {PRODUCTION_TEXT}
        </p>
      ) : null}
    </>
  );
}
