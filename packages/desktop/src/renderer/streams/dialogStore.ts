import { create } from "zustand";
import type {
  CompatibilityCheck,
  ConfigChange,
  ConfigEntry,
  DeleteRecordsPreview,
  MessageFormat,
  ProduceRecord,
  ProduceResult,
  RecordsBefore,
  RegisteredSchema,
  ResetPreview,
  ResetScope,
  ResetTarget,
  SchemaType,
  TopicCreate,
} from "@table-craft/desktop/engine/protocol.js";
import type { DatasourceColor } from "@table-craft/desktop/preload/bridge.js";
import type { ResetDraft } from "@table-craft/desktop/renderer/model/groupLag.js";

/** What the Produce dialog opens with: blank, or a row of the grid to send again (decision 13). */
export interface ProduceDraft {
  readonly partition: string;
  readonly key: string;
  readonly value: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly keyFormat: MessageFormat;
  readonly valueFormat: MessageFormat;
}

export const EMPTY_PRODUCE: ProduceDraft = {
  partition: "",
  key: "",
  value: "",
  headers: [],
  keyFormat: "string",
  valueFormat: "string",
};

/** The registry schema a produced value is preselected with (audit M7). */
export interface ProduceSchema {
  readonly subject: string;
  /** Null sends with the latest version. */
  readonly version: number | null;
  readonly type: SchemaType;
}

/** The data source a dialog writes to, named in its title (audit M8). */
export interface DialogDatasource {
  readonly name: string;
  readonly color: DatasourceColor | null;
}

/** A member of a group, as a refused reset lists it (audit m6). */
export interface GroupMemberLine {
  readonly clientId: string;
  readonly host: string;
}

/**
 * A stream dialog (plan 164 decisions 11-13). Each carries the calls it makes, bound by the action
 * that opened it, so the dialog stays a view: it previews and applies through them and shows what
 * the broker refused in place. No call is retried (decision 139).
 */
export type StreamDialogRequest = { readonly datasource: DialogDatasource } & (
  | {
      readonly kind: "reset";
      readonly group: string;
      readonly state: string;
      readonly members: readonly GroupMemberLine[];
      /** The topics the group has committed offsets on. */
      readonly topics: readonly string[];
      /** The topic and fields the dialog opens on, as Skip Record does; absent, every topic from a timestamp. */
      readonly initial?: { readonly topic: string | null; readonly draft: Partial<ResetDraft> };
      readonly lagWarning: number;
      readonly prepare: (scope: ResetScope, target: ResetTarget) => Promise<ResetPreview>;
      readonly apply: (token: string) => Promise<void>;
    }
  | {
      readonly kind: "produce";
      readonly topic: string;
      readonly partitions: number | null;
      readonly initial: ProduceDraft;
      /** The registry formats can be chosen: the datasource's Schema Registry answers. */
      readonly registry: boolean;
      /** The value's schema, preselected from the last read or `<topic>-value`. */
      readonly valueSchema: ProduceSchema | null;
      readonly send: (record: ProduceRecord) => Promise<ProduceResult>;
    }
  | {
      readonly kind: "createTopic";
      /** The topics already listed, for the `.`/`_` collision warning. */
      readonly existing: readonly string[];
      readonly create: (request: TopicCreate, validateOnly: boolean) => Promise<void>;
    }
  | {
      readonly kind: "configs";
      readonly topic: string;
      readonly configs: readonly ConfigEntry[];
      readonly alter: (changes: readonly ConfigChange[], validateOnly: boolean) => Promise<void>;
    }
  | {
      readonly kind: "addPartitions";
      readonly topic: string;
      readonly current: number;
      readonly add: (total: number, validateOnly: boolean) => Promise<void>;
    }
  | {
      readonly kind: "deleteRecords";
      readonly topic: string;
      readonly partitions: number;
      readonly prepare: (partitions: readonly number[] | null, before: RecordsBefore) => Promise<DeleteRecordsPreview>;
      readonly apply: (token: string) => Promise<void>;
    }
  | {
      readonly kind: "schema";
      /** Check answers the registry's verdict; Register writes. */
      readonly mode: "check" | "register";
      readonly subject: string;
      readonly type: SchemaType;
      readonly initial: string;
      readonly check: (type: SchemaType, schema: string) => Promise<CompatibilityCheck>;
      readonly register: (type: SchemaType, schema: string) => Promise<RegisteredSchema>;
    }
);

interface Pending {
  readonly request: StreamDialogRequest;
  readonly resolve: (done: boolean) => void;
  /** Something was written already, so even a dismissal answers true (audit m9). */
  readonly changed: boolean;
}

export interface StreamDialogState {
  readonly pending: Pending | null;
  /** Opens the dialog; resolves true once it changed something, false when closed without. */
  readonly ask: (request: StreamDialogRequest) => Promise<boolean>;
  /** Notes a write the open dialog made, as Produce's Send does before the dialog closes. */
  readonly changed: () => void;
  readonly answer: (done: boolean) => void;
}

export const useStreamDialog = create<StreamDialogState>()((set, get) => ({
  pending: null,
  ask(request) {
    get().answer(false);
    return new Promise((resolve) => set({ pending: { request, resolve, changed: false } }));
  },
  changed() {
    const pending = get().pending;
    if (pending !== null && !pending.changed) set({ pending: { ...pending, changed: true } });
  },
  answer(done) {
    const pending = get().pending;
    set({ pending: null });
    pending?.resolve(done || pending.changed);
  },
}));

/** A failed call's message for the dialog to show in place. */
export function failureText(cause: unknown): string {
  if (cause instanceof Error) {
    const hint = "hint" in cause && typeof cause.hint === "string" && cause.hint !== "" ? ` ${cause.hint}` : "";
    return `${cause.message}${hint}`;
  }
  return String(cause);
}

/** A data source of this colour is production: titles warn and destructive applies want a typed name. */
export const PRODUCTION_COLOR: DatasourceColor = "red";

export function isProduction(datasource: DialogDatasource): boolean {
  return datasource.color === PRODUCTION_COLOR;
}
