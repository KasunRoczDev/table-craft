import { axisLabels, rulerPercent, type LagScale } from "@table-craft/desktop/renderer/model/groupLag.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

const FULL = 100;

/**
 * Messages behind the head on one scale for every partition of a table (plan 164 design): the
 * lag as a bar ending at the head, in `--tc-warning` when hot, and the reset's landing as a marker.
 */
export function LagRuler({
  lag,
  scale,
  hot,
  target,
}: {
  readonly lag: bigint | null;
  readonly scale: LagScale;
  readonly hot: boolean;
  /** The lag after a previewed reset; absent outside the Reset Offsets preview. */
  readonly target?: bigint | null;
}) {
  const width = rulerPercent(lag, scale);
  const after = target === undefined || target === null ? null : rulerPercent(target, scale);
  return (
    <div data-testid="lag-ruler" data-hot={hot || undefined} aria-hidden className="relative h-3.5 min-w-40">
      <span className="absolute inset-x-0 top-1.5 h-0.5 bg-line" />
      <span
        className={cn("absolute top-1 h-1.5", hot ? "bg-warning" : "bg-ink-muted")}
        style={{ left: `${String(FULL - width)}%`, width: `${String(width)}%` }}
      />
      <span className="absolute top-0 right-0 h-3.5 w-0.5 bg-ink" />
      {after === null ? null : (
        <span
          data-testid="lag-ruler-target"
          className="absolute top-0 -ml-1 h-3.5 w-2 rounded-xs border-2 border-accent bg-canvas"
          style={{ left: `${String(FULL - after)}%` }}
        />
      )}
    </div>
  );
}

/** The ruler column's header: the scale's far end, its half and the head. */
export function LagAxis({ scale }: { readonly scale: LagScale }) {
  const [far, half, head] = axisLabels(scale);
  return (
    <div className="flex min-w-40 justify-between font-grid text-ink-muted tabular-nums">
      <span>{far}</span>
      <span>{half}</span>
      <span>{head}</span>
    </div>
  );
}
