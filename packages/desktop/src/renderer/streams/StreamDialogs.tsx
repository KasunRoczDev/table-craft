import * as Dialog from "@radix-ui/react-dialog";
import { CONTENT_CLASS, OVERLAY_CLASS } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { useStreamDialog, type StreamDialogRequest } from "@table-craft/desktop/renderer/streams/dialogStore.js";
import { ProduceDialog } from "@table-craft/desktop/renderer/streams/ProduceDialog.js";
import { ResetOffsetsDialog } from "@table-craft/desktop/renderer/streams/ResetOffsetsDialog.js";
import {
  AddPartitionsDialog,
  CreateTopicDialog,
  DeleteRecordsDialog,
  EditConfigsDialog,
} from "@table-craft/desktop/renderer/streams/TopicAdminDialogs.js";
import { SchemaDialog } from "@table-craft/desktop/renderer/streams/SchemaDialog.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";

/** The wide dialogs hold a table; the rest a short form. */
const WIDTH: Readonly<Record<StreamDialogRequest["kind"], string>> = {
  reset: "w-picker",
  produce: "w-picker",
  createTopic: "w-generator",
  configs: "w-picker",
  addPartitions: "w-generator",
  deleteRecords: "w-picker",
  schema: "w-picker",
};

function Body({ request }: { readonly request: StreamDialogRequest }) {
  switch (request.kind) {
    case "reset":
      return <ResetOffsetsDialog request={request} />;
    case "produce":
      return <ProduceDialog request={request} />;
    case "createTopic":
      return <CreateTopicDialog request={request} />;
    case "configs":
      return <EditConfigsDialog request={request} />;
    case "addPartitions":
      return <AddPartitionsDialog request={request} />;
    case "deleteRecords":
      return <DeleteRecordsDialog request={request} />;
    case "schema":
      return <SchemaDialog request={request} />;
  }
}

/** Hosts the stream dialogs (plan 164 decisions 11-13) the topic and group actions open. */
export function StreamDialogs() {
  const pending = useStreamDialog((state) => state.pending);
  return (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) useStreamDialog.getState().answer(false);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={OVERLAY_CLASS} />
        <Dialog.Content
          className={cn(
            CONTENT_CLASS,
            "max-h-[95vh] max-w-[95vw]",
            pending === null ? "" : WIDTH[pending.request.kind],
          )}
        >
          {pending === null ? null : <Body request={pending.request} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
