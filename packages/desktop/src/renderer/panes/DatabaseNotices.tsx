import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { SETTINGS_ACTION_IDS } from "@table-craft/desktop/renderer/actions/settingsActions.js";
import { useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { themeOf, useSettings } from "@table-craft/desktop/renderer/state/settings.js";
import { WarningIcon } from "@table-craft/desktop/renderer/ui/icons.js";

/** Why the datasource list could not be read in full. */
export function LoadWarning() {
  const warning = useDatasources((state) => state.warning);
  const dismiss = useDatasources((state) => state.dismissWarning);
  if (warning === null) return null;
  return (
    <div
      role="alert"
      className="mx-pane-inset mb-gap flex items-start gap-cell rounded border border-danger p-cell text-ink"
    >
      <WarningIcon aria-hidden weight="fill" className="mt-0.5 size-icon shrink-0 text-danger" />
      <span className="min-w-0 flex-1">{warning}</span>
      <button type="button" className="text-ink-muted hover:text-ink" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}

/** Why settings.json was set aside, a save failed, or the chosen theme could not be used. */
export function SettingsNotice() {
  const notice = useSettings((state) => state.notice);
  const themeNotice = useSettings((state) => themeOf(state).notice);
  const dismiss = useSettings((state) => state.dismissNotice);
  if (notice === null && themeNotice === null) return null;
  return (
    <div
      role="alert"
      data-testid="settings-notice"
      className="mx-pane-inset mb-gap flex items-start gap-cell rounded border border-warning p-cell text-ink"
    >
      <WarningIcon aria-hidden weight="fill" className="mt-0.5 size-icon shrink-0 text-warning" />
      <span className="flex min-w-0 flex-1 flex-col gap-1 break-words">
        {notice === null ? null : <span>{notice}</span>}
        {themeNotice === null ? null : <span>{themeNotice}</span>}
        <span className="flex justify-end gap-gap">
          <button
            type="button"
            className="text-ink-muted hover:text-ink"
            onClick={() => invoke(SETTINGS_ACTION_IDS.show)}
          >
            Settings…
          </button>
          {notice === null ? null : (
            <button type="button" className="text-ink-muted hover:text-ink" onClick={dismiss}>
              Dismiss
            </button>
          )}
        </span>
      </span>
    </div>
  );
}
