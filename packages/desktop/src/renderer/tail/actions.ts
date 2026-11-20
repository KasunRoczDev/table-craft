import { defineAction, type AnyAction } from "@table-craft/desktop/renderer/actions/registry.js";
import { topicTarget } from "@table-craft/desktop/renderer/actions/topicActions.js";
import { writeClipboard } from "@table-craft/desktop/renderer/state/clipboard.js";
import { useLayout } from "@table-craft/desktop/renderer/state/layout.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { bridgeSqlFiles } from "@table-craft/desktop/renderer/state/sqlFiles.js";
import { tailJsonLines, useTail, type TailEntry } from "./store.js";

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

async function exportTail(entry: TailEntry): Promise<void> {
  const files = bridgeSqlFiles();
  try {
    const path = await files.chooseSavePath(EXPORT_TITLE, `${entry.summary.request.topic}${EXPORT_EXTENSION}`);
    if (path === null) return;
    await files.write(path, `${tailJsonLines(entry.retained)}\n`, "lf");
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
  defineAction({
    id: TAIL_ACTION_IDS.start,
    title: "Tail Topic",
    category: "Streams",
    icon: "tail",
    available: (context) => context.datasource?.capabilities.includes("topics") === true,
    when: (context) => context.datasource?.connection.status === "connected" && topicTarget(context) !== null,
    run: async (context) => {
      const target = topicTarget(context);
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
      else if (args.kind === "copy") await writeClipboard(tailJsonLines(entry.retained));
      else if (args.kind === "export") await exportTail(entry);
      else await store.stop(args.id, args.kind === "close");
    },
  }),
];
