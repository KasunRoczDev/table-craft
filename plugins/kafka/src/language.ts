import type { InspectionRequest, Problem, StatementClass, StatementSpan } from "@table-craft/plugin-api";
import { flagOf, isFlag } from "./args.js";
import { commandOf, type CommandDoc } from "./docs.js";
import { knownTopicSize } from "./sizes.js";
import { isCommentOrBlank, tokenize, type Token } from "./tokens.js";

/** The inspection id of a costly-command mark, which the user can turn off. */
export const COSTLY_INSPECTION = "KafkaCostlyCommand";
/** Above this many messages a `consume` without `--limit` is marked costly (decision 10). */
export const COSTLY_TOPIC_MESSAGES = 1_000_000n;
export const DEFAULT_CONSUME_LIMIT = 500;

const OPENERS: Readonly<Record<string, string>> = { "{": "}", "[": "]" };
const LATEST_N = /^-\d+$/;

/**
 * Where the command that starts at `from` ends: at a line break outside a quote and outside a
 * `{…}` or `[…]`, so a produced JSON value or a quoted string may span lines (decision 9).
 */
function commandEnd(text: string, from: number): number {
  let quote: string | null = null;
  const stack: string[] = [];
  let index = from;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "\\") {
      index += 1;
    } else if (OPENERS[char] !== undefined) {
      stack.push(OPENERS[char]);
    } else if ((char === "}" || char === "]") && stack.at(-1) === char) {
      stack.pop();
    } else if (char === "\n" && stack.length === 0) {
      return index;
    }
    index += 1;
  }
  return text.length;
}

/** Every command of `text`: one per line, blank and `#` lines skipped, a JSON value or quote spanning lines. */
export function split(text: string): StatementSpan[] {
  const spans: StatementSpan[] = [];
  let start = 0;
  while (start < text.length) {
    const lineEnd = text.indexOf("\n", start);
    const line = text.slice(start, lineEnd === -1 ? text.length : lineEnd);
    if (isCommentOrBlank(line)) {
      if (lineEnd === -1) break;
      start = lineEnd + 1;
      continue;
    }
    const from = start + (line.length - line.trimStart().length);
    const end = commandEnd(text, from);
    const to = from + text.slice(from, end).trimEnd().length;
    spans.push({ from, to, sql: text.slice(from, to) });
    start = end + 1;
  }
  return spans;
}

function hasFlag(doc: CommandDoc, tokens: readonly Token[], name: string): boolean {
  return tokens.some((token) => isFlag(token) && flagOf(doc, token).name === name);
}

function flagText(doc: CommandDoc, tokens: readonly Token[], name: string): string | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !isFlag(token)) continue;
    const flag = flagOf(doc, token);
    if (flag.name !== name) continue;
    return flag.inline ?? tokens[index + 1]?.text ?? null;
  }
  return null;
}

function positionalOf(tokens: readonly Token[], doc: CommandDoc): Token[] {
  const positional: Token[] = [];
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (!isFlag(token)) {
      positional.push(token);
      continue;
    }
    const { flag, inline } = flagOf(doc, token);
    if (flag?.value !== undefined && inline === null) index += 1;
  }
  return positional;
}

function destructiveOf(doc: CommandDoc, tokens: readonly Token[]): { reason: string; byName: boolean } | null {
  const positional = positionalOf(tokens, doc);
  const first = positional[0]?.text ?? "";
  switch (doc.name) {
    case "delete-topic":
      return { reason: `delete-topic deletes ${first} and every message in it`, byName: true };
    case "delete-records":
      return {
        reason: `delete-records deletes the records of ${first} partition ${positional[1]?.text ?? "?"} before offset ${positional[2]?.text ?? "?"}`,
        byName: true,
      };
    case "delete-group":
      return { reason: `delete-group deletes consumer group ${first} and its committed offsets`, byName: false };
    case "delete-offsets":
      return {
        reason: `delete-offsets deletes what ${first} committed on ${positional[1]?.text ?? "?"}`,
        byName: false,
      };
    case "reset-offsets":
      return hasFlag(doc, tokens, "dry-run")
        ? null
        : { reason: `reset-offsets moves the committed offsets of ${first}`, byName: false };
    default:
      return null;
  }
}

/** Why a `consume` reads too much, and the line bounded by `--limit`; null when it does not. */
function costlyOf(command: string, doc: CommandDoc, tokens: readonly Token[]): { reason: string; fix: string } | null {
  if (doc.name !== "consume" || hasFlag(doc, tokens, "limit")) return null;
  const from = flagText(doc, tokens, "from");
  if (from !== null && LATEST_N.test(from)) return null;
  const topic = positionalOf(tokens, doc)[0]?.text;
  const size = topic === undefined ? null : knownTopicSize(topic);
  if (size === null || size <= COSTLY_TOPIC_MESSAGES) return null;
  return {
    reason: `consume without --limit reads up to 50,000 of the ~${size.toLocaleString("en-US")} messages of ${topic ?? ""}; add --limit`,
    fix: `${command.trimEnd()} --limit ${String(DEFAULT_CONSUME_LIMIT)}`,
  };
}

/** What a command does (decision 10): its table entry, refined by `--dry-run` and a given level. */
export function classify(command: string): StatementClass {
  const tokens = tokenize(command);
  const doc = commandOf(tokens[0]?.text ?? "");
  if (doc === null) return { kind: "other", destructive: null };
  let kind = doc.kind;
  if (doc.name === "reset-offsets" && hasFlag(doc, tokens, "dry-run")) kind = "read";
  if (doc.name === "compatibility") {
    const positional = positionalOf(tokens, doc);
    const levelGiven = hasFlag(doc, tokens, "global") ? positional.length >= 1 : positional.length >= 2;
    kind = levelGiven ? "write" : "read";
  }
  const destructive = destructiveOf(doc, tokens);
  const costly = costlyOf(command, doc, tokens);
  return {
    kind,
    destructive: destructive?.reason ?? null,
    ...(costly === null ? {} : { costly: costly.reason }),
    ...(destructive?.byName === true ? { confirmByName: true } : {}),
  };
}

/** A mark on every costly command of the text, with the command bounded by `--limit` as its fix. */
export function inspect(request: InspectionRequest): Promise<readonly Problem[]> {
  if (request.disabled?.includes(COSTLY_INSPECTION) === true) return Promise.resolve([]);
  const problems: Problem[] = [];
  for (const span of split(request.text)) {
    const tokens = tokenize(span.sql);
    const doc = commandOf(tokens[0]?.text ?? "");
    if (doc === null) continue;
    const costly = costlyOf(span.sql, doc, tokens);
    if (costly === null) continue;
    const first = tokens[0];
    problems.push({
      from: span.from + (first?.from ?? 0),
      to: span.from + (first?.to ?? span.sql.length),
      severity: "warning",
      inspection: COSTLY_INSPECTION,
      message: costly.reason,
      fixes: [
        {
          title: `Add --limit ${String(DEFAULT_CONSUME_LIMIT)}`,
          edits: [{ from: span.from, to: span.to, insert: costly.fix }],
        },
      ],
    });
  }
  return Promise.resolve(problems);
}
