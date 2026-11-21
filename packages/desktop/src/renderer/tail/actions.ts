import { TOPIC_TAIL_COPY_MAX_BYTES } from "@table-craft/desktop/engine/protocol.js";
import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import {
  streamSource,
  topicsAvailable,
  topicTarget,
  type OpenTopicArgs,
} from "@table-craft/desktop/renderer/actions/topicActions.js";
import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { bridgeSqlFiles } from "@table-craft/desktop/renderer/state/sqlFiles.js";
import { useTail, type TailEntry, type TailExtract } from "./store.js";

export const TAIL_ACTION_IDS = {
  toggle: "window.tail",
  start: "topic.tail",
  command: "tail.command",
} as const;

export interface TailCommandArgs {
  readonly id: string;
  readonly kind: "select" | "pause" | "clear" | "stop" | "close" | "copy" | "export";
}

const EXPORT_TITLE = "Export Tailed Messages";
const EXPORT_EXTENSION = ".jsonl";
const MIB = 1_048_576;
const CUT_MESSAGE = `The tail's temporary file no longer holds their whole messages, or the copied text passed ${String(TOPIC_TAIL_COPY_MAX_BYTES / MIB)} MB. The other messages are whole.`;
const CUT_HINT = "Export to a file, which has no size limit, or read the messages again from the topic tab.";

/** Says how many large messages went out as their first 1,024 characters, when any did. */
async function noteCut(extracted: TailExtract, verb: "copied" | "exported"): Promise<void> {
  if (extracted.cut === 0) return;
  const cut = extracted.cut.toLocaleString("en-US");
  const total = extracted.messages.toLocaleString("en-US");
  await useModal.getState().ask({
    kind: "notice",
    title: `${cut} of ${total} messages were ${verb} as their first 1,024 characters`,
    message: CUT_MESSAGE,
    hint: CUT_HINT,
  });
}

async function copyTail(id: string): Promise<void> {
  const extracted = await useTail.getState().extract(id, null);
  await writeClipboard(extracted.text ?? "");
  await noteCut(extracted, "copied");
}

async function exportTail(id: string, entry: TailEntry): Promise<void> {
  const files = bridgeSqlFiles();
  try {
    const path = await files.chooseSavePath(EXPORT_TITLE, `${entry.summary.request.topic}${EXPORT_EXTENSION}`);
    if (path === null) return;
    const extracted = await useTail.getState().extract(id, path);
    if (extracted.text !== null) await files.write(path, `${extracted.text}\n`, "lf");
    await noteCut(extracted, "exported");
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "The messages were not exported",
      message: cause instanceof Error ? cause.message : String(cause),
      hint: "Choose another folder, or copy them as JSON Lines instead.",
    });
  }
}

export const TAIL_ACTIONS: readonly AnyAction[] = [
  defineAction({
    id: TAIL_ACTION_IDS.toggle,
    title: "Live Tail",
    category: "Tool Windows",
    icon: "tail",
    run: () => useLayout.getState().toggle("tail"),
  }),
  defineAction<OpenTopicArgs | undefined>({
    id: TAIL_ACTION_IDS.start,
    title: "Tail Topic",
    category: "Streams",
    icon: "tail",
    available: topicsAvailable,
    when: (context, args) => {
      const target = topicTarget(context, args);
      return target !== null && streamSource(context, target.datasourceId)?.connection.status === "connected";
    },
    run: async (context, args) => {
      const target = topicTarget(context, args);
      if (target === null) return;
      const draft = context.topicTab?.topic === target.topic ? context.topicTab.draft : null;
      try {
        await useTail.getState().start(target.datasourceId, {
          topic: target.topic,
          partitions: draft?.partitions ?? null,
          from: { kind: "latest" },
          keyFormat: draft?.keyFormat ?? "auto",
          valueFormat: draft?.valueFormat ?? "auto",
        });
        useLayout.getState().show("tail");
      } catch (cause) {
        await useModal.getState().ask({
          kind: "notice",
          title: "The tail did not start",
          message: cause instanceof Error ? cause.message : String(cause),
          hint: "Nothing is being read. Check the connection and try again.",
        });
      }
    },
  }),
  defineAction<TailCommandArgs | undefined>({
    id: TAIL_ACTION_IDS.command,
    title: "Manage Tail",
    category: "Streams",
    inPalette: false,
    run: async (_context, args) => {
      if (args === undefined) return;
      const store = useTail.getState();
      const entry = store.entries[args.id];
      if (entry === undefined) return;
      if (args.kind === "select") {
        store.select(args.id);
        useLayout.getState().show("tail");
      } else if (args.kind === "pause") store.pause(args.id);
      else if (args.kind === "clear") await store.clear(args.id);
      else if (args.kind === "copy") await copyTail(args.id);
      else if (args.kind === "export") await exportTail(args.id, entry);
      else await store.stop(args.id, args.kind === "close");
    },
  }),
];
