import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useState } from "react";
import type { ResetPreview } from "@table-craft/desktop/engine/protocol.js";
import { onFieldEnter } from "@table-craft/desktop/renderer/streams/enterKey.js";
import {
  Button,
  DialogFooter,
  FIELD_GRID_CLASS,
  FieldRow,
  Select,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import {
  grouped,
  hotLags,
  lagScale,
  partitionList,
  RESET_KIND_LABELS,
  RESET_KINDS,
  resetApply,
  resetChange,
  resetConsequence,
  resetTargetOf,
  signedCount,
  type ResetDraft,
  type ResetKind,
  memberHost,
} from "@table-craft/desktop/renderer/model/groupLag.js";
import { bigOf, nounFor } from "@table-craft/desktop/renderer/model/streamTree.js";
import {
  failureText,
  isProduction,
  useStreamDialog,
  type StreamDialogRequest,
} from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { LagAxis, LagRuler } from "@table-craft/desktop/renderer/streams/LagRuler.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { parsePartitions } from "@table-craft/desktop/renderer/model/topicRead.js";
import { typedMatches } from "@table-craft/desktop/renderer/model/topicAdmin.js";
import { StreamDialogTitle } from "@table-craft/desktop/renderer/streams/DialogTitle.js";
import { TimestampHint } from "@table-craft/desktop/renderer/streams/TimestampHint.js";
import { Segmented } from "@table-craft/desktop/renderer/ui/Segmented.js";

/** The preview waits this long after the last keystroke before asking the broker again. */
const PREVIEW_DELAY_MS = 300;
const ALL_TOPICS = "";
const EMPTY_STATE = "Empty";
const TOKEN_PREFIX_CHARS = 6;

const CELL = "h-row px-gap whitespace-nowrap first:pl-cell last:pr-cell";
const NUMBER_CELL = cn(CELL, "text-right font-grid tabular-nums");

type Request = Extract<StreamDialogRequest, { kind: "reset" }>;

/** The broker's answer to one previewed scope and target, kept by what was asked so a stale one never shows. */
interface PreviewAnswer {
  readonly asked: string;
  readonly preview: ResetPreview | null;
  readonly problem: string | null;
}

function Consequence({ preview }: { readonly preview: ResetPreview }) {
  const consequence = resetConsequence(preview);
  const reread = consequence.reread.toLocaleString("en-US");
  const skipped = consequence.skipped.toLocaleString("en-US");
  if (!consequence.warning)
    return (
      <p data-testid="reset-consequence" className="rounded border border-line bg-canvas p-cell">
        Every partition moves back or stays: <b>{reread}</b> {nounFor(reread, "message")} will be read again. None are
        skipped.
      </p>
    );
  const forward = partitionList(consequence.forward.map((each) => each.partition));
  return (
    <p data-testid="reset-consequence" data-tone="warning" className="rounded bg-warning/15 p-cell">
      {consequence.forward.length === 1 ? "Partition" : "Partitions"} {forward} move forward:{" "}
      <b className="text-warning">
        {skipped} {nounFor(skipped, "message")} will be skipped
      </b>{" "}
      without being processed.
      {consequence.reread === 0n
        ? null
        : ` ${reread} ${nounFor(reread, "message")} on the other partitions will be read again.`}
    </p>
  );
}

function PreviewTable({ preview, topics }: { readonly preview: ResetPreview; readonly topics: boolean }) {
  const lags = preview.partitions.map((partition) => {
    const high = bigOf(partition.high);
    const current = bigOf(partition.current);
    return high === null || current === null ? null : high - current;
  });
  const after = preview.partitions.map((partition) => bigOf(partition.lagAfter));
  const scale = lagScale([...lags, ...after]);
  const hot = hotLags(lags);
  return (
    <table aria-label="Preview" data-testid="reset-preview" className="w-full">
      <thead className="sticky top-0 bg-canvas text-ink-muted">
        <tr>
          {topics ? <th className={cn(CELL, "text-left font-normal")}>Topic</th> : null}
          <th className={cn(NUMBER_CELL, "font-normal")}>Partition</th>
          <th className={cn(NUMBER_CELL, "font-normal")}>Committed</th>
          <th className={cn(NUMBER_CELL, "font-normal")}>New</th>
          <th className={cn(NUMBER_CELL, "font-normal")}>Change</th>
          <th className={cn(NUMBER_CELL, "font-normal")}>Lag after</th>
          <th className={cn(CELL, "w-1/3 font-normal")}>
            <LagAxis scale={scale} />
          </th>
        </tr>
      </thead>
      <tbody>
        {preview.partitions.map((partition, index) => {
          const change = resetChange(partition);
          return (
            <tr key={`${partition.topic}:${String(partition.partition)}`} className="border-t border-line">
              {topics ? <td className={cn(CELL, "font-grid")}>{partition.topic}</td> : null}
              <td className={NUMBER_CELL}>{partition.partition}</td>
              <td className={NUMBER_CELL}>{grouped(partition.current)}</td>
              <td className={NUMBER_CELL}>{grouped(partition.next)}</td>
              <td className={cn(NUMBER_CELL, change !== null && change > 0n && "text-warning")}>
                {signedCount(change)}
              </td>
              <td className={NUMBER_CELL}>{grouped(partition.lagAfter)}</td>
              <td className={CELL}>
                <LagRuler
                  lag={lags[index] ?? null}
                  scale={scale}
                  hot={hot[index] === true}
                  target={after[index] ?? null}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Refusals and members at the dialog's top (audit m6): the reason a reset cannot apply comes first. */
function Refusal({ request, refusal }: { readonly request: Request; readonly refusal: string | null }) {
  if (refusal === null && request.members.length === 0) return null;
  return (
    <div role="alert" data-testid="reset-refusal" className="flex flex-col gap-1 rounded bg-warning/15 p-cell">
      <p className="flex items-center gap-cell font-semibold text-warning">
        <WarningIcon aria-hidden weight="fill" className="size-icon shrink-0" />
        {refusal ??
          `The group is ${request.state} with ${String(request.members.length)} ${request.members.length === 1 ? "member" : "members"}; Kafka moves offsets only while a group has none.`}
      </p>
      {request.members.length === 0 ? null : (
        <ul data-testid="reset-members" className="flex flex-col font-grid">
          {request.members.map((member, index) => (
            <li key={`${member.clientId}:${String(index)}`}>
              {member.clientId} <span className="text-ink-muted">on {memberHost(member.host)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FIELD_OF: Readonly<
  Partial<
    Record<
      ResetKind,
      { readonly label: string; readonly key: "timestamp" | "offset" | "shift"; readonly placeholder: string }
    >
  >
> = {
  timestamp: { label: "Timestamp", key: "timestamp", placeholder: "2026-11-21 09:00:00" },
  offset: { label: "Offset", key: "offset", placeholder: "1204331" },
  shift: { label: "Shift by", key: "shift", placeholder: "-1000" },
};

const DEFAULT_DRAFT: ResetDraft = { kind: "timestamp", partitions: "", timestamp: "", offset: "", shift: "-1000" };

/**
 * Reset Offsets (plan 164 decision 11): preview per partition, then apply exactly that preview by
 * its token. Enter only previews again; Apply runs on its own click (audit B1), and on a production
 * data source only once the group's name is typed (audit M2).
 */
export function ResetOffsetsDialog({ request }: { readonly request: Request }) {
  const [topic, setTopic] = useState(
    request.initial?.topic ?? (request.topics.length === 1 ? (request.topics[0] ?? ALL_TOPICS) : ALL_TOPICS),
  );
  const [draft, setDraft] = useState<ResetDraft>({ ...DEFAULT_DRAFT, ...request.initial?.draft });
  const [answer, setAnswer] = useState<PreviewAnswer | null>(null);
  const [failed, setFailed] = useState<PreviewAnswer | null>(null);
  const [applying, setApplying] = useState(false);
  const [typed, setTyped] = useState("");
  const [nonce, setNonce] = useState(0);
  const target = useMemo(() => resetTargetOf(draft), [draft]);
  const partitions = parsePartitions(draft.partitions, null);
  const scope = topic === ALL_TOPICS ? null : topic;
  const asked =
    typeof target === "string" || typeof partitions === "string"
      ? null
      : JSON.stringify([scope, partitions, target, nonce]);
  useEffect(() => {
    if (asked === null || typeof target === "string" || typeof partitions === "string") return;
    let current = true;
    const timer = setTimeout(() => {
      request
        .prepare({ topic: scope, partitions }, target)
        .then((preview) => {
          if (current) setAnswer({ asked, preview, problem: null });
        })
        .catch((cause: unknown) => {
          if (current) setAnswer({ asked, preview: null, problem: failureText(cause) });
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `asked` names the scope, partitions, target and nonce the effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, asked]);
  const fresh = answer !== null && answer.asked === asked ? answer : null;
  const preview = fresh?.preview ?? null;
  const unfinished = draft.kind === "timestamp" && draft.timestamp.trim() === "";
  const problem =
    (failed !== null && failed.asked === asked ? failed.problem : null) ??
    (typeof partitions === "string"
      ? partitions
      : typeof target === "string"
        ? unfinished
          ? null
          : target
        : (fresh?.problem ?? null));
  const apply = resetApply(preview, request.lagWarning);
  const production = isProduction(request.datasource);
  const named = !production || typedMatches(typed, request.group);
  const field = FIELD_OF[draft.kind];
  const run = () => {
    if (apply.disabled || !named || preview?.token == null) return;
    const token = preview.token;
    setApplying(true);
    request
      .apply(token)
      .then(() => useStreamDialog.getState().answer(true))
      .catch((cause: unknown) => {
        setFailed({ asked: asked ?? "", preview: null, problem: failureText(cause) });
        setApplying(false);
      });
  };
  return (
    <form
      data-testid="reset-dialog"
      className="flex max-h-[95vh] flex-col gap-gap overflow-auto p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        setNonce(nonce + 1);
      }}
      onKeyDown={onFieldEnter(() => setNonce(nonce + 1))}
    >
      <StreamDialogTitle text={`Reset Offsets of ${request.group}`} datasource={request.datasource} />
      <Dialog.Description className="text-ink-muted">
        {request.state === EMPTY_STATE
          ? "The group is Empty, so its committed offsets can move. Nothing changes until you apply; Enter previews again."
          : "Nothing changes until you apply; Enter previews again."}
      </Dialog.Description>
      <Refusal request={request} refusal={preview?.token === null ? preview.refusal : null} />
      <div className={FIELD_GRID_CLASS}>
        <FieldRow label="Topic">
          {request.topics.length <= 1 ? (
            <span className="font-grid">{request.topics[0] ?? "No committed offsets"}</span>
          ) : (
            <Select
              label="Topic"
              testId="reset-topic"
              value={topic}
              options={[
                { value: ALL_TOPICS, label: "Every Topic" },
                ...request.topics.map((name) => ({ value: name, label: name })),
              ]}
              onChange={setTopic}
            />
          )}
        </FieldRow>
        <FieldRow label="Partitions" htmlFor="reset-partitions">
          <TextInput
            id="reset-partitions"
            data-testid="reset-partitions"
            className="w-40 font-grid"
            placeholder="All"
            aria-invalid={typeof partitions === "string"}
            value={draft.partitions}
            onChange={(event) => setDraft({ ...draft, partitions: event.target.value })}
          />
        </FieldRow>
        <FieldRow label="Reset to">
          <Segmented<ResetKind>
            name="reset-to"
            label="Reset to"
            testId="reset-kind"
            options={RESET_KINDS.map((kind) => ({ value: kind, label: RESET_KIND_LABELS[kind] }))}
            value={draft.kind}
            onChange={(kind) => setDraft({ ...draft, kind })}
          />
        </FieldRow>
        {field === undefined ? null : (
          <FieldRow label={field.label} htmlFor="reset-value">
            <TextInput
              id="reset-value"
              data-testid="reset-value"
              className="w-60 font-grid"
              placeholder={field.placeholder}
              value={draft[field.key]}
              onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
            />
            {draft.kind === "timestamp" ? <TimestampHint typed={draft.timestamp} /> : null}
          </FieldRow>
        )}
      </div>
      {preview === null || preview.partitions.length === 0 ? null : (
        <div className="max-h-96 overflow-auto rounded border border-line bg-canvas">
          <PreviewTable preview={preview} topics={topic === ALL_TOPICS && request.topics.length > 1} />
        </div>
      )}
      {preview === null || preview.token === null ? null : <Consequence preview={preview} />}
      {problem === null ? null : (
        <p role="alert" className="break-words text-danger">
          {problem}
        </p>
      )}
      {production && preview?.token != null ? (
        <label className="flex flex-col gap-1">
          <span>
            Type <b className="font-grid">{request.group}</b> to apply on a production data source
          </span>
          <TextInput
            data-testid="reset-typed-name"
            className="font-grid"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      ) : null}
      <DialogFooter
        start={
          preview?.token == null ? undefined : (
            <span className="font-grid text-ink-muted">
              Preview {preview.token.slice(0, TOKEN_PREFIX_CHARS)} · valid while the group stays {request.state}
            </span>
          )
        }
      >
        <Button onClick={() => useStreamDialog.getState().answer(false)}>Cancel</Button>
        <Button
          data-testid="reset-apply"
          variant={apply.variant}
          disabled={apply.disabled || applying || !named}
          title={apply.reason ?? (named ? undefined : `Type ${request.group} to apply.`)}
          onClick={run}
        >
          {apply.label}
        </Button>
      </DialogFooter>
    </form>
  );
}
