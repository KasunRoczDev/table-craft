import type { KeyboardEvent } from "react";
import { invoke } from "@table-craft/desktop/renderer/actions/index.js";
import { KEEPS_ESCAPE_ATTRIBUTE } from "@table-craft/desktop/renderer/actions/context.js";
import { INDEX_ACTION_IDS, type IndexFilterArgs } from "@table-craft/desktop/renderer/actions/indexActions.js";
import { TextInput } from "@table-craft/desktop/renderer/dialogs/parts.js";
import { indexFilterCount, type IndexFilterNode } from "@table-craft/desktop/renderer/model/indexTree.js";
import { KeyFilterIcon } from "@table-craft/desktop/renderer/ui/icons.js";

/**
 * A search datasource's tree filter (plan 166): the tree narrows as the name is typed, with no
 * round trip, and says how many targets are left of all of them. Its keys stay its own, so the
 * tree's arrows and speed search do not take them; Escape clears it, then leaves the field.
 */
export function IndexFilterRow({ node, onFocus }: { readonly node: IndexFilterNode; readonly onFocus: () => void }) {
  function apply(filter: string): void {
    const args: IndexFilterArgs = { datasourceId: node.datasourceId, filter };
    void invoke(INDEX_ACTION_IDS.filter, args);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.key !== "Escape") return;
    if (node.filter === "") event.currentTarget.blur();
    else apply("");
  }

  return (
    <span
      {...{ [KEEPS_ESCAPE_ATTRIBUTE]: "" }}
      className="flex min-w-0 flex-1 items-center gap-cell"
      onMouseDown={(event) => event.stopPropagation()}
      onFocus={onFocus}
    >
      <KeyFilterIcon aria-hidden className="size-icon shrink-0 text-ink-muted" />
      <TextInput
        aria-label="Filter indices"
        data-testid="index-filter"
        placeholder="Filter indices: name or logs-*-2026"
        className="min-w-0 flex-1"
        value={node.filter}
        onChange={(event) => apply(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span data-testid="index-filter-count" className="shrink-0 text-ink-muted tabular-nums">
        {indexFilterCount(node)}
      </span>
    </span>
  );
}
