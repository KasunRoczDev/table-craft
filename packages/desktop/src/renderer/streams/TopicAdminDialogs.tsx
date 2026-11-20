import * as Dialog from "@radix-ui/react-dialog";
import { useState, type ReactNode } from "react";
import type { DeleteRecordsPreview } from "@table-craft/desktop/engine/protocol.js";
import {
  Button,
  DialogFooter,
  FIELD_GRID_CLASS,
  FieldRow,
  Select,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import { grouped } from "@table-craft/desktop/renderer/model/groupLag.js";
import {
  collidingTopic,
  COMMON_TOPIC_CONFIGS,
  configChangesOf,
  deleteRecordsNeedsName,
  partitionTotalOf,
  RECORDS_BEFORE_KINDS,
  RECORDS_BEFORE_LABELS,
  recordsBeforeOf,
  topicCreateOf,
  typedMatches,
  type ConfigEdit,
  type ConfigRow,
  type RecordsBeforeKind,
} from "@table-craft/desktop/renderer/model/topicAdmin.js";
import { durationText, parsePartitions } from "@table-craft/desktop/renderer/model/topicRead.js";
import { StreamDialogTitle } from "@table-craft/desktop/renderer/streams/DialogTitle.js";
import {
  failureText,
  useStreamDialog,
  type DialogDatasource,
  type StreamDialogRequest,
} from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { TimestampHint } from "@table-craft/desktop/renderer/streams/TimestampHint.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { onFieldEnter } from "@table-craft/desktop/renderer/streams/enterKey.js";
import { ICON_BUTTON } from "@table-craft/desktop/renderer/ui/iconButtonClasses.js";
import { CloseIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { Segmented } from "@table-craft/desktop/renderer/ui/Segmented.js";

type RequestOf<K extends StreamDialogRequest["kind"]> = Extract<StreamDialogRequest, { kind: K }>;

const CELL = "h-row px-gap whitespace-nowrap first:pl-cell last:pr-cell";
const NUMBER_CELL = cn(CELL, "text-right font-grid tabular-nums");
const SENSITIVE_MASK = "••••••";
const OTHER_CONFIG = "";
const NAME_HINT = "Letters, digits, '.', '_' and '-', at most 249 characters.";

/** A refusal or a validation's answer, said in place under the fields. */
function Outcome({ problem, note }: { readonly problem: string | null; readonly note: string | null }) {
  if (problem !== null)
    return (
      <p role="alert" data-testid="stream-dialog-error" className="break-words text-danger">
        {problem}
      </p>
    );
  if (note !== null)
    return (
      <p role="status" className="text-success">
        {note}
      </p>
    );
  return null;
}

/**
 * The shared run of a write dialog (decision 12): Validate asks the broker with `validateOnly`,
 * the primary button applies once, and either's refusal stays in the dialog. Nothing is retried.
 */
function useWrite() {
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function attempt(run: () => Promise<void>, validated: string | null): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await run();
      if (validated !== null) setNote(validated);
      return true;
    } catch (cause) {
      setProblem(failureText(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { problem, note, busy, setProblem, attempt };
}

/**
 * A write dialog's frame. `onEnter` is what Enter in a field does: a dialog that applies on its
 * own (Create Topic) submits, one that previews first only previews (audit B1).
 */
function Frame({
  title,
  datasource,
  testId,
  children,
  footer,
  onEnter,
}: {
  readonly title: string;
  readonly datasource: DialogDatasource;
  readonly testId: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
  readonly onEnter: () => void;
}) {
  return (
    <form
      data-testid={testId}
      className="flex max-h-[95vh] flex-col gap-gap overflow-auto p-gap"
      onSubmit={(event) => {
        event.preventDefault();
        onEnter();
      }}
      onKeyDown={onFieldEnter(onEnter)}
    >
      <StreamDialogTitle text={title} datasource={datasource} />
      {children}
      <DialogFooter>{footer}</DialogFooter>
    </form>
  );
}

const cancel = () => useStreamDialog.getState().answer(false);
const done = () => useStreamDialog.getState().answer(true);

const CONFIG_OPTIONS = [
  ...COMMON_TOPIC_CONFIGS.map((name) => ({ value: name, label: name })),
  { value: OTHER_CONFIG, label: "Other…" },
];

function ConfigRows({
  rows,
  onChange,
}: {
  readonly rows: readonly ConfigRow[];
  readonly onChange: (rows: readonly ConfigRow[]) => void;
}) {
  const [other, setOther] = useState<ReadonlySet<number>>(new Set());
  const set = (index: number, change: Partial<ConfigRow>) =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  return (
    <div className="flex flex-col gap-1">
      <span className="text-ink-muted">Configs</span>
      {rows.map((row, index) => {
        const typed = other.has(index) || !(COMMON_TOPIC_CONFIGS as readonly string[]).includes(row.name);
        return (
          <div key={index} className="flex items-center gap-cell">
            <Select
              label={`Config ${String(index + 1)}`}
              className="w-56"
              value={typed ? OTHER_CONFIG : row.name}
              options={CONFIG_OPTIONS}
              onChange={(name) => {
                setOther(new Set([...other].filter((at) => at !== index || name === OTHER_CONFIG)));
                if (name === OTHER_CONFIG) setOther(new Set([...other, index]));
                set(index, { name });
              }}
            />
            {typed ? (
              <TextInput
                aria-label={`Config ${String(index + 1)} name`}
                className="w-48 font-grid"
                placeholder="name"
                value={row.name}
                onChange={(event) => set(index, { name: event.target.value })}
              />
            ) : null}
            <TextInput
              aria-label={`Config ${String(index + 1)} value`}
              className="min-w-0 flex-1 font-grid"
              placeholder="value"
              value={row.value}
              onChange={(event) => set(index, { value: event.target.value })}
            />
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={`Remove config ${String(index + 1)}`}
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <CloseIcon aria-hidden className="size-icon" />
            </button>
          </div>
        );
      })}
      <span>
        <Button onClick={() => onChange([...rows, { name: COMMON_TOPIC_CONFIGS[1], value: "" }])}>Add Config</Button>
      </span>
    </div>
  );
}

export function CreateTopicDialog({ request }: { readonly request: RequestOf<"createTopic"> }) {
  const [fields, setFields] = useState<{
    name: string;
    partitions: string;
    replication: string;
    configs: readonly ConfigRow[];
  }>({ name: "", partitions: "1", replication: "", configs: [] });
  const write = useWrite();
  const collision = collidingTopic(fields.name.trim(), request.existing);
  const submit = (validateOnly: boolean) => {
    const asked = topicCreateOf(fields);
    if (typeof asked === "string") {
      write.setProblem(asked);
      return;
    }
    void write
      .attempt(
        () => request.create(asked, validateOnly),
        validateOnly ? `The broker would create ${asked.name}.` : null,
      )
      .then((ok) => {
        if (ok && !validateOnly) done();
      });
  };
  return (
    <Frame
      title="Create Topic"
      datasource={request.datasource}
      testId="create-topic-dialog"
      onEnter={() => submit(false)}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button disabled={write.busy} onClick={() => submit(true)}>
            Validate
          </Button>
          <Button type="submit" variant="primary" data-testid="create-topic-apply" disabled={write.busy}>
            Create
          </Button>
        </>
      }
    >
      <Dialog.Description className="sr-only">
        A new topic, checked by the broker before it is created.
      </Dialog.Description>
      <div className={FIELD_GRID_CLASS}>
        <FieldRow label="Name" htmlFor="topic-name" hint={NAME_HINT}>
          <TextInput
            id="topic-name"
            data-testid="create-topic-name"
            className="min-w-0 flex-1 font-grid"
            value={fields.name}
            onChange={(event) => setFields({ ...fields, name: event.target.value })}
          />
        </FieldRow>
        <FieldRow label="Partitions" htmlFor="topic-partitions">
          <TextInput
            id="topic-partitions"
            className="w-24 font-grid"
            inputMode="numeric"
            value={fields.partitions}
            onChange={(event) => setFields({ ...fields, partitions: event.target.value })}
          />
        </FieldRow>
        <FieldRow label="Replication" htmlFor="topic-replication">
          <TextInput
            id="topic-replication"
            className="w-24 font-grid"
            inputMode="numeric"
            placeholder="Default"
            value={fields.replication}
            onChange={(event) => setFields({ ...fields, replication: event.target.value })}
          />
        </FieldRow>
      </div>
      {collision === null ? null : (
        <p role="alert" className="text-warning">
          Kafka&apos;s metrics read &apos;.&apos; as &apos;_&apos;, so this name collides with {collision}.
        </p>
      )}
      <ConfigRows rows={fields.configs} onChange={(configs) => setFields({ ...fields, configs })} />
      <Outcome problem={write.problem} note={write.note} />
    </Frame>
  );
}

/** `604800000` and, for a `.ms` config, `7 d` beside it. */
function configValueText(name: string, value: string | null): string {
  const duration = name.endsWith(".ms") ? durationText(value) : null;
  return duration === null ? (value ?? "") : `${value ?? ""} (${duration})`;
}

export function EditConfigsDialog({ request }: { readonly request: RequestOf<"configs"> }) {
  const [edits, setEdits] = useState<Readonly<Record<string, ConfigEdit>>>({});
  const [search, setSearch] = useState("");
  const write = useWrite();
  const changes = configChangesOf(request.configs, edits);
  const shown = request.configs.filter((entry) => entry.name.includes(search.trim()));
  const before = new Map(request.configs.map((entry) => [entry.name, entry.value]));
  const submit = (validateOnly: boolean) => {
    void write
      .attempt(
        () => request.alter(changes, validateOnly),
        validateOnly
          ? `The broker would take ${String(changes.length)} ${changes.length === 1 ? "change" : "changes"}.`
          : null,
      )
      .then((ok) => {
        if (ok && !validateOnly) done();
      });
  };
  return (
    <Frame
      title={`Edit Configs of ${request.topic}`}
      datasource={request.datasource}
      testId="edit-configs-dialog"
      onEnter={() => undefined}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button disabled={write.busy || changes.length === 0} onClick={() => submit(true)}>
            Validate
          </Button>
          <Button
            variant="primary"
            data-testid="edit-configs-apply"
            disabled={write.busy || changes.length === 0}
            onClick={() => submit(false)}
          >
            {changes.length === 0
              ? "Apply"
              : `Apply ${String(changes.length)} ${changes.length === 1 ? "Change" : "Changes"}`}
          </Button>
        </>
      }
    >
      <Dialog.Description className="text-ink-muted">
        Only the entries you edit change; Reset to Default removes the topic&apos;s own value.
      </Dialog.Description>
      <TextInput
        aria-label="Search configs"
        data-testid="configs-search"
        className="w-64"
        placeholder="Search configs"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="max-h-80 overflow-auto rounded border border-line bg-canvas">
        <table aria-label="Configs" className="w-full">
          <thead className="sticky top-0 bg-canvas text-ink-muted">
            <tr>
              <th className={cn(CELL, "text-left font-normal")}>Name</th>
              <th className={cn(CELL, "text-left font-normal")}>Value</th>
              <th className={cn(CELL, "text-left font-normal")}>Source</th>
              <th className={cn(CELL, "font-normal")} />
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => {
              const edit = edits[entry.name];
              const editable = !entry.readOnly && !entry.sensitive;
              return (
                <tr key={entry.name} className="border-t border-line" title={entry.documentation ?? undefined}>
                  <td className={cn(CELL, "font-grid")}>{entry.name}</td>
                  <td className={CELL}>
                    {edit?.kind === "set" ? (
                      <TextInput
                        aria-label={entry.name}
                        autoFocus
                        className="w-full font-grid"
                        value={edit.value}
                        onChange={(event) =>
                          setEdits({ ...edits, [entry.name]: { kind: "set", value: event.target.value } })
                        }
                      />
                    ) : (
                      <span className={cn("font-grid", edit?.kind === "reset" && "text-ink-muted line-through")}>
                        {entry.sensitive ? SENSITIVE_MASK : configValueText(entry.name, entry.value)}
                        {entry.readOnly ? <span className="ml-cell text-ink-muted">read-only</span> : null}
                      </span>
                    )}
                  </td>
                  <td className={cn(CELL, entry.isDefault ? "text-ink-muted" : "")}>{entry.source}</td>
                  <td className={cn(CELL, "text-right")}>
                    {!editable ? null : edit === undefined ? (
                      <span className="flex justify-end gap-cell">
                        <Button
                          onClick={() =>
                            setEdits({ ...edits, [entry.name]: { kind: "set", value: entry.value ?? "" } })
                          }
                        >
                          Edit
                        </Button>
                        {entry.isDefault ? null : (
                          <Button onClick={() => setEdits({ ...edits, [entry.name]: { kind: "reset" } })}>
                            Reset to Default
                          </Button>
                        )}
                      </span>
                    ) : (
                      <Button
                        onClick={() => {
                          const { [entry.name]: _undone, ...rest } = edits;
                          setEdits(rest);
                        }}
                      >
                        Undo
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {changes.length === 0 ? null : (
        <div data-testid="configs-changes" className="flex flex-col gap-1">
          <span className="text-ink-muted">Changes</span>
          <ul className="flex flex-col font-grid">
            {changes.map((change) => (
              <li key={change.name}>
                {change.name}: {configValueText(change.name, before.get(change.name) ?? null)} →{" "}
                {change.value === null ? "default" : configValueText(change.name, change.value)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Outcome problem={write.problem} note={write.note} />
    </Frame>
  );
}

export function AddPartitionsDialog({ request }: { readonly request: RequestOf<"addPartitions"> }) {
  const [total, setTotal] = useState(String(request.current + 1));
  const write = useWrite();
  const submit = (validateOnly: boolean) => {
    const asked = partitionTotalOf(total, request.current);
    if (typeof asked === "string") {
      write.setProblem(asked);
      return;
    }
    void write
      .attempt(
        () => request.add(asked, validateOnly),
        validateOnly ? `The broker would raise it to ${String(asked)}.` : null,
      )
      .then((ok) => {
        if (ok && !validateOnly) done();
      });
  };
  return (
    <Frame
      title={`Add Partitions to ${request.topic}`}
      datasource={request.datasource}
      testId="add-partitions-dialog"
      onEnter={() => submit(true)}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button disabled={write.busy} onClick={() => submit(true)}>
            Validate
          </Button>
          <Button
            variant="warning"
            data-testid="add-partitions-apply"
            disabled={write.busy}
            onClick={() => submit(false)}
          >
            Add Partitions
          </Button>
        </>
      }
    >
      <Dialog.Description className="rounded bg-warning/15 p-cell">
        Producers map a key to a partition by the partition count, so after this new messages of an existing key can
        land on another partition, out of order with its older ones.
      </Dialog.Description>
      <div className={FIELD_GRID_CLASS}>
        <FieldRow label="Now">
          <span className="font-grid">{request.current}</span>
        </FieldRow>
        <FieldRow label="New total" htmlFor="partition-total">
          <TextInput
            id="partition-total"
            data-testid="add-partitions-total"
            className="w-24 font-grid"
            inputMode="numeric"
            value={total}
            onChange={(event) => setTotal(event.target.value)}
          />
        </FieldRow>
      </div>
      <Outcome problem={write.problem} note={write.note} />
    </Frame>
  );
}

/**
 * Delete Records: Enter only previews (audit B1); once a preview would delete anything, Delete
 * runs on its own click and only with the topic's name typed (audit B2).
 */
export function DeleteRecordsDialog({ request }: { readonly request: RequestOf<"deleteRecords"> }) {
  const [partitions, setPartitions] = useState("");
  const [kind, setKind] = useState<RecordsBeforeKind>("offset");
  const [boundary, setBoundary] = useState("");
  const [preview, setPreview] = useState<DeleteRecordsPreview | null>(null);
  const [typed, setTyped] = useState("");
  const write = useWrite();
  const prepare = () => {
    const chosen = parsePartitions(partitions, request.partitions);
    if (typeof chosen === "string") {
      write.setProblem(chosen);
      return;
    }
    const before = recordsBeforeOf(kind, boundary);
    if (typeof before === "string") {
      write.setProblem(before);
      return;
    }
    void write.attempt(async () => setPreview(await request.prepare(chosen, before)), null);
  };
  const removed = preview === null ? null : grouped(preview.removed);
  const needsName = preview !== null && deleteRecordsNeedsName(preview.removed);
  const named = typedMatches(typed, request.topic);
  const stale = () => {
    setPreview(null);
    setTyped("");
  };
  return (
    <Frame
      title={`Delete Records of ${request.topic}`}
      datasource={request.datasource}
      testId="delete-records-dialog"
      onEnter={prepare}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant={preview === null ? "primary" : "secondary"} disabled={write.busy} onClick={prepare}>
            Preview
          </Button>
          {preview === null ? null : (
            <Button
              variant="danger"
              data-testid="delete-records-apply"
              disabled={write.busy || !needsName || !named}
              title={needsName && !named ? `Type ${request.topic} to delete.` : undefined}
              onClick={() => {
                const token = preview.token;
                void write
                  .attempt(() => request.apply(token), null)
                  .then((ok) => {
                    if (ok) done();
                  });
              }}
            >
              Delete {removed} Records
            </Button>
          )}
        </>
      }
    >
      <Dialog.Description className="text-ink-muted">
        Moves each partition&apos;s low watermark up; the records before it are gone for every consumer. Enter previews.
      </Dialog.Description>
      <div className={FIELD_GRID_CLASS}>
        <FieldRow label="Partitions" htmlFor="delete-partitions">
          <TextInput
            id="delete-partitions"
            data-testid="delete-partitions"
            className="w-48 font-grid"
            placeholder="All"
            value={partitions}
            onChange={(event) => {
              setPartitions(event.target.value);
              stale();
            }}
          />
        </FieldRow>
        <FieldRow label="Before">
          <Segmented<RecordsBeforeKind>
            name="delete-before"
            label="Before"
            testId="delete-before"
            options={RECORDS_BEFORE_KINDS.map((value) => ({ value, label: RECORDS_BEFORE_LABELS[value] }))}
            value={kind}
            onChange={(value) => {
              setKind(value);
              stale();
            }}
          />
        </FieldRow>
        {kind === "latest" ? null : (
          <FieldRow label={RECORDS_BEFORE_LABELS[kind]} htmlFor="delete-boundary">
            <TextInput
              id="delete-boundary"
              data-testid="delete-boundary"
              className="w-56 font-grid"
              placeholder={kind === "offset" ? "1204331" : "2026-11-21 09:00:00"}
              value={boundary}
              onChange={(event) => {
                setBoundary(event.target.value);
                stale();
              }}
            />
            {kind === "timestamp" ? <TimestampHint typed={boundary} /> : null}
          </FieldRow>
        )}
      </div>
      {preview === null ? null : (
        <div className="max-h-80 overflow-auto rounded border border-line bg-canvas">
          <table aria-label="Records to delete" data-testid="delete-records-preview" className="w-full">
            <thead className="sticky top-0 bg-canvas text-ink-muted">
              <tr>
                <th className={cn(NUMBER_CELL, "font-normal")}>Partition</th>
                <th className={cn(NUMBER_CELL, "font-normal")}>Low watermark</th>
                <th className={cn(NUMBER_CELL, "font-normal")}>New low</th>
                <th className={cn(NUMBER_CELL, "font-normal")}>High watermark</th>
                <th className={cn(NUMBER_CELL, "font-normal")}>Deleted</th>
              </tr>
            </thead>
            <tbody>
              {preview.partitions.map((partition) => (
                <tr key={partition.partition} className="border-t border-line">
                  <td className={NUMBER_CELL}>{partition.partition}</td>
                  <td className={NUMBER_CELL}>{grouped(partition.low)}</td>
                  <td className={NUMBER_CELL}>{grouped(partition.newLow)}</td>
                  <td className={NUMBER_CELL}>{grouped(partition.high)}</td>
                  <td className={cn(NUMBER_CELL, "text-danger")}>{grouped(partition.removed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {preview === null ? null : needsName ? (
        <label className="flex flex-col gap-1">
          <span>
            Type <b className="font-grid">{request.topic}</b> to delete {removed} records
          </span>
          <TextInput
            data-testid="delete-records-typed-name"
            className="font-grid"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </label>
      ) : (
        <p className="text-ink-muted">Nothing lies before that boundary, so nothing would be deleted.</p>
      )}
      <Outcome problem={write.problem} note={write.note} />
    </Frame>
  );
}
