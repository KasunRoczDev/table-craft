import { json } from "@codemirror/lang-json";
import type {
  SearchField,
  SearchHistogram,
  SearchTargetDescription,
  SearchTimeRange,
} from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { INDEX_ACTION_IDS } from "@table-craft/desktop/renderer/actions/indexActions.js";
import { analyzedFields, droppedTokens, histogramPlot } from "@table-craft/desktop/renderer/model/indexSearch.js";
import { useIndexTabs, type IndexTab } from "@table-craft/desktop/renderer/state/indexTabs.js";
import { PLAIN_CELL, PLAIN_HEAD, PlainTable } from "@table-craft/desktop/renderer/topics/TopicViews.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";

const JSON_LANGUAGE = json();
const SECTION_TITLE = "px-pane-inset pt-gap pb-cell font-semibold";
const NO_ANALYZER = "—";
/** The Analyze field dropdown's value for the index's default analyzer; no field has an empty path. */
const DEFAULT_FIELD = "";
const STEP_KIND_LABELS = {
  charFilter: "char filter",
  tokenizer: "tokenizer",
  tokenFilter: "token filter",
  analyzer: "analyzer",
} as const;
const TOKEN_CLASS = "rounded bg-raised px-1 font-grid";

function percent(ratio: number): string {
  return `${String(ratio * 100)}%`;
}

/**
 * One bar per bucket in one hue, on a round count scale with time labels under it. A bucket the
 * range cuts is drawn faint, so a partial count does not read as a dip.
 */
export function HistogramStrip({
  histogram,
  time,
}: {
  readonly histogram: SearchHistogram;
  readonly time: SearchTimeRange | null;
}) {
  const plot = histogramPlot(histogram.buckets, time);
  const count = plot.bars.length;
  return (
    <div
      data-testid="index-histogram"
      aria-label={`Hits over ${histogram.field}, up to ${plot.top.toLocaleString("en-US")} per bar`}
      role="img"
      className="grid shrink-0 grid-cols-[1fr_auto] gap-x-cell border-b border-line px-pane-inset pt-gap text-label text-ink-muted tabular-nums"
    >
      <div className="flex h-10 items-end gap-px border-t border-b border-t-line/50 border-b-line">
        {plot.bars.map((bar) => (
          <span
            key={bar.at}
            data-partial={bar.partial}
            title={`${bar.at} · ${bar.count.toLocaleString("en-US")}${bar.partial ? " (part of the bucket is outside the range)" : ""}`}
            className="min-w-px flex-1 bg-accent/40 hover:bg-accent data-[partial=true]:bg-accent/15"
            style={{ height: percent(bar.ratio) }}
          />
        ))}
      </div>
      <span className="-translate-y-1/2 self-start leading-none">{plot.top.toLocaleString("en-US")}</span>
      <div className="relative h-row">
        {plot.ticks.map((tick) => (
          <span key={tick.index} className="absolute top-0" style={{ left: percent(tick.index / count) }}>
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function FieldRow({ field }: { readonly field: SearchField }) {
  return (
    <tr data-testid="index-field" data-name={field.path} className="border-t border-line">
      <td className={cn(PLAIN_CELL, "font-grid")}>
        {field.path}
        {field.multiOf === null ? null : (
          <span className="ml-cell font-ui text-ink-muted" title={`A multi-field of ${field.multiOf}`}>
            multi-field
          </span>
        )}
      </td>
      <td className={cn(PLAIN_CELL, "font-grid")}>{field.type}</td>
      <td className={cn(PLAIN_CELL, "font-grid text-ink-muted")}>{field.analyzer ?? NO_ANALYZER}</td>
      <td className={cn(PLAIN_CELL, field.aggregatable ? "text-ink" : "text-ink-muted")}>
        {field.aggregatable ? "Yes" : "No"}
      </td>
    </tr>
  );
}

function JsonBlock({
  text,
  label,
  testId,
}: {
  readonly text: string;
  readonly label: string;
  readonly testId: string;
}) {
  return (
    <SqlView
      text={text}
      language={JSON_LANGUAGE}
      wrap
      label={label}
      testId={testId}
      className="mx-pane-inset mb-gap rounded border border-line"
    />
  );
}

/** The target's fields as a table, then the mapping as the server returned it. */
export function MappingView({ description }: { readonly description: SearchTargetDescription }) {
  return (
    <div data-testid="index-mapping" className="flex min-h-0 flex-1 flex-col overflow-auto">
      {description.fields.length === 0 ? (
        <p className="px-pane-inset py-gap text-ink-muted">No mapped fields.</p>
      ) : (
        <PlainTable label="Fields">
          <thead className={PLAIN_HEAD}>
            <tr>
              <th className={cn(PLAIN_CELL, "text-left")}>Field</th>
              <th className={cn(PLAIN_CELL, "text-left")}>Type</th>
              <th className={cn(PLAIN_CELL, "text-left")}>Analyzer</th>
              <th className={cn(PLAIN_CELL, "text-left")}>Aggregatable</th>
            </tr>
          </thead>
          <tbody>
            {description.fields.map((field) => (
              <FieldRow key={field.path} field={field} />
            ))}
          </tbody>
        </PlainTable>
      )}
      {description.mapping === null ? null : (
        <>
          <h2 className={SECTION_TITLE}>Mapping</h2>
          <JsonBlock text={description.mapping} label="Mapping" testId="index-mapping-json" />
        </>
      )}
    </div>
  );
}

export function SettingsView({ description }: { readonly description: SearchTargetDescription }) {
  return (
    <div data-testid="index-settings" className="flex min-h-0 flex-1 flex-col overflow-auto pt-gap">
      {description.settings === null ? (
        <p className="px-pane-inset text-ink-muted">The server returned no settings for this target.</p>
      ) : (
        <JsonBlock text={description.settings} label="Settings" testId="index-settings-json" />
      )}
    </div>
  );
}

function AnalysisChain({ tab }: { readonly tab: IndexTab }) {
  if (tab.analyzeError !== null) {
    return (
      <p role="alert" data-testid="index-analyze-error" className="px-pane-inset py-gap break-words text-danger">
        {tab.analyzeError.message} <span className="text-ink-muted">{tab.analyzeError.hint}</span>
      </p>
    );
  }
  if (tab.analysis === null) {
    return (
      <p className="px-pane-inset py-gap text-ink-muted">
        {tab.analyzing ? "Analyzing…" : "Analyze text to see each step's tokens."}
      </p>
    );
  }
  const chain = droppedTokens(tab.analysis);
  return (
    <ol data-testid="index-analysis" className="flex min-h-0 flex-col overflow-auto">
      {tab.analysis.map((step, index) => (
        <li
          key={`${step.kind}-${step.name}-${String(index)}`}
          data-testid="index-analysis-step"
          data-name={step.name}
          className="flex flex-col gap-1 border-t border-line px-pane-inset py-cell"
        >
          <span>
            {step.name} <span className="text-ink-muted">{STEP_KIND_LABELS[step.kind]}</span>
          </span>
          <span className="flex flex-wrap gap-1">
            {chain[index]?.kept.map((token, at) => (
              <span key={`kept-${String(at)}`} data-testid="index-token" className={TOKEN_CLASS}>
                {token}
              </span>
            ))}
            {chain[index]?.dropped.map((token, at) => (
              <span
                key={`dropped-${String(at)}`}
                data-testid="index-token-dropped"
                title="Dropped by this step"
                className={cn(TOKEN_CLASS, "text-danger line-through")}
              >
                {token}
              </span>
            ))}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Text through the analysis chain of a field, step by step, with what each step dropped. */
export function AnalyzeView({ tabId, tab }: { readonly tabId: string; readonly tab: IndexTab }) {
  const set = (change: Parameters<ReturnType<typeof useIndexTabs.getState>["setAnalyzeDraft"]>[1]) =>
    useIndexTabs.getState().setAnalyzeDraft(tabId, change);
  const fields = tab.description === null ? [] : analyzedFields(tab.description.fields);
  const options = [
    { value: DEFAULT_FIELD, label: "Default analyzer" },
    ...fields.map((field) => ({ value: field.path, label: field.path })),
  ];
  const formId = `index-analyze-${tabId}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        id={formId}
        aria-label="Analyze"
        className="flex shrink-0 flex-wrap items-center gap-gap px-pane-inset py-cell"
        onSubmit={(event) => {
          event.preventDefault();
          void invoke(INDEX_ACTION_IDS.analyze);
        }}
      >
        <Dropdown
          variant="field"
          label="Field"
          testId="index-analyze-field"
          value={tab.analyzeDraft.field ?? DEFAULT_FIELD}
          options={options}
          onChange={(value) => set({ field: value === DEFAULT_FIELD ? null : value })}
        />
        <input
          aria-label="Text to analyze"
          data-testid="index-analyze-text"
          className="h-row min-w-0 flex-1 rounded border border-line bg-canvas px-cell font-grid text-ink outline-none placeholder:text-grid-null focus:border-accent"
          placeholder="The Quick Brown Foxes"
          spellCheck={false}
          value={tab.analyzeDraft.text}
          onChange={(event) => set({ text: event.target.value })}
        />
        <ActionButton actionId={INDEX_ACTION_IDS.analyze} primary testId="index-analyze" />
      </form>
      <AnalysisChain tab={tab} />
    </div>
  );
}
