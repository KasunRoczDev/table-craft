import type { KeyboardEvent } from "react";

/** Inputs Enter presses rather than edits; everything else on one line takes Enter as "go". */
const PRESSED_INPUTS: ReadonlySet<string> = new Set(["button", "checkbox", "radio", "reset", "submit"]);

export interface EnterTarget {
  readonly tagName: string;
  readonly type?: string | undefined;
}

/** Whether Enter landed in a single-line field, outside an input method's composition. */
export function isFieldEnter(key: string, composing: boolean, target: EnterTarget): boolean {
  if (key !== "Enter" || composing || target.tagName !== "INPUT") return false;
  return !PRESSED_INPUTS.has((target.type ?? "").toLowerCase());
}

/**
 * A form's key handler that runs `onEnter` on Enter in a field. A browser submits on Enter only
 * when the form has a submit button or a single field, which a dialog with two fields and click-only
 * buttons has neither of, so Enter would silently do nothing.
 */
export function onFieldEnter(onEnter: () => void) {
  return (event: KeyboardEvent<HTMLFormElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const type = target instanceof HTMLInputElement ? target.type : undefined;
    if (!isFieldEnter(event.key, event.nativeEvent.isComposing, { tagName: target.tagName, type })) return;
    event.preventDefault();
    onEnter();
  };
}
