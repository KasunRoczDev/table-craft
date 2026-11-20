import { useEffect } from "react";
import type { GroupDescription, GroupMember, PartitionLag } from "@table-craft/desktop/engine/protocol.js";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { GROUP_ACTION_IDS } from "@table-craft/desktop/renderer/actions/groupActions.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import {
  behindText,
  grouped,
  hotLags,
  lagFinding,
  lagScale,
  memberHost,
  partitionList,
} from "@table-craft/desktop/renderer/model/groupLag.js";
import {
  bigOf,
  DEFAULT_LAG_WARNING,
  lagExceeds,
  lagWarningOf,
} from "@table-craft/desktop/renderer/model/streamTree.js";
import {
  GROUP_REFRESH_MS,
  useGroupTabs,
  type GroupTab as GroupTabState,
  type GroupView,
} from "@table-craft/desktop/renderer/state/groupTabs.js";
import { LagAxis, LagRuler } from "@table-craft/desktop/renderer/streams/LagRuler.js";
import { ObjectHeader, Subtabs } from "@table-craft/desktop/renderer/streams/ObjectHeader.js";
import { PLAIN_CELL, PLAIN_HEAD, PLAIN_NUMBER, PlainTable } from "@table-craft/desktop/renderer/topics/TopicViews.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { LINK_BUTTON } from "@table-craft/desktop/renderer/ui/linkClasses.js";
import { GroupStateBadge } from "@table-craft/desktop/renderer/streams/GroupStateBadge.js";
import { useStreamReasons } from "@table-craft/desktop/renderer/streams/reasons.js";

const ERROR_CLASS = "shrink-0 border-b border-line bg-panel px-gap py-1 break-words text-danger";

function topicsOf(description: GroupDescription): readonly string[] {
  return [...new Set(description.offsets.map((offset) => offset.topic))].sort();
}

function Facts({ description }: { readonly description: GroupDescription }) {
  const topics = topicsOf(description);
  return (
    <>
      {description.protocolType === null || description.protocolType === ""
        ? "No consumer joined"
        : `${description.protocolType} protocol`}
      {description.protocol === null || description.protocol === "" ? "" : ` · ${description.protocol}`}
      {topics.length === 0 ? (
        " · nothing committed"
      ) : (
        <>
          {" "}
          · commits <b className="font-normal text-ink">{topics.join(", ")}</b>
        </>
      )}
    </>
  );
}

function Finding({ description, warning }: { readonly description: GroupDescription; readonly warning: number }) {
  const finding = lagFinding(description.offsets);
  if (finding === null) return <span className="text-ink-muted">Caught up: no partition lags.</span>;
  const lagging = lagExceeds(description.lag ?? finding.total.toString(), warning);
  const hotPartitions = finding.hot.map((each) => each.partition);
  return (
    <span data-testid="group-finding">
      <b className={lagging ? "text-warning" : "text-ink"}>{behindText(finding.total)}</b> on{" "}
      {finding.topics.join(", ")}
      {hotPartitions.length === 0
        ? "."
        : `, ${String(finding.hotShare)}% of them on ${hotPartitions.length === 1 ? "partition" : "partitions"} ${partitionList(hotPartitions)}.`}
    </span>
  );
}

function LagTable({
  datasourceId,
  description,
  writeReason,
}: {
  readonly datasourceId: string;
  readonly description: GroupDescription;
  readonly writeReason: string | null;
}) {
  const lags = description.offsets.map((offset) => bigOf(offset.lag));
  const scale = lagScale(lags);
  const hot = hotLags(lags);
  const topics = topicsOf(description).length > 1;
  const total = lags.reduce<bigint>((sum, lag) => sum + (lag ?? 0n), 0n);
  return (
    <PlainTable label="Lag by partition">
      <thead className={PLAIN_HEAD}>
        <tr>
          {topics ? <th className={cn(PLAIN_CELL, "text-left")}>Topic</th> : null}
          <th className={PLAIN_NUMBER}>Partition</th>
          <th className={PLAIN_NUMBER}>Committed</th>
          <th className={PLAIN_NUMBER}>High watermark</th>
          <th className={PLAIN_NUMBER}>Lag</th>
          <th className={cn(PLAIN_CELL, "w-1/3")}>
            <LagAxis scale={scale} />
          </th>
          <th className={PLAIN_CELL}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {description.offsets.map((offset, index) => (
          <tr
            key={`${offset.topic}:${String(offset.partition)}`}
            data-testid="lag-row"
            data-partition={offset.partition}
            data-hot={hot[index] === true || undefined}
            className="border-t border-line hover:bg-hover"
            title="Double-click to read from the committed offset"
            onDoubleClick={() => readFromHere(datasourceId, description.id, offset)}
          >
            {topics ? <td className={cn(PLAIN_CELL, "font-grid")}>{offset.topic}</td> : null}
            <td className={PLAIN_NUMBER}>{offset.partition}</td>
            <td className={PLAIN_NUMBER}>{offset.committed === null ? "none" : grouped(offset.committed)}</td>
            <td className={PLAIN_NUMBER}>{grouped(offset.high)}</td>
            <td className={cn(PLAIN_NUMBER, hot[index] === true && "text-warning")}>
              {hot[index] === true ? (
                <span className="mr-cell inline-flex items-center gap-1 font-ui">
                  <WarningIcon aria-hidden weight="fill" className="size-3" />
                  lagging
                </span>
              ) : null}
              {grouped(offset.lag)}
            </td>
            <td className={PLAIN_CELL}>
              <LagRuler lag={lags[index] ?? null} scale={scale} hot={hot[index] === true} />
            </td>
            <td className={cn(PLAIN_CELL, "text-right")}>
              <span className="inline-flex gap-1">
                <button
                  type="button"
                  className={LINK_BUTTON}
                  data-testid="lag-read-from-here"
                  disabled={offset.committed === null}
                  onClick={() => readFromHere(datasourceId, description.id, offset)}
                >
                  Read from Here
                </button>
                <button
                  type="button"
                  className={LINK_BUTTON}
                  data-testid="lag-skip-record"
                  disabled={writeReason !== null}
                  title={writeReason ?? undefined}
                  onClick={() =>
                    invoke(GROUP_ACTION_IDS.resetOffsets, {
                      datasourceId,
                      group: description.id,
                      topic: offset.topic,
                      draft: { kind: "shift", shift: "+1", partitions: String(offset.partition) },
                    })
                  }
                >
                  Skip Record on Partition {offset.partition}…
                </button>
              </span>
            </td>
          </tr>
        ))}
        <tr className="border-t border-line font-semibold">
          <td className={PLAIN_CELL} colSpan={topics ? 4 : 3}>
            Total
          </td>
          <td className={PLAIN_NUMBER}>{total.toLocaleString("en-US")}</td>
          <td />
          <td />
        </tr>
      </tbody>
    </PlainTable>
  );
}

/** Read from Here (audit M9): the topic tab on that partition, from the committed offset, 50 messages. */
function readFromHere(datasourceId: string, group: string, offset: PartitionLag): void {
  if (offset.committed === null) return;
  invoke(GROUP_ACTION_IDS.readFromHere, {
    datasourceId,
    group,
    topic: offset.topic,
    partition: offset.partition,
    offset: offset.committed,
  });
}

function assignmentText(member: GroupMember): string {
  return member.assignments.map((assignment) => `${assignment.topic} ${assignment.partitions.join(", ")}`).join(" · ");
}

function MembersPanel({ description }: { readonly description: GroupDescription }) {
  const topics = topicsOf(description);
  return (
    <aside
      aria-label="Members"
      data-testid="group-members-panel"
      className="w-80 shrink-0 overflow-auto border-l border-line px-pane-inset py-gap"
    >
      <h2 className="font-semibold">Members</h2>
      {description.members.length === 0 ? (
        <>
          <p className="mb-gap text-ink-muted">None.</p>
          <p className="mb-gap rounded border border-dashed border-line p-cell text-ink-muted">
            Offsets can be reset only while a group has no members, so this group can be reset now.
          </p>
        </>
      ) : (
        <ul className="mb-gap flex flex-col gap-1">
          {description.members.map((member) => (
            <li key={member.id} className="flex flex-col">
              <span className="font-grid">{member.clientId}</span>
              <span className="text-ink-muted">
                {memberHost(member.host)}
                {member.assignments.length === 0 ? "" : ` · ${assignmentText(member)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      <h2 className="font-semibold">Committed on</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-gap gap-y-1">
        {topics.map((topic) => {
          const count = description.offsets.filter((offset) => offset.topic === topic).length;
          return (
            <div key={topic} className="contents">
              <dt className="font-grid">{topic}</dt>
              <dd className="text-ink-muted">
                {count} {count === 1 ? "partition" : "partitions"}
              </dd>
            </div>
          );
        })}
      </dl>
    </aside>
  );
}

function MembersTable({ description }: { readonly description: GroupDescription }) {
  if (description.members.length === 0)
    return <p className="px-pane-inset py-gap text-ink-muted">The group has no members.</p>;
  return (
    <PlainTable label="Members">
      <thead className={PLAIN_HEAD}>
        <tr>
          <th className={cn(PLAIN_CELL, "text-left")}>Client</th>
          <th className={cn(PLAIN_CELL, "text-left")}>Host</th>
          <th className={cn(PLAIN_CELL, "text-left")}>Member</th>
          <th className={cn(PLAIN_CELL, "text-left")}>Assigned</th>
        </tr>
      </thead>
      <tbody>
        {description.members.map((member) => (
          <tr key={member.id} className="border-t border-line">
            <td className={cn(PLAIN_CELL, "font-grid")}>{member.clientId}</td>
            <td className={cn(PLAIN_CELL, "font-grid")}>{memberHost(member.host)}</td>
            <td className={cn(PLAIN_CELL, "font-grid text-ink-muted")}>{member.instanceId ?? member.id}</td>
            <td className={PLAIN_CELL}>{assignmentText(member)}</td>
          </tr>
        ))}
      </tbody>
    </PlainTable>
  );
}

function Body({ tab, writeReason }: { readonly tab: GroupTabState; readonly writeReason: string | null }) {
  const description = tab.description;
  if (description === null)
    return <p className="px-pane-inset py-gap text-ink-muted">{tab.error === null ? "Reading the group…" : ""}</p>;
  if (tab.view === "members") return <MembersTable description={description} />;
  return (
    <div className="flex min-h-0 flex-1">
      {description.offsets.length === 0 ? (
        <p className="flex-1 px-pane-inset py-gap text-ink-muted">The group has committed no offsets.</p>
      ) : (
        <LagTable datasourceId={tab.datasourceId} description={description} writeReason={writeReason} />
      )}
      <MembersPanel description={description} />
    </div>
  );
}

const PAD = 2;

/** `10:12:30` in local time: when the shown lag was read (audit m10). */
export function clockText(at: number): string {
  const time = new Date(at);
  return [time.getHours(), time.getMinutes(), time.getSeconds()]
    .map((part) => String(part).padStart(PAD, "0"))
    .join(":");
}

/** A consumer group's tab (plan 164 Phase 5): its lag per partition on one ruler, its members, and Reset Offsets. */
export function GroupTab({ tabId }: { readonly tabId: string }) {
  const tab = useGroupTabs((state) => state.tabs[tabId]);
  const datasource = useConsoleDatasource(tabId);
  const reasons = useStreamReasons(datasource);
  // Mounted only while it is the active tab, so the timer runs only while the lag is in view (audit m10).
  useEffect(() => {
    const timer = setInterval(() => void useGroupTabs.getState().refresh(tabId, true), GROUP_REFRESH_MS);
    return () => clearInterval(timer);
  }, [tabId]);
  if (tab === undefined) return null;
  const color = datasource?.color ?? null;
  const warning = datasource === undefined ? DEFAULT_LAG_WARNING : lagWarningOf(datasource.config);
  const description = tab.description;
  const views: readonly { readonly value: GroupView; readonly label: string; readonly count?: number | null }[] = [
    { value: "lag", label: "Lag" },
    { value: "members", label: "Members", count: description?.members.length ?? null },
  ];
  return (
    <div
      data-testid="group-tab"
      data-color={color ?? undefined}
      {...{ [REGION_ATTRIBUTE]: "tableEditor" }}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <ObjectHeader
        testId="group-header"
        kind="Consumer group"
        name={tab.group}
        badge={
          description === null ? null : (
            <GroupStateBadge state={description.state} lagging={lagExceeds(description.lag, warning)} />
          )
        }
        facts={description === null ? tab.loading ? "Reading…" : "" : <Facts description={description} />}
        finding={description === null ? null : <Finding description={description} warning={warning} />}
        actions={
          <>
            {tab.readAt === null ? null : (
              <span data-testid="group-updated" className="text-ink-muted tabular-nums">
                Updated {clockText(tab.readAt)}
              </span>
            )}
            <ActionButton actionId={GROUP_ACTION_IDS.refresh} reason={reasons.read} />
            <ActionButton actionId={GROUP_ACTION_IDS.resetOffsets} reason={reasons.write} testId="group-reset" />
          </>
        }
      />
      <Subtabs
        label="Group views"
        views={views}
        value={tab.view}
        onSelect={(view) => void invoke(GROUP_ACTION_IDS.showView, { view })}
      />
      {tab.error === null ? null : (
        <div role="alert" data-testid="group-error" className={ERROR_CLASS}>
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      <Body tab={tab} writeReason={reasons.write} />
    </div>
  );
}
