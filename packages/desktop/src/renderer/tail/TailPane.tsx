import { useEffect, useRef, useState } from "react";
import type { TailMessage } from "@table-craft/desktop/engine/protocol.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { TOPIC_ACTION_IDS, type TopicOffsetArgs } from "@table-craft/desktop/renderer/actions/topicActions.js";
import { BUTTON, INPUT } from "@table-craft/desktop/renderer/keyAdmin/controls.js";
import { parsesAsJson } from "@table-craft/desktop/renderer/model/jsonText.js";
import { prettyJson } from "@table-craft/desktop/renderer/model/prettyJson.js";
import { isPreviewMessage, PREVIEW_ONLY_NOTICE } from "@table-craft/desktop/renderer/model/topicMessage.js";
import { partitionsLabel } from "@table-craft/desktop/renderer/model/topicRead.js";
import { TEXT_TAB_ROW_INSET } from "@table-craft/desktop/renderer/shell/islands.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { CloseIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { TAIL_ACTION_IDS, type TailCommandArgs } from "./actions.js";
import { drawnTailRows, tailStatus, tailTimestamp, useTail, type TailEntry } from "./store.js";

const CELL =
  "h-row max-w-96 truncate border-b border-line px-gap text-left whitespace-nowrap first:pl-pane-inset last:pr-pane-inset";
const NUMBER_CELL = cn(CELL, "text-right tabular-nums");
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(["Partition", "Offset"]);
const COLUMNS = ["Partition", "Offset", "Timestamp", "Key", "Value"] as const;

function command(id: string, kind: TailCommandArgs["kind"]) {
  invoke(TAIL_ACTION_IDS.command, { id, kind });
}

function tailLabel(entry: TailEntry): string {
  const { request } = entry.summary;
  return request.partitions === null ? request.topic : `${request.topic} · ${partitionsLabel(request.partitions)}`;
}

function openAt(entry: TailEntry, message: TailMessage) {
  const args: TopicOffsetArgs = {
    datasourceId: entry.datasourceId,
    topic: entry.summary.request.topic,
    partition: message.partition,
    offset: message.offset,
  };
  invoke(TOPIC_ACTION_IDS.openAt, args);
}

function valueText(value: string | null): string {
  if (value === null) return "null";
  return parsesAsJson(value) ? prettyJson(value) : value;
}

type WholeState = "loading" | "lost" | "whole";

/** The selected row's whole message from the tail's temporary file (decision 172), else its preview. */
function useWholeTailMessage(
  id: string,
  sequence: string,
  preview: TailMessage,
): { readonly state: WholeState; readonly message: TailMessage } {
  const [fetched, setFetched] = useState<{ readonly sequence: string; readonly message: TailMessage | null } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    void useTail
      .getState()
      .message(id, sequence)
      .catch(() => null)
      .then((message) => {
        if (live) setFetched({ sequence, message });
      });
    return () => {
      live = false;
    };
  }, [id, sequence]);
  const cut = isPreviewMessage(preview);
  if (fetched === null || fetched.sequence !== sequence) return { state: cut ? "loading" : "whole", message: preview };
  if (fetched.message === null) return { state: cut ? "lost" : "whole", message: preview };
  return { state: "whole", message: fetched.message };
}

function Detail({
  entry,
  sequence,
  preview,
}: {
  readonly entry: TailEntry;
  readonly sequence: string;
  readonly preview: TailMessage;
}) {
  const { state, message } = useWholeTailMessage(entry.summary.tailId, sequence, preview);
  const facts = [
    `Partition ${String(message.partition)}`,
    `Offset ${message.offset}`,
    tailTimestamp(message.timestamp),
    message.keySchema === null ? null : `Key schema ${message.keySchema}`,
    message.valueSchema === null ? null : `Value schema ${message.valueSchema}`,
  ].filter((fact) => fact !== null && fact !== "");
  return (
    <section
      aria-label="Selected message"
      data-testid="tail-detail"
      className="flex max-h-[40%] min-h-0 shrink-0 flex-col border-t border-line"
    >
      <div className="flex flex-wrap items-center gap-cell px-pane-inset py-cell">
        <span className="text-ink-muted">{facts.join(" · ")}</span>
        <button
          type="button"
          className={cn(BUTTON, "ml-auto")}
          data-testid="tail-open-at"
          onClick={() => openAt(entry, message)}
        >
          Open in Topic Tab at This Offset
        </button>
      </div>
      <div className="min-h-0 overflow-auto px-pane-inset pb-cell font-grid">
        {state === "whole" ? null : (
          <p className="text-ink-muted" data-testid="tail-detail-note">
            {state === "loading" ? "Loading full message…" : PREVIEW_ONLY_NOTICE}
          </p>
        )}
        <p className="text-ink-muted">Key</p>
        <pre className="whitespace-pre-wrap">{message.key ?? "null"}</pre>
        {message.headers.length === 0 ? null : (
          <>
            <p className="text-ink-muted">Headers</p>
            <pre className="whitespace-pre-wrap">
              {message.headers.map((header) => `${header.name}: ${header.value ?? "null"}`).join("\n")}
            </pre>
          </>
        )}
        <p className="text-ink-muted">Value</p>
        <pre className="whitespace-pre-wrap" data-testid="tail-detail-value">
          {valueText(message.value)}
        </pre>
      </div>
    </section>
  );
}

function Stream({ entry }: { readonly entry: TailEntry }) {
  const id = entry.summary.tailId;
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const { rows, hidden } = drawnTailRows(entry.rows, filter);
  const last = rows.at(-1)?.sequence;
  useEffect(() => {
    if (follow) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [follow, last]);
  const stopped = entry.summary.state === "stopped";
  const chosen = entry.rows.find((row) => row.kind === "message" && row.sequence === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        role="toolbar"
        aria-label="Tail controls"
        className="flex flex-wrap items-center gap-cell border-b border-line px-pane-inset py-cell"
      >
        <button
          type="button"
          className={BUTTON}
          aria-pressed={entry.paused}
          data-testid="tail-pause"
          disabled={stopped}
          onClick={() => command(id, "pause")}
        >
          {entry.paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className={BUTTON} onClick={() => command(id, "clear")}>
          Clear
        </button>
        <button type="button" className={BUTTON} disabled={stopped} onClick={() => command(id, "stop")}>
          Stop
        </button>
        <button type="button" className={BUTTON} onClick={() => command(id, "copy")}>
          Copy as JSON Lines
        </button>
        <button type="button" className={BUTTON} data-testid="tail-export" onClick={() => command(id, "export")}>
          Export…
        </button>
        <label className="flex items-center gap-cell">
          <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} />
          Follow
        </label>
        <input
          className={INPUT}
          aria-label="Filter key, value or headers"
          data-testid="tail-filter"
          placeholder="Filter, or /regex/"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <span className="ml-auto text-ink-muted" data-testid="tail-status">
          {tailStatus(entry)}
        </span>
      </div>
      {entry.error === null ? null : (
        <p role="alert" className="px-pane-inset py-cell text-danger">
          {entry.error}
        </p>
      )}
      <div ref={scroller} tabIndex={0} className="min-h-0 flex-1 overflow-auto">
        {hidden === 0 ? null : (
          <p className="px-pane-inset py-cell text-ink-muted" data-testid="tail-hidden">
            {hidden.toLocaleString("en-US")} older messages are held but not drawn; export or copy them, or narrow the
            filter.
          </p>
        )}
        <table role="grid" aria-label="Tailed messages" data-testid="tail-rows" className="w-full font-grid">
          <thead className="sticky top-0 bg-panel">
            <tr>
              {COLUMNS.map((label) => (
                <th
                  className={NUMERIC_COLUMNS.has(label) ? NUMBER_CELL : CELL}
                  key={label}
                  title={label === "Timestamp" ? "UTC" : undefined}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.kind === "gap" ? (
                <tr key={row.sequence} data-testid="tail-gap">
                  <td colSpan={COLUMNS.length} className={cn(CELL, "text-warning")}>
                    dropped {BigInt(row.dropped).toLocaleString("en-US")} messages
                  </td>
                </tr>
              ) : (
                <tr
                  key={row.sequence}
                  aria-selected={row.sequence === selected}
                  data-testid="tail-row"
                  className="hover:bg-hover aria-selected:bg-selection"
                  onClick={() => setSelected(row.sequence)}
                  onDoubleClick={() => openAt(entry, row.message)}
                >
                  <td className={NUMBER_CELL}>{row.message.partition}</td>
                  <td className={NUMBER_CELL}>{row.message.offset}</td>
                  <td className={CELL}>{tailTimestamp(row.message.timestamp)}</td>
                  <td className={CELL}>{row.message.key ?? ""}</td>
                  <td className={CELL}>{row.message.value ?? ""}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {chosen?.kind === "message" ? <Detail entry={entry} sequence={chosen.sequence} preview={chosen.message} /> : null}
    </div>
  );
}

/** The Live Tail tool window (plan 164 decision 14): one tab per tail, newest messages last. */
export function TailPane() {
  const entries = useTail((state) => state.entries);
  const activeId = useTail((state) => state.activeId);
  const entry = activeId === null ? undefined : entries[activeId];
  return (
    <section
      data-testid="tail-pane"
      aria-label="Live Tail"
      className="flex h-full min-h-0 flex-col overflow-hidden text-ui"
    >
      <div
        role="tablist"
        aria-label="Tails"
        className={`flex shrink-0 scrollbar-none overflow-x-auto border-b border-line bg-panel ${TEXT_TAB_ROW_INSET}`}
      >
        {Object.values(entries).map((item) => (
          <div key={item.summary.tailId} className="flex shrink-0 items-center border-r border-line">
            <button
              type="button"
              role="tab"
              aria-selected={item.summary.tailId === activeId}
              className="h-row px-gap aria-selected:bg-selection"
              onClick={() => command(item.summary.tailId, "select")}
            >
              {tailLabel(item)}
            </button>
            <button
              type="button"
              className="px-cell"
              aria-label={`Close tail ${tailLabel(item)}`}
              onClick={() => command(item.summary.tailId, "close")}
            >
              <CloseIcon aria-hidden className="size-icon" />
            </button>
          </div>
        ))}
      </div>
      {entry === undefined ? (
        <p className="px-pane-inset py-gap text-ink-muted">
          Tail a topic from its tab or the Database tree. Tailing never joins a consumer group; hiding this window does
          not stop a tail.
        </p>
      ) : (
        <Stream key={entry.summary.tailId} entry={entry} />
      )}
    </section>
  );
}
