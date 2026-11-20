import type { ReactNode } from "react";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/**
 * A topic or group tab's header (plan 164 design): its kind and name, where it lives, a line of
 * facts and, for a group, a finding; the tab's commands at the right.
 */
export function ObjectHeader({
  kind,
  name,
  badge,
  scope,
  facts,
  finding,
  actions,
  testId,
}: {
  readonly kind: string;
  readonly name: string;
  readonly badge?: ReactNode;
  readonly scope?: string;
  readonly facts: ReactNode;
  readonly finding?: ReactNode;
  readonly actions?: ReactNode;
  readonly testId: string;
}) {
  return (
    <div data-testid={testId} className="flex shrink-0 flex-col gap-0.5 px-pane-inset pt-gap pb-cell">
      <div className="flex min-w-0 items-center gap-gap">
        <h1 className="min-w-0 truncate font-grid font-semibold" title={`${kind} ${name}`}>
          <span className="sr-only">{kind} </span>
          {name}
        </h1>
        {badge}
        <span className="flex-1" />
        {scope === undefined ? null : <span className="shrink-0 truncate text-ink-muted">{scope}</span>}
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-gap">{actions}</div>}
      </div>
      <div className="truncate text-ink-muted" data-testid={`${testId}-facts`}>
        {facts}
      </div>
      {finding === undefined || finding === null ? null : <p className="mt-1 text-ink">{finding}</p>}
    </div>
  );
}

/** The views under a header, as underlined tabs; each a registry action through `onSelect`. */
export function Subtabs<V extends string>({
  label,
  views,
  value,
  onSelect,
}: {
  readonly label: string;
  readonly views: readonly { readonly value: V; readonly label: string; readonly count?: number | null }[];
  readonly value: V;
  readonly onSelect: (view: V) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex h-row-loose shrink-0 gap-0.5 border-b border-line px-1">
      {views.map((view) => (
        <button
          key={view.value}
          type="button"
          role="tab"
          data-testid={`view-${view.value}`}
          aria-selected={view.value === value}
          className={cn(
            "relative flex items-center gap-cell px-gap text-ink-muted hover:text-ink aria-selected:text-ink",
            "aria-selected:after:absolute aria-selected:after:inset-x-gap aria-selected:after:bottom-0 aria-selected:after:h-0.5 aria-selected:after:bg-accent",
          )}
          onClick={() => onSelect(view.value)}
        >
          {view.label}
          {view.count === undefined || view.count === null ? null : (
            <span className="font-grid text-ink-muted tabular-nums">{view.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
