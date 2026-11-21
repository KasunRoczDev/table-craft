import { localZoneSuffix, utcInstantText } from "@table-craft/desktop/renderer/model/timeZone.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/**
 * Beside a timestamp field (audit M3): the zone a typed time is read in, `Local (UTC+07:00)`, and
 * the instant it resolves to, `= 2026-11-21 02:00:00 UTC`, so a reader never guesses which clock.
 * `truncate` lets a strip with too little room cut it, its whole text in the tooltip.
 */
export function TimestampHint({
  typed,
  className,
  truncate = false,
}: {
  readonly typed: string;
  readonly className?: string;
  readonly truncate?: boolean;
}) {
  const instant = utcInstantText(typed);
  const text = `${localZoneSuffix()}${instant === null ? "" : ` ${instant}`}`;
  return (
    <span
      data-testid="timestamp-hint"
      title={truncate ? text : undefined}
      className={cn(truncate ? "min-w-0 truncate" : "shrink-0 whitespace-nowrap", "text-ink-muted", className)}
    >
      {text}
    </span>
  );
}
