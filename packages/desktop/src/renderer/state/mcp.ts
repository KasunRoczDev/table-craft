import { create } from "zustand";
import { bridge } from "@table-craft/desktop/renderer/bridge.js";
import { DEFAULT_SETTINGS } from "@table-craft/desktop/settings/settings.js";
import { stoppedStatus, type McpStatus } from "@table-craft/desktop/settings/mcp.js";

export interface McpStore {
  /** The MCP host's state as main relays it (plan 117). */
  readonly status: McpStatus;
  /** Whether the status bar chip's popover is open. */
  readonly popoverOpen: boolean;
  /**
   * Whether the approval dialog is open. It opens only from a click (decision 127): a write
   * waiting turns the chip amber and never takes focus on its own.
   */
  readonly approvalOpen: boolean;
  /** Whether the Agent Activity dialog is open. */
  readonly activityOpen: boolean;
  /**
   * Whether the approval dialog shows the statement laid out by the formatter (decision 167). It
   * holds for every request until the app quits; what runs is always the statement as sent.
   */
  readonly approvalFormatted: boolean;
  readonly changed: (status: McpStatus) => void;
  readonly setPopover: (open: boolean) => void;
  readonly setApproval: (open: boolean) => void;
  readonly setActivity: (open: boolean) => void;
  readonly setApprovalFormatted: (formatted: boolean) => void;
}

export const useMcp = create<McpStore>()((set) => ({
  status: stoppedStatus(DEFAULT_SETTINGS.mcp.port),
  popoverOpen: false,
  approvalOpen: false,
  activityOpen: false,
  approvalFormatted: true,
  changed: (status) =>
    set((previous) => ({
      status,
      // Nothing left to answer, so the dialog does not sit empty over the window.
      approvalOpen: previous.approvalOpen && status.approvals.length > 0,
    })),
  setPopover: (popoverOpen) => set({ popoverOpen }),
  setApproval: (approvalOpen) => set({ approvalOpen }),
  setActivity: (activityOpen) => set({ activityOpen }),
  setApprovalFormatted: (approvalFormatted) => set({ approvalFormatted }),
}));

/** Asks main for the MCP status once and follows it; returns the unsubscribe. */
export function installMcpState(): () => void {
  let live = true;
  void bridge()
    .mcpStatus()
    .then((answer) => {
      if (live && answer.ok) useMcp.getState().changed(answer.value);
    });
  const unsubscribe = bridge().onMcpStatus((status) => useMcp.getState().changed(status));
  return () => {
    live = false;
    unsubscribe();
  };
}
