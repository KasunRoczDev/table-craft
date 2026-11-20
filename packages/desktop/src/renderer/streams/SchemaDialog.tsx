import * as Dialog from "@radix-ui/react-dialog";
import { useState } from "react";
import { SCHEMA_TYPES, type CompatibilityCheck, type SchemaType } from "@table-craft/desktop/engine/protocol.js";
import { Button, DialogFooter, Select } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { StreamDialogTitle } from "@table-craft/desktop/renderer/streams/DialogTitle.js";
import {
  failureText,
  useStreamDialog,
  type StreamDialogRequest,
} from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { CodeField } from "@table-craft/desktop/renderer/ui/CodeField.js";

type Request = Extract<StreamDialogRequest, { kind: "schema" }>;

const TYPE_LABELS: Readonly<Record<SchemaType, string>> = { AVRO: "Avro", PROTOBUF: "Protobuf", JSON: "JSON Schema" };

/**
 * Check Compatibility… and Register New Version… of a subject (plan 164 Phase 6): the schema
 * pasted, the registry's verdict and messages shown in place. Register checks first, and writes
 * only on its own click.
 */
export function SchemaDialog({ request }: { readonly request: Request }) {
  const [type, setType] = useState<SchemaType>(request.type);
  const [schema, setSchema] = useState(request.initial);
  const [verdict, setVerdict] = useState<CompatibilityCheck | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    setNote(null);
    try {
      await work();
    } catch (cause) {
      setProblem(failureText(cause));
    } finally {
      setBusy(false);
    }
  };
  const check = () =>
    run(async () => {
      setVerdict(await request.check(type, schema));
    });
  const register = () =>
    run(async () => {
      const registered = await request.register(type, schema);
      useStreamDialog.getState().changed();
      setNote(
        `Registered schema id ${String(registered.id)}${registered.version === null ? "" : ` as version ${String(registered.version)}`}.`,
      );
    });
  const title =
    request.mode === "check"
      ? `Check Compatibility of ${request.subject}`
      : `Register New Version of ${request.subject}`;
  return (
    <form
      data-testid="schema-dialog"
      className="flex max-h-[95vh] flex-col gap-gap overflow-auto p-gap"
      onSubmit={(event) => event.preventDefault()}
    >
      <StreamDialogTitle text={title} datasource={request.datasource} />
      <Dialog.Description className="text-ink-muted">
        Paste the schema; the registry checks it against the subject&apos;s compatibility level.
      </Dialog.Description>
      <Select
        label="Schema type"
        className="w-48"
        value={type}
        options={SCHEMA_TYPES.map((value) => ({ value, label: TYPE_LABELS[value] }))}
        onChange={(value) => setType(value as SchemaType)}
      />
      <CodeField label="Schema" testId="schema-text" className="h-64" text={schema} onChange={setSchema} />
      {verdict === null ? null : (
        <div role="status" data-testid="schema-verdict" className={verdict.compatible ? "text-success" : "text-danger"}>
          {verdict.compatible ? "Compatible." : "Not compatible:"}
          <ul className="font-grid">
            {verdict.messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {problem === null ? null : (
        <p role="alert" data-testid="schema-error" className="break-words text-danger">
          {problem}
        </p>
      )}
      {note === null ? null : (
        <p role="status" className="text-success">
          {note}
        </p>
      )}
      <DialogFooter>
        <Button onClick={() => useStreamDialog.getState().answer(false)}>Close</Button>
        <Button
          variant={request.mode === "check" ? "primary" : "secondary"}
          disabled={busy}
          onClick={() => void check()}
        >
          Check
        </Button>
        {request.mode === "register" ? (
          <Button variant="primary" data-testid="schema-register" disabled={busy} onClick={() => void register()}>
            Register
          </Button>
        ) : null}
      </DialogFooter>
    </form>
  );
}
