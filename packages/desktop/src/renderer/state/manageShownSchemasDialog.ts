import { create } from "zustand";

/** What the dialog picks: a catalog's top-level namespaces, or a stream datasource's topics. */
export type ShownSubject = "schemas" | "topics";

export interface ManageShownSchemasDialogState {
  /** The datasource whose shown schemas or topics the dialog edits; null while closed. */
  readonly datasourceId: string | null;
  readonly subject: ShownSubject;
  /** Bumped on each open, so the dialog starts fresh. */
  readonly session: number;
  readonly show: (datasourceId: string, subject?: ShownSubject) => void;
  readonly hide: () => void;
}

export const useManageShownSchemasDialog = create<ManageShownSchemasDialogState>()((set) => ({
  datasourceId: null,
  subject: "schemas",
  session: 0,
  show: (datasourceId, subject = "schemas") => set((state) => ({ datasourceId, subject, session: state.session + 1 })),
  hide: () => set({ datasourceId: null }),
}));
