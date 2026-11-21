import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { INDEX_ACTION_IDS } from "@table-craft/desktop/renderer/actions/indexActions.js";
import {
  SEARCH_RANGES,
  sortableFields,
  type SearchDraft,
  type SearchRangeKey,
} from "@table-craft/desktop/renderer/model/indexSearch.js";
import { useIndexTabs, type IndexTab } from "@table-craft/desktop/renderer/state/indexTabs.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { SortAscendingMark, SortDescendingMark } from "@table-craft/desktop/renderer/ui/icons.js";
import { Popover, type PopoverAnchor } from "@table-craft/desktop/renderer/ui/Popover.js";
import { POPOVER_BODY, POPOVER_FOOTER, POPOVER_HEADER } from "@table-craft/desktop/renderer/ui/popoverParts.js";
import { RunGlyph, StopGlyph } from "@table-craft/desktop/renderer/ui/runGlyphs.js";
import { Segmented } from "@table-craft/desktop/renderer/ui/Segmented.js";

const LANGUAGE_OPTIONS = [
  { value: "lucene", label: "Lucene" },
  { value: "dsl", label: "DSL" },
] as const;
const PLACEHOLDERS = {
  lucene: "status:500 AND service:checkout",
  dsl: '{ "match": { "message": "timeout" } }',
} as const;
/** The sort dropdown's value for relevance order; no field has an empty path. */
const SCORE_SORT = "";
const SCORE_LABEL = "Score";
const RANGE_OPTIONS = SEARCH_RANGES.map((range) => ({ value: range.key, label: range.label }));
const SORT_ORDER_TEXT = { asc: "Ascending", desc: "Descending" } as const;
/** Flush fields of the strip (design-system.md, Dropdowns: the flush rule), as the topic read bar's. */
const INPUT_CLASS =
  "h-row min-w-0 border border-transparent bg-transparent px-1 font-grid text-ink outline-none placeholder:text-grid-null focus:border-accent aria-invalid:border-danger";
const SEGMENT_CLASS =
  "flex h-row max-w-full items-center gap-cell overflow-hidden border-r border-b border-line px-cell whitespace-nowrap";
const BAR_BUTTON = "flex shrink-0 items-center gap-cell border-l border-line px-gap font-semibold hover:bg-hover";

function Segment({
  label,
  children,
  grow,
}: {
  readonly label?: string;
  readonly children: ReactNode;
  readonly grow?: boolean;
}) {
  return (
    <div className={cn(SEGMENT_CLASS, grow === true ? "min-w-64 grow" : "min-w-0 shrink-0")}>
      {label === undefined ? null : <span className="shrink-0 text-ink-muted">{label}</span>}
      {children}
    </div>
  );
}

/** The exact request the last search sent, to copy or to carry into a console. */
function RequestPopover({
  anchor,
  request,
  onClose,
}: {
  readonly anchor: PopoverAnchor;
  readonly request: string;
  readonly onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} label="Search request" testId="index-request-popover" focusSelf onClose={onClose}>
      <div className="flex min-h-0 max-w-full min-w-0 flex-col">
        <div className={POPOVER_HEADER}>Request</div>
        <div className={POPOVER_BODY}>
          <pre
            data-testid="index-request-text"
            className="overflow-auto font-editor text-editor whitespace-pre-wrap break-all select-text"
          >
            {request}
          </pre>
        </div>
        <div className={POPOVER_FOOTER}>
          <ActionButton actionId={INDEX_ACTION_IDS.copyRequest} testId="index-copy-request" />
          <ActionButton actionId={INDEX_ACTION_IDS.openRequestInConsole} testId="index-request-console" />
        </div>
      </div>
    </Popover>
  );
}

function RequestButton({ request }: { readonly request: string | null }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  useLayoutEffect(() => {
    if (!open || button.current === null) {
      setAnchor(null);
      return;
    }
    const { left, top, right, bottom } = button.current.getBoundingClientRect();
    setAnchor({ left, top, right, bottom });
  }, [open]);
  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="index-request"
        aria-label="Show request"
        title={request === null ? "Search first to see its request" : "Show the request this search sent"}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={request === null}
        className={cn(BAR_BUTTON, "font-editor font-normal text-ink-muted disabled:opacity-50")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((shown) => !shown)}
      >
        {"{ }"}
      </button>
      {open && anchor !== null && request !== null ? (
        <RequestPopover anchor={anchor} request={request} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

/** The documents' query bar (plan 165): the language, the query, the order, the time range and Run. */
export function SearchBar({ tabId, tab }: { readonly tabId: string; readonly tab: IndexTab }) {
  const { draft } = tab;
  const set = (change: Partial<SearchDraft>) => useIndexTabs.getState().setDraft(tabId, change);
  const fields = tab.description === null ? [] : sortableFields(tab.description.fields);
  const timeField = tab.description?.timeField ?? null;
  const searching = tab.status === "loading";
  const formId = `index-search-${tabId}`;
  const sortOptions = [
    { value: SCORE_SORT, label: SCORE_LABEL },
    ...fields.map((field) => ({ value: field.path, label: field.path })),
  ];
  const OrderIcon = draft.sortOrder === "asc" ? SortAscendingMark : SortDescendingMark;
  return (
    <div className="flex shrink-0 items-stretch overflow-hidden border-b border-line">
      <form
        id={formId}
        aria-label="Search"
        data-testid="index-search-bar"
        className="-mb-px flex min-w-0 flex-1 flex-wrap items-stretch"
        onSubmit={(event) => {
          event.preventDefault();
          if (!searching) void invoke(INDEX_ACTION_IDS.run);
        }}
      >
        <Segment>
          <Segmented
            name={`${formId}-language`}
            label="Query language"
            testId="index-language"
            options={LANGUAGE_OPTIONS}
            value={draft.language}
            onChange={(language) => set({ language })}
          />
        </Segment>
        <Segment grow>
          <input
            aria-label="Query"
            data-testid="index-query"
            className={cn(INPUT_CLASS, "flex-1")}
            placeholder={PLACEHOLDERS[draft.language]}
            spellCheck={false}
            aria-invalid={tab.queryError !== null}
            value={draft.query}
            onChange={(event) => set({ query: event.target.value })}
          />
        </Segment>
        <Segment label="Sort">
          <Dropdown
            variant="inline"
            label="Sort field"
            testId="index-sort"
            value={draft.sortField ?? SCORE_SORT}
            options={sortOptions}
            onChange={(value) => set({ sortField: value === SCORE_SORT ? null : value })}
          />
          {draft.sortField === null ? null : (
            <button
              type="button"
              data-testid="index-sort-order"
              data-order={draft.sortOrder}
              aria-label={SORT_ORDER_TEXT[draft.sortOrder]}
              title={SORT_ORDER_TEXT[draft.sortOrder]}
              className="flex h-row shrink-0 items-center px-1 text-ink-muted hover:bg-hover hover:text-ink"
              onClick={() => set({ sortOrder: draft.sortOrder === "asc" ? "desc" : "asc" })}
            >
              <OrderIcon aria-hidden className="size-icon" />
            </button>
          )}
        </Segment>
        {timeField === null ? null : (
          <Segment label={timeField}>
            <Dropdown
              variant="inline"
              label="Time range"
              testId="index-range"
              value={draft.range}
              options={RANGE_OPTIONS}
              onChange={(value) => set({ range: value as SearchRangeKey })}
            />
          </Segment>
        )}
      </form>
      <RequestButton request={tab.search?.request ?? null} />
      {searching ? (
        <button
          type="button"
          data-testid="index-cancel"
          className={cn(BAR_BUTTON, "text-danger")}
          onClick={() => void invoke(INDEX_ACTION_IDS.cancel)}
        >
          <StopGlyph aria-hidden className="size-icon" />
          Cancel
        </button>
      ) : (
        <button
          type="submit"
          form={formId}
          data-testid="index-run"
          disabled={tab.status === "connecting"}
          className={cn(BAR_BUTTON, "text-accent disabled:opacity-50")}
        >
          <RunGlyph aria-hidden className="size-icon" />
          Run
        </button>
      )}
    </div>
  );
}
