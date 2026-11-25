import { useState, type ReactNode } from "react";
import { MESSAGE_FORMATS, type MessageFormat } from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { TOPIC_ACTION_IDS } from "@table-craft/desktop/renderer/actions/topicActions.js";
import {
  FROM_KINDS,
  FROM_LABELS,
  MESSAGE_FORMAT_LABELS,
  parsePartitions,
  type FromKind,
  type ReadDraft,
} from "@table-craft/desktop/renderer/model/topicRead.js";
import { useTopicTabs, type TopicTab } from "@table-craft/desktop/renderer/state/topicTabs.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { Dropdown } from "@table-craft/desktop/renderer/ui/Dropdown.js";
import { KeyFilterIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { RunGlyph, StopGlyph } from "@table-craft/desktop/renderer/ui/runGlyphs.js";
import { TimestampHint } from "@table-craft/desktop/renderer/streams/TimestampHint.js";

/** Formats that need the Schema Registry (decision 7). */
const REGISTRY_FORMATS: ReadonlySet<MessageFormat> = new Set(["avro", "protobuf", "jsonSchema"]);
/** Flush fields of the strip (design-system.md, Dropdowns: the flush rule). */
const INPUT_CLASS =
  "h-row min-w-0 border border-transparent bg-transparent px-1 font-grid text-ink outline-none placeholder:text-grid-null focus:border-accent aria-invalid:border-danger";
/**
 * Each control a strip of its own row: the bar wraps to a second row in a narrow tab (audit M6).
 * Segments grow so every wrapped row ends at the bar's edge, and one wider than the bar shrinks
 * to it rather than running under Read.
 */
const SEGMENT_CLASS =
  "flex h-row max-w-full items-center gap-cell overflow-hidden border-r border-b border-line px-cell whitespace-nowrap";

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
    <div className={cn(SEGMENT_CLASS, grow === true ? "min-w-64 grow-[4]" : "min-w-0 grow")}>
      {label === undefined ? null : <span className="shrink-0 text-ink-muted">{label}</span>}
      {children}
    </div>
  );
}

function formatOptions(registry: boolean) {
  return MESSAGE_FORMATS.filter((format) => registry || !REGISTRY_FORMATS.has(format)).map((format) => ({
    value: format,
    label: MESSAGE_FORMAT_LABELS[format],
  }));
}

function partitionsText(partitions: readonly number[] | null): string {
  return partitions === null ? "" : partitions.join(", ");
}

/** The read bar (plan 164 decision 6): partitions, where to start, how many, the decoders and a filter. */
export function ReadBar({
  tabId,
  tab,
  registry,
  groups,
}: {
  readonly tabId: string;
  readonly tab: TopicTab;
  /** The registry formats can be chosen. */
  readonly registry: boolean;
  /** The datasource declares `consumerGroups`, so a group's committed offset can be the start. */
  readonly groups: boolean;
}) {
  const { draft } = tab;
  const set = (change: Partial<ReadDraft>) => useTopicTabs.getState().setDraft(tabId, change);
  const [partitions, setPartitions] = useState(partitionsText(draft.partitions));
  const [shownPartitions, setShownPartitions] = useState(draft.partitions);
  if (shownPartitions !== draft.partitions) {
    setShownPartitions(draft.partitions);
    setPartitions(partitionsText(draft.partitions));
  }
  const count = tab.description?.partitions.length ?? null;
  const parsed = parsePartitions(partitions, count);
  const fromOptions = FROM_KINDS.filter((kind) => groups || kind !== "group").map((kind) => ({
    value: kind,
    label: FROM_LABELS[kind],
  }));
  const formats = formatOptions(registry);
  const invalid = tab.queryError?.code === "invalidRequest";
  const formId = `topic-read-${tabId}`;
  const reading = tab.status === "loading";
  const limit = (
    <Segment label="Limit">
      <input
        aria-label="Limit"
        data-testid="read-limit"
        className={cn(INPUT_CLASS, "w-16 text-right")}
        inputMode="numeric"
        aria-invalid={invalid}
        value={draft.limit}
        onChange={(event) => set({ limit: event.target.value })}
      />
    </Segment>
  );
  return (
    <div className="flex shrink-0 items-stretch overflow-hidden border-b border-line">
      <form
        id={formId}
        aria-label="Read"
        data-testid="topic-read-bar"
        className="-mb-px flex min-w-0 flex-1 flex-wrap items-stretch"
        onSubmit={(event) => {
          event.preventDefault();
          if (typeof parsed === "string" || reading) return;
          set({ partitions: parsed });
          void invoke(TOPIC_ACTION_IDS.read);
        }}
      >
        <Segment label="Partitions">
          <input
            aria-label="Partitions"
            data-testid="read-partitions"
            aria-invalid={typeof parsed === "string"}
            title={typeof parsed === "string" ? parsed : "Blank reads every partition; list some as 0, 3, 7"}
            className={cn(INPUT_CLASS, "w-20")}
            placeholder="All"
            spellCheck={false}
            value={partitions}
            onChange={(event) => setPartitions(event.target.value)}
            onBlur={() => {
              if (typeof parsed !== "string") set({ partitions: parsed });
            }}
          />
        </Segment>
        <Segment label="From">
          <span className="flex shrink-0">
            <Dropdown
              variant="inline"
              label="From"
              testId="read-from"
              value={draft.from}
              options={fromOptions}
              onChange={(value) => set({ from: value as FromKind })}
            />
          </span>
          {draft.from === "latestN" ? (
            <input
              aria-label="Latest messages"
              data-testid="read-latest"
              className={cn(INPUT_CLASS, "w-16 text-right")}
              inputMode="numeric"
              aria-invalid={invalid}
              value={draft.latestN}
              onChange={(event) => set({ latestN: event.target.value })}
            />
          ) : draft.from === "offset" ? (
            <input
              aria-label="From offset"
              data-testid="read-offset"
              className={cn(INPUT_CLASS, "w-28")}
              inputMode="numeric"
              placeholder="1204331"
              aria-invalid={invalid}
              value={draft.offset}
              onChange={(event) => set({ offset: event.target.value })}
            />
          ) : draft.from === "timestamp" ? (
            <>
              <input
                aria-label="From timestamp"
                data-testid="read-timestamp"
                className={cn(INPUT_CLASS, "w-44 shrink-0")}
                placeholder="2026-11-21 09:15:00"
                aria-invalid={invalid}
                value={draft.timestamp}
                onChange={(event) => set({ timestamp: event.target.value })}
              />
              <TimestampHint typed={draft.timestamp} truncate />
            </>
          ) : draft.from === "group" ? (
            <Dropdown
              variant="inline"
              label="Consumer group"
              testId="read-group"
              value={draft.group}
              options={(tab.consumers ?? []).map((group) => ({ value: group.id, label: group.id }))}
              onChange={(group) => set({ group })}
            />
          ) : null}
        </Segment>
        <Segment grow>
          <KeyFilterIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
          <input
            aria-label="Filter key, value or headers"
            data-testid="read-filter"
            className={cn(INPUT_CLASS, "flex-1")}
            placeholder="key, value or header text, or /regex/"
            spellCheck={false}
            value={draft.filter}
            onChange={(event) => set({ filter: event.target.value })}
          />
        </Segment>
        {limit}
        <Segment label="Key">
          <Dropdown
            variant="inline"
            label="Key format"
            testId="read-key-format"
            value={draft.keyFormat}
            options={formats}
            onChange={(value) => set({ keyFormat: value as MessageFormat })}
          />
        </Segment>
        <Segment label="Value">
          <Dropdown
            variant="inline"
            label="Value format"
            testId="read-value-format"
            value={draft.valueFormat}
            options={formats}
            onChange={(value) => set({ valueFormat: value as MessageFormat })}
          />
        </Segment>
      </form>
      {reading ? (
        <button
          type="button"
          data-testid="topic-cancel"
          className="flex shrink-0 items-center gap-cell border-l border-line px-gap font-semibold text-danger hover:bg-hover"
          onClick={() => void invoke(TOPIC_ACTION_IDS.cancelRead)}
        >
          <StopGlyph aria-hidden className="size-icon" />
          Cancel
        </button>
      ) : (
        <button
          type="submit"
          form={formId}
          data-testid="topic-read"
          disabled={tab.status === "connecting"}
          className="flex shrink-0 items-center gap-cell border-l border-line px-gap font-semibold text-accent hover:bg-hover disabled:opacity-50"
        >
          <RunGlyph aria-hidden className="size-icon" />
          Read
        </button>
      )}
    </div>
  );
}
