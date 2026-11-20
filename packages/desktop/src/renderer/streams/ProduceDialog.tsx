import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import {
  MESSAGE_FORMATS,
  type MessageFormat,
  type ProduceRecord,
  type SchemaReference,
  type SchemaType,
} from "@table-craft/desktop/engine/protocol.js";
import {
  Button,
  DialogFooter,
  FIELD_GRID_CLASS,
  FieldRow,
  Select,
  TextInput,
} from "@table-craft/desktop/renderer/dialogs/parts.js";
import { MESSAGE_FORMAT_LABELS } from "@table-craft/desktop/renderer/model/topicRead.js";
import {
  failureText,
  useStreamDialog,
  type ProduceDraft,
  type ProduceSchema,
  type StreamDialogRequest,
} from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { ICON_BUTTON } from "@table-craft/desktop/renderer/ui/iconButtonClasses.js";
import { CloseIcon } from "@table-craft/desktop/renderer/ui/icons.js";
import { CodeField } from "@table-craft/desktop/renderer/ui/CodeField.js";
import { prettyJson } from "@table-craft/desktop/renderer/model/prettyJson.js";
import { parsesAsJson } from "@table-craft/desktop/renderer/model/jsonText.js";
import { StreamDialogTitle } from "@table-craft/desktop/renderer/streams/DialogTitle.js";

type Request = Extract<StreamDialogRequest, { kind: "produce" }>;

/** Formats that need the Schema Registry (decision 7); offered only while it answers. */
const REGISTRY_FORMATS: ReadonlySet<MessageFormat> = new Set(["avro", "protobuf", "jsonSchema"]);

function formatOptions(registry: boolean) {
  return MESSAGE_FORMATS.filter((format) => format !== "auto" && (registry || !REGISTRY_FORMATS.has(format))).map(
    (format) => ({ value: format, label: MESSAGE_FORMAT_LABELS[format] }),
  );
}

/** A registry format's subject, `<topic>-value` by default, and its version, latest when blank. */
function schemaOf(format: MessageFormat, subject: string, version: string): SchemaReference | null | string {
  if (!REGISTRY_FORMATS.has(format)) return null;
  const trimmed = version.trim();
  if (subject.trim() === "") return "Name the subject the schema is registered under.";
  if (trimmed !== "" && !/^\d+$/.test(trimmed)) return "A version is a whole number, or blank for the latest.";
  return { subject: subject.trim(), version: trimmed === "" ? null : Number(trimmed) };
}

/** The record the dialog's fields describe, or what to fix first. */
export function produceRecordOf(
  topic: string,
  draft: ProduceDraft,
  subjects: {
    readonly key: string;
    readonly value: string;
    readonly keyVersion: string;
    readonly valueVersion: string;
  },
): ProduceRecord | string {
  const partition = draft.partition.trim();
  if (partition !== "" && !/^\d+$/.test(partition)) return "Partition is a number, or blank to let the key choose.";
  const keySchema = schemaOf(draft.keyFormat, subjects.key, subjects.keyVersion);
  if (typeof keySchema === "string") return keySchema;
  const valueSchema = schemaOf(draft.valueFormat, subjects.value, subjects.valueVersion);
  if (typeof valueSchema === "string") return valueSchema;
  const unnamed = draft.headers.find((header) => header.name.trim() === "" && header.value !== "");
  if (unnamed !== undefined) return "Every header needs a name.";
  return {
    topic,
    partition: partition === "" ? null : Number(partition),
    key: draft.key === "" ? null : draft.key,
    value: draft.value,
    headers: draft.headers
      .filter((header) => header.name.trim() !== "")
      .map((header) => ({ name: header.name.trim(), value: header.value })),
    keyFormat: draft.keyFormat,
    valueFormat: draft.valueFormat,
    keySchema,
    valueSchema,
  };
}

const SCHEMA_FORMATS: Readonly<Record<SchemaType, MessageFormat>> = {
  AVRO: "avro",
  PROTOBUF: "protobuf",
  JSON: "jsonSchema",
};
const SCHEMA_TYPE_NAMES: Readonly<Record<SchemaType, string>> = {
  AVRO: "Avro",
  PROTOBUF: "Protobuf",
  JSON: "JSON Schema",
};

/** The format a value schema's type is sent in. */
export function formatOfSchema(schema: ProduceSchema): MessageFormat {
  return SCHEMA_FORMATS[schema.type];
}

/** `Value schema: orders.v1-value v2 (Avro)`, or `latest` for no pinned version. */
export function valueSchemaText(schema: ProduceSchema): string {
  const version = schema.version === null ? "latest" : `v${String(schema.version)}`;
  return `Value schema: ${schema.subject} ${version} (${SCHEMA_TYPE_NAMES[schema.type]})`;
}

/**
 * Produce Message (plan 164 decision 13): one record, its partition and offset reported where it
 * was sent. Send runs on its own click only, never on Enter in a field (audit B1); a send marks the
 * dialog changed, so closing it after one reads the topic again (audit m9).
 */
export function ProduceDialog({ request }: { readonly request: Request }) {
  const schema = request.valueSchema;
  const [draft, setDraft] = useState<ProduceDraft>(
    schema === null ? request.initial : { ...request.initial, valueFormat: formatOfSchema(schema) },
  );
  const [subjects, setSubjects] = useState({
    key: `${request.topic}-key`,
    value: schema?.subject ?? `${request.topic}-value`,
    keyVersion: "",
    valueVersion: schema?.version === null || schema === null ? "" : String(schema.version),
  });
  const [sent, setSent] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const options = formatOptions(request.registry);
  const change = (next: Partial<ProduceDraft>) => {
    setDraft({ ...draft, ...next });
    setSent(null);
  };
  const send = () => {
    const record = produceRecordOf(request.topic, draft, subjects);
    if (typeof record === "string") {
      setProblem(record);
      return;
    }
    setSending(true);
    setProblem(null);
    request
      .send(record)
      .then((result) => {
        useStreamDialog.getState().changed();
        setSent(
          `Sent to partition ${String(result.partition)}${result.offset === null ? "" : ` at offset ${BigInt(result.offset).toLocaleString("en-US")}`}`,
        );
      })
      .catch((cause: unknown) => setProblem(failureText(cause)))
      .finally(() => setSending(false));
  };
  const formatJson = () => {
    if (parsesAsJson(draft.value)) change({ value: prettyJson(draft.value) });
    else setProblem("The value is not JSON, so it cannot be formatted.");
  };
  return (
    <form
      data-testid="produce-dialog"
      className="flex max-h-[95vh] flex-col gap-gap overflow-auto p-gap"
      onSubmit={(event) => event.preventDefault()}
    >
      <StreamDialogTitle text={`Produce Message to ${request.topic}`} datasource={request.datasource} />
      <Dialog.Description className="sr-only">One record, sent once; nothing is retried.</Dialog.Description>
      <div className={FIELD_GRID_CLASS}>
        <FieldRow label="Partition" htmlFor="produce-partition">
          <TextInput
            id="produce-partition"
            data-testid="produce-partition"
            className="w-32 font-grid"
            placeholder="Auto"
            value={draft.partition}
            onChange={(event) => change({ partition: event.target.value })}
          />
          {request.partitions === null ? null : <span className="text-ink-muted">of {request.partitions}</span>}
        </FieldRow>
        <FieldRow label="Key format">
          <Select
            label="Key format"
            testId="produce-key-format"
            value={draft.keyFormat}
            options={options}
            onChange={(value) => change({ keyFormat: value as MessageFormat })}
          />
          {REGISTRY_FORMATS.has(draft.keyFormat) ? (
            <>
              <TextInput
                aria-label="Key subject"
                className="min-w-0 flex-1 font-grid"
                value={subjects.key}
                onChange={(event) => setSubjects({ ...subjects, key: event.target.value })}
              />
              <TextInput
                aria-label="Key schema version"
                className="w-20 font-grid"
                placeholder="latest"
                value={subjects.keyVersion}
                onChange={(event) => setSubjects({ ...subjects, keyVersion: event.target.value })}
              />
            </>
          ) : null}
        </FieldRow>
        <FieldRow label="Key" htmlFor="produce-key">
          <TextInput
            id="produce-key"
            data-testid="produce-key"
            className="min-w-0 flex-1 font-grid"
            placeholder="No key"
            value={draft.key}
            onChange={(event) => change({ key: event.target.value })}
          />
        </FieldRow>
        <FieldRow label="Value format">
          <Select
            label="Value format"
            testId="produce-value-format"
            value={draft.valueFormat}
            options={options}
            onChange={(value) => change({ valueFormat: value as MessageFormat })}
          />
          {REGISTRY_FORMATS.has(draft.valueFormat) ? (
            <>
              <TextInput
                aria-label="Value subject"
                data-testid="produce-value-subject"
                className="min-w-0 flex-1 font-grid"
                value={subjects.value}
                onChange={(event) => setSubjects({ ...subjects, value: event.target.value })}
              />
              <TextInput
                aria-label="Value schema version"
                data-testid="produce-value-version"
                className="w-20 font-grid"
                placeholder="latest"
                value={subjects.valueVersion}
                onChange={(event) => setSubjects({ ...subjects, valueVersion: event.target.value })}
              />
            </>
          ) : null}
        </FieldRow>
      </div>
      {schema === null ? null : (
        <p data-testid="produce-value-schema" className="text-ink-muted">
          {valueSchemaText(schema)}
        </p>
      )}
      <div className="flex items-center gap-gap">
        <span className="text-ink-muted">Value</span>
        <span className="flex-1" />
        <Button onClick={formatJson}>Format JSON</Button>
      </div>
      <CodeField
        label="Value"
        testId="produce-value"
        className="max-h-80"
        text={draft.value}
        onChange={(value) => change({ value })}
      />
      <div className="flex flex-col gap-1">
        <span className="text-ink-muted">Headers</span>
        {draft.headers.map((header, index) => (
          <div key={index} className="flex items-center gap-cell">
            <TextInput
              aria-label={`Header ${String(index + 1)} name`}
              className="w-48 font-grid"
              placeholder="name"
              value={header.name}
              onChange={(event) =>
                change({
                  headers: draft.headers.map((each, at) =>
                    at === index ? { ...each, name: event.target.value } : each,
                  ),
                })
              }
            />
            <TextInput
              aria-label={`Header ${String(index + 1)} value`}
              className="min-w-0 flex-1 font-grid"
              placeholder="value"
              value={header.value}
              onChange={(event) =>
                change({
                  headers: draft.headers.map((each, at) =>
                    at === index ? { ...each, value: event.target.value } : each,
                  ),
                })
              }
            />
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label={`Remove header ${String(index + 1)}`}
              onClick={() => change({ headers: draft.headers.filter((_, at) => at !== index) })}
            >
              <CloseIcon aria-hidden className="size-icon" />
            </button>
          </div>
        ))}
        <span>
          <Button onClick={() => change({ headers: [...draft.headers, { name: "", value: "" }] })}>Add Header</Button>
        </span>
      </div>
      {problem === null ? null : (
        <p role="alert" data-testid="produce-error" className="break-words text-danger">
          {problem}
        </p>
      )}
      <DialogFooter
        start={
          sent === null ? undefined : (
            <span role="status" data-testid="produce-sent" className="text-success">
              {sent}
            </span>
          )
        }
      >
        <Button onClick={() => useStreamDialog.getState().answer(false)}>Close</Button>
        <Button variant="primary" data-testid="produce-send" disabled={sending} onClick={send}>
          Send
        </Button>
      </DialogFooter>
    </form>
  );
}
