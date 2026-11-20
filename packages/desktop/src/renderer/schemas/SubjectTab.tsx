import { json } from "@codemirror/lang-json";
import { REGION_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { SUBJECT_ACTION_IDS } from "@table-craft/desktop/renderer/actions/subjectActions.js";
import { useConsoleDatasource } from "@table-craft/desktop/renderer/console/useConsoleDatasource.js";
import { subjectDetail } from "@table-craft/desktop/renderer/model/streamTree.js";
import { schemaText, useSubjectTabs } from "@table-craft/desktop/renderer/state/subjectTabs.js";
import { ObjectHeader } from "@table-craft/desktop/renderer/streams/ObjectHeader.js";
import { useStreamReasons } from "@table-craft/desktop/renderer/streams/reasons.js";
import { ActionButton } from "@table-craft/desktop/renderer/ui/ActionButton.js";
import { cn } from "@table-craft/desktop/renderer/ui/cn.js";
import { SqlView } from "@table-craft/desktop/renderer/ui/SqlView.js";
import { tintFrame } from "@table-craft/desktop/renderer/ui/tint.js";

/** Kept stable across renders: SqlView reconfigures on a new language. */
const JSON_LANGUAGE = json();

/**
 * A Schema Registry subject's tab (plan 164 Phase 6, audit m12): its versions, the chosen one's
 * schema read-only and highlighted, the compatibility level, and Check Compatibility… and
 * Register New Version….
 */
export function SubjectTab({ tabId }: { readonly tabId: string }) {
  const tab = useSubjectTabs((state) => state.tabs[tabId]);
  const datasource = useConsoleDatasource(tabId);
  const reasons = useStreamReasons(datasource);
  if (tab === undefined) return null;
  const color = datasource?.color ?? null;
  const schema = tab.schema;
  const facts =
    schema === null
      ? tab.loading
        ? "Reading…"
        : ""
      : [
          subjectDetail({ subject: tab.subject, latestVersion: schema.version, type: schema.type }),
          `id ${String(schema.id)}`,
          `${String(tab.versions?.length ?? 0)} ${tab.versions?.length === 1 ? "version" : "versions"}`,
          tab.level === null ? null : `compatibility ${tab.level}`,
        ]
          .filter((part) => part !== null)
          .join(" · ");
  return (
    <div
      data-testid="subject-tab"
      {...{ [REGION_ATTRIBUTE]: "tableEditor" }}
      className={cn("flex min-h-0 flex-1 flex-col", tintFrame(color))}
    >
      <ObjectHeader
        testId="subject-header"
        kind="Subject"
        name={tab.subject}
        scope={datasource?.name}
        facts={facts}
        actions={
          <>
            <ActionButton actionId={SUBJECT_ACTION_IDS.refresh} compact reason={reasons.read} />
            <ActionButton actionId={SUBJECT_ACTION_IDS.check} reason={reasons.read} testId="subject-check" />
            <ActionButton actionId={SUBJECT_ACTION_IDS.register} reason={reasons.write} testId="subject-register" />
          </>
        }
      />
      {tab.error === null ? null : (
        <div role="alert" className="shrink-0 border-y border-line bg-panel px-gap py-1 text-danger">
          {tab.error.message} <span className="text-ink-muted">{tab.error.hint}</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 border-t border-line">
        <ul
          aria-label="Versions"
          data-testid="subject-versions"
          className="w-40 shrink-0 overflow-auto border-r border-line py-1"
        >
          {[...(tab.versions ?? [])].reverse().map((version) => (
            <li key={version}>
              <button
                type="button"
                aria-pressed={version === tab.selected}
                className="flex h-row w-full items-center px-pane-inset text-left hover:bg-hover aria-pressed:bg-selection"
                onClick={() => void invoke(SUBJECT_ACTION_IDS.selectVersion, { version })}
              >
                Version {version}
                {version === tab.versions?.at(-1) ? <span className="ml-cell text-ink-muted">latest</span> : null}
              </button>
            </li>
          ))}
        </ul>
        <SqlView
          label="Schema"
          testId="subject-schema"
          className="min-w-0 flex-1"
          language={JSON_LANGUAGE}
          wrap
          text={schemaText(schema)}
        />
      </div>
    </div>
  );
}
