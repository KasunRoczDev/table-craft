import * as ContextMenu from "@radix-ui/react-context-menu";
import { useState } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { TOPIC_ACTION_IDS } from "@table-craft/desktop/renderer/actions/topicActions.js";
import {
  filteredPartition,
  partitionCounts,
  STRIP_FOLD_PARTITIONS,
  stripSummary,
} from "@table-craft/desktop/renderer/model/topicRead.js";
import type { ResultTab } from "@table-craft/desktop/renderer/state/resultTab.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { LINK_BUTTON } from "@table-craft/desktop/renderer/ui/linkClasses.js";
import { MENU_CONTENT, MENU_ITEM } from "@table-craft/desktop/renderer/ui/menu.js";

const PERCENT = 100;

/**
 * The topic's partitions as one row above its messages (plan 164 design): how many loaded rows each
 * holds, as a count and a bar on one scale. A click narrows the loaded rows to that partition, and
 * again shows them all (audit m3); reading only that partition is in the cell's menu. Past
 * `STRIP_FOLD_PARTITIONS` the strip folds to one line until expanded.
 */
export function PartitionStrip({
  result,
  partitions,
  only,
}: {
  readonly result: ResultTab;
  readonly partitions: number;
  /** The partitions the shown read asked for; null for every one. */
  readonly only: readonly number[] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { counts, complete } = partitionCounts(result.columns, result.windows, result.rowCount, partitions);
  const filtered = filteredPartition(result.columns, result.search.filters);
  const most = Math.max(1, ...counts);
  if (partitions > STRIP_FOLD_PARTITIONS && !expanded)
    return (
      <div
        data-testid="partition-strip"
        data-folded=""
        className="flex h-row shrink-0 items-center gap-gap border-b border-line px-cell text-ink-muted"
      >
        <span>{stripSummary(counts)}</span>
        <button type="button" className={LINK_BUTTON} onClick={() => setExpanded(true)}>
          Show Partitions
        </button>
      </div>
    );
  return (
    <div
      role="group"
      aria-label="Rows by partition"
      data-testid="partition-strip"
      className="grid shrink-0 overflow-x-auto border-b border-line"
      style={{ gridTemplateColumns: `repeat(${String(partitions)}, minmax(4rem, 1fr))` }}
    >
      {counts.map((count, partition) => {
        const pressed = filtered === partition;
        const dimmed = (only !== null && !only.includes(partition)) || (filtered !== null && !pressed);
        return (
          <ContextMenu.Root key={partition}>
            <ContextMenu.Trigger asChild>
              <button
                type="button"
                data-testid="partition-cell"
                data-partition={partition}
                aria-pressed={pressed}
                title={`Partition ${String(partition)}: ${count.toLocaleString("en-US")}${complete ? "" : " of the loaded"} rows${pressed ? "; click to show every partition's rows" : "; click to show only this partition's rows"}`}
                className={cn(
                  "relative grid grid-cols-[auto_1fr] items-baseline gap-x-cell px-cell pt-1 pb-1.5 text-left hover:bg-hover",
                  pressed && "bg-selection after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-accent",
                  dimmed && "opacity-50",
                )}
                onClick={() => invoke(TOPIC_ACTION_IDS.filterPartition, { partition })}
              >
                <span className="text-ink-muted">p{partition}</span>
                <span className={cn("text-right font-grid tabular-nums", count === 0 && "text-ink-muted")}>
                  {count.toLocaleString("en-US")}
                  {complete ? "" : "+"}
                </span>
                <span className="relative col-span-2 mt-1 h-0.5 bg-line">
                  <span
                    className={cn("absolute inset-y-0 left-0", pressed ? "bg-accent" : "bg-ink-muted")}
                    style={{ width: `${String((count / most) * PERCENT)}%` }}
                  />
                </span>
              </button>
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content className={MENU_CONTENT}>
                <ContextMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => invoke(TOPIC_ACTION_IDS.selectPartition, { partition })}
                >
                  Read Only Partition {partition}
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu.Root>
        );
      })}
    </div>
  );
}
