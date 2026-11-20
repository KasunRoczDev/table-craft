import { localZoneSuffix, utcInstantText } from "@table-craft/desktop/renderer/model/timeZone.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/**
 * Beside a timestamp field (audit M3): the zone a typed time is read in, `Local (UTC+07:00)`, and
 * the instant it resolves to, `= 2026-11-21 02:00:00 UTC`, so a reader never guesses which clock.
 */
export function TimestampHint({ typed, className }: { readonly typed: string; readonly className?: string }) {
  const instant = utcInstantText(typed);
  return (
    <span data-testid="timestamp-hint" className={cn("shrink-0 whitespace-nowrap text-ink-muted", className)}>
      {localZoneSuffix()}
      {instant === null ? "" : ` ${instant}`}
    </span>
  );
}
