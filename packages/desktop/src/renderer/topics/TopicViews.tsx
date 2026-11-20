import type { ReactNode } from "react";
import type { GroupSummary, TopicDescription } from "@table-craft/desktop/engine/protocol.js";
import { GROUP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/groupActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { TOPIC_ACTION_IDS } from "@table-craft/desktop/renderer/actions/topicActions.js";
import { grouped } from "@table-craft/desktop/renderer/model/groupLag.js";
import { bigOf, lagExceeds } from "@table-craft/desktop/renderer/model/streamTree.js";
import { durationText } from "@table-craft/desktop/renderer/model/topicRead.js";
import { formatBytes } from "@table-craft/desktop/renderer/model/format.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { GroupStateBadge } from "@table-craft/desktop/renderer/streams/GroupStateBadge.js";
import { LINK_BUTTON } from "@table-craft/desktop/renderer/ui/linkClasses.js";

/** A table that is not the result grid (plan 164 design): muted header, ruled rows, numbers right. */
export const PLAIN_CELL = "h-row-loose px-gap whitespace-nowrap first:pl-pane-inset last:pr-pane-inset";
export const PLAIN_NUMBER = cn(PLAIN_CELL, "text-right font-grid tabular-nums");
export const PLAIN_HEAD = "sticky top-0 bg-canvas text-ink-muted [&_th]:font-normal";
const SENSITIVE_MASK = "••••••";

export function PlainTable({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table aria-label={label} className="w-full">
        {children}
      </table>
    </div>
  );
}

function sum(values: readonly (string | null)[]): bigint | null {
  let total = 0n;
  for (const value of values) {
    const parsed = bigOf(value);
    if (parsed === null) return null;
    total += parsed;
  }
  return total;
}

function sizeText(bytes: string | null): string {
  const value = bigOf(bytes);
  return value === null ? "" : formatBytes(Number(value));
}

export function PartitionsView({
  description,
  writeReason,
}: {
  readonly description: TopicDescription;
  readonly writeReason: string | null;
}) {
  const messages = description.partitions.map((partition) => {
    const low = bigOf(partition.low);
    const high = bigOf(partition.high);
    return low === null || high === null ? null : high - low;
  });
  const totalMessages = messages.every((count) => count !== null)
    ? messages.reduce<bigint>((total, count) => total + (count ?? 0n), 0n)
    : null;
  const totalBytes = sum(description.partitions.map((partition) => partition.bytes));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-line px-1">
        <ActionButton actionId={TOPIC_ACTION_IDS.addPartitions} reason={writeReason} />
        <ActionButton actionId={TOPIC_ACTION_IDS.deleteRecords} reason={writeReason} testId="topic-delete-records" />
      </div>
      <PlainTable label="Partitions">
        <thead className={PLAIN_HEAD}>
          <tr>
            <th className={PLAIN_NUMBER}>Partition</th>
            <th className={PLAIN_NUMBER}>Leader</th>
            <th className={cn(PLAIN_CELL, "text-left")}>Replicas</th>
            <th className={cn(PLAIN_CELL, "text-left")}>In sync</th>
            <th className={PLAIN_NUMBER}>Low watermark</th>
            <th className={PLAIN_NUMBER}>High watermark</th>
            <th className={PLAIN_NUMBER}>Messages</th>
            <th className={PLAIN_NUMBER}>Size</th>
          </tr>
        </thead>
        <tbody>
          {description.partitions.map((partition, index) => (
            <tr key={partition.partition} className="border-t border-line">
              <td className={PLAIN_NUMBER}>{partition.partition}</td>
              <td className={cn(PLAIN_NUMBER, partition.leader === null && "text-danger")}>
                {partition.leader ?? "none"}
              </td>
              <td className={cn(PLAIN_CELL, "font-grid")}>{partition.replicas.join(", ")}</td>
              <td
                className={cn(
                  PLAIN_CELL,
                  "font-grid",
                  partition.isr.length < partition.replicas.length && "text-warning",
                )}
              >
                {partition.isr.join(", ")}
                {partition.isr.length < partition.replicas.length ? (
                  <span className="ml-cell inline-flex items-center gap-1 font-ui">
                    <WarningIcon aria-hidden weight="fill" className="size-3" />
                    under-replicated
                  </span>
                ) : null}
              </td>
              <td className={PLAIN_NUMBER}>{grouped(partition.low)}</td>
              <td className={PLAIN_NUMBER}>{grouped(partition.high)}</td>
              <td className={PLAIN_NUMBER}>{messages[index]?.toLocaleString("en-US") ?? ""}</td>
              <td className={PLAIN_NUMBER}>{sizeText(partition.bytes)}</td>
            </tr>
          ))}
          <tr className="border-t border-line font-semibold">
            <td className={PLAIN_CELL}>Total</td>
            <td colSpan={5} />
            <td className={PLAIN_NUMBER}>{totalMessages?.toLocaleString("en-US") ?? ""}</td>
            <td className={PLAIN_NUMBER}>{totalBytes === null ? "" : formatBytes(Number(totalBytes))}</td>
          </tr>
        </tbody>
      </PlainTable>
    </div>
  );
}

export function ConfigsView({
  description,
  writeReason,
}: {
  readonly description: TopicDescription;
  readonly writeReason: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-row shrink-0 items-center gap-1 border-b border-line px-1">
        <ActionButton actionId={TOPIC_ACTION_IDS.editConfigs} reason={writeReason} testId="topic-edit-configs" />
      </div>
      <PlainTable label="Configs">
        <thead className={PLAIN_HEAD}>
          <tr>
            <th className={cn(PLAIN_CELL, "text-left")}>Name</th>
            <th className={cn(PLAIN_CELL, "text-left")}>Value</th>
            <th className={cn(PLAIN_CELL, "text-left")}>Source</th>
          </tr>
        </thead>
        <tbody>
          {description.configs.map((entry) => {
            const duration = entry.name.endsWith(".ms") ? durationText(entry.value) : null;
            return (
              <tr key={entry.name} className="border-t border-line" title={entry.documentation ?? undefined}>
                <td className={cn(PLAIN_CELL, "font-grid")}>{entry.name}</td>
                <td className={cn(PLAIN_CELL, "font-grid")}>
                  {entry.sensitive ? SENSITIVE_MASK : (entry.value ?? "")}
                  {duration === null ? null : <span className="ml-cell text-ink-muted">{duration}</span>}
                  {entry.readOnly ? <span className="ml-cell text-ink-muted">read-only</span> : null}
                </td>
                <td className={cn(PLAIN_CELL, entry.isDefault && "text-ink-muted")}>{entry.source}</td>
              </tr>
            );
          })}
        </tbody>
      </PlainTable>
    </div>
  );
}

export function ConsumersView({
  datasourceId,
  topic,
  consumers,
  lagWarning,
}: {
  readonly datasourceId: string;
  readonly topic: string;
  readonly consumers: readonly GroupSummary[] | null;
  readonly lagWarning: number;
}) {
  if (consumers === null)
    return <p className="px-pane-inset py-gap text-ink-muted">This data source does not list consumer groups.</p>;
  if (consumers.length === 0)
    return <p className="px-pane-inset py-gap text-ink-muted">No consumer group has committed offsets on {topic}.</p>;
  return (
    <PlainTable label="Consumers">
      <thead className={PLAIN_HEAD}>
        <tr>
          <th className={cn(PLAIN_CELL, "text-left")}>Group</th>
          <th className={cn(PLAIN_CELL, "text-left")}>State</th>
          <th className={PLAIN_NUMBER}>Members</th>
          <th className={PLAIN_NUMBER}>Lag on {topic}</th>
        </tr>
      </thead>
      <tbody>
        {consumers.map((group) => (
          <tr key={group.id} className="border-t border-line">
            <td className={PLAIN_CELL}>
              <button
                type="button"
                className={cn(LINK_BUTTON, "font-grid")}
                onClick={() => invoke(GROUP_ACTION_IDS.open, { datasourceId, group: group.id })}
              >
                {group.id}
              </button>
            </td>
            <td className={PLAIN_CELL}>
              <GroupStateBadge state={group.state} lagging={lagExceeds(group.lag, lagWarning)} />
            </td>
            <td className={PLAIN_NUMBER}>{group.members ?? ""}</td>
            <td className={cn(PLAIN_NUMBER, lagExceeds(group.lag, lagWarning) && "text-warning")}>
              {grouped(group.lag)}
            </td>
          </tr>
        ))}
      </tbody>
    </PlainTable>
  );
}
