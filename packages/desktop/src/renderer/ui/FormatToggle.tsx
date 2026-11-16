import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { PRESSED_TOGGLE } from "@table-craft/desktop/renderer/ui/pressClasses.js";
import { Tooltip } from "@table-craft/desktop/renderer/ui/Tooltip.js";

/**
 * Shows a statement laid out by the formatter or as written. A view of the statement, not a filter,
 * so it sits on the statement's own header, as the value panel's `{}` does.
 */
export function FormatToggle({
  on,
  onToggle,
  hint,
  testId,
}: {
  readonly on: boolean;
  readonly onToggle: (next: boolean) => void;
  readonly hint: string;
  readonly testId: string;
}) {
  return (
    <Tooltip label={hint} side="bottom">
      <button
        type="button"
        aria-pressed={on}
        data-testid={testId}
        className={cn("ml-auto h-segment shrink-0 rounded px-cell text-ink hover:bg-hover", PRESSED_TOGGLE)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onToggle(!on)}
      >
        Format
      </button>
    </Tooltip>
  );
}
