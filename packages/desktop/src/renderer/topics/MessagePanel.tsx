import { useEffect, useState, type ReactNode } from "react";
import type { SpilledMessage } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { TOPIC_ACTION_IDS } from "@table-craft/desktop/renderer/actions/topicActions.js";
import {
  isPreviewMessage,
  messageOf,
  PREVIEW_ONLY_NOTICE,
  withFullCells,
  type TopicMessage,
} from "@table-craft/desktop/renderer/model/topicMessage.js";
import { prettyJson } from "@table-craft/desktop/renderer/model/prettyJson.js";
import { rowAt } from "@table-craft/desktop/renderer/state/resultTab.js";
import { useTopicTabs, type TopicTab } from "@table-craft/desktop/renderer/state/topicTabs.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="font-semibold text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ entries }: { readonly entries: readonly (readonly [string, string | null])[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-gap gap-y-0.5">
      {entries.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-ink-muted">{name}</dt>
          <dd className="min-w-0 truncate font-grid select-text" title={value ?? undefined}>
            {value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Whether the row is the group's next record on its partition, and the group's offset there. */
function committedNote(tab: TopicTab, message: TopicMessage): ReactNode {
  const committed = tab.committed;
  if (committed === null || message.partition === null) return null;
  const offset = committed.offsets[message.partition];
  if (offset === undefined) return null;
  const here = offset === message.offset;
  return (
    <p
      data-testid="committed-note"
      data-here={here || undefined}
      className={here ? "flex items-start gap-cell rounded bg-warning/15 p-cell" : "text-ink-muted"}
    >
      {here ? <WarningIcon aria-hidden weight="fill" className="mt-0.5 size-icon shrink-0 text-warning" /> : null}
      <span>
        {here
          ? `${committed.group}'s committed offset: the group reads this record next.`
          : `${committed.group}'s committed offset on partition ${String(message.partition)}: ${BigInt(offset).toLocaleString("en-US")}`}
      </span>
    </p>
  );
}

interface WholeMessage {
  /** `loading` and `lost` only for a message whose cells are cut previews. */
  readonly state: "loading" | "lost" | "whole";
  readonly message: TopicMessage | null;
}

/** The previewed message with its whole cells from the read's temporary file (decision 172). */
function useWholeMessage(tabId: string, handle: string | null, preview: TopicMessage | null): WholeMessage {
  const partition = preview?.partition ?? null;
  const offset = preview?.offset ?? "";
  const key = handle === null || partition === null ? null : `${handle}:${String(partition)}:${offset}`;
  const [fetched, setFetched] = useState<{ readonly key: string; readonly full: SpilledMessage | null } | null>(null);
  useEffect(() => {
    if (key === null || partition === null) return;
    let live = true;
    void useTopicTabs
      .getState()
      .message(tabId, partition, offset)
      .catch(() => null)
      .then((full) => {
        if (live) setFetched({ key, full });
      });
    return () => {
      live = false;
    };
  }, [tabId, key, partition, offset]);
  const cut = preview !== null && isPreviewMessage(preview);
  if (preview === null || fetched === null || fetched.key !== key)
    return { state: cut ? "loading" : "whole", message: null };
  if (fetched.full === null) return { state: cut ? "lost" : "whole", message: null };
  return { state: "whole", message: withFullCells(preview, fetched.full) };
}

/**
 * The topic tab's side panel (audit M12): the focused row as a message, its decoded value, its
 * headers by name, and its record facts, with Copy Message as JSON and Open in Console.
 */
export function MessagePanel({
  tabId,
  tab,
  focus,
}: {
  readonly tabId: string;
  readonly tab: TopicTab;
  readonly focus: { readonly row: number; readonly column: number } | null;
}) {
  const result = tab.result;
  const row = result === null || focus === null ? undefined : rowAt(result.windows, focus.row);
  const preview = result === null || row === undefined ? null : messageOf(result.columns, row);
  const whole = useWholeMessage(tabId, result?.handle ?? null, preview);
  const message = whole.message ?? preview;
  return (
    <aside
      aria-label="Message"
      data-testid="message-panel"
      {...{ [REGION_ATTRIBUTE]: "valuePanel" }}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto border-l border-line bg-canvas"
    >
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-line px-1">
        <span className="px-cell font-semibold">Message</span>
        <span className="flex-1" />
        <ActionButton actionId={TOPIC_ACTION_IDS.copyMessage} compact />
        <ActionButton actionId={TOPIC_ACTION_IDS.openMessageInConsole} compact />
      </div>
      {message === null ? (
        <p className="px-pane-inset py-gap text-ink-muted">Select a row to see its message.</p>
      ) : (
        <div className="flex flex-col gap-gap px-pane-inset py-gap">
          {committedNote(tab, message)}
          {whole.state === "loading" ? (
            <p className="text-ink-muted" data-testid="message-loading">
              Loading full message…
            </p>
          ) : whole.state === "lost" ? (
            <p className="text-ink-muted" data-testid="message-preview-only">
              {PREVIEW_ONLY_NOTICE}
            </p>
          ) : null}
          <Section title="Value">
            <pre data-testid="message-value" className="font-grid whitespace-pre-wrap break-all select-text">
              {message.value === null ? "null" : message.valueJson ? prettyJson(message.value) : message.value}
            </pre>
          </Section>
          <Section title="Headers">
            {message.headers.length === 0 ? (
              <p className="text-ink-muted">None</p>
            ) : (
              <Facts entries={message.headers.map((header) => [header.name, header.value] as const)} />
            )}
          </Section>
          <Section title="Record">
            <Facts
              entries={[
                ["Partition", message.partition === null ? null : String(message.partition)],
                ["Offset", message.offset],
                ["Timestamp", message.timestamp === "" ? null : `${message.timestamp.replace("T", " ")} UTC`],
                ["Key", message.key],
                ["Size", message.size === "" ? null : `${message.size} bytes`],
                ["Key schema", message.keySchema],
                ["Value schema", message.valueSchema],
              ]}
            />
          </Section>
        </div>
      )}
    </aside>
  );
}
