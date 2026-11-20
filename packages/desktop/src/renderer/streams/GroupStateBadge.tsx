import { groupStateTone, type GroupStateTone } from "@table-craft/desktop/renderer/model/streamTree.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const TONE_CLASS: Readonly<Record<GroupStateTone, string>> = {
  neutral: "bg-raised text-ink",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
};

/** A consumer group's state as a badge (audit m5): Empty calm unless lagging, a rebalance warns, Dead is an error. */
export function GroupStateBadge({ state, lagging }: { readonly state: string; readonly lagging: boolean }) {
  const tone = groupStateTone(state, lagging);
  return (
    <span data-testid="group-state" data-tone={tone} className={cn("shrink-0 rounded px-1", TONE_CLASS[tone])}>
      {state}
    </span>
  );
}
