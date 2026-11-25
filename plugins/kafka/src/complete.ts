import {
  MESSAGE_FORMATS,
  SCHEMA_TYPES,
  type CompletionItem,
  type CompletionRequest,
  type CompletionResult,
  type Session,
  type SignatureHelp,
} from "@table-craft/plugin-api";
import { flagOf, isFlag } from "./args.js";
import {
  COMMANDS,
  COMPATIBILITY_LEVELS,
  GROUP_STATES,
  commandOf,
  syntaxOf,
  type CommandDoc,
  type FlagDoc,
  type ValueKind,
} from "./docs.js";
import { quoteArgument, tokenize, type Token } from "./tokens.js";

const COMMAND_WORD = "^[\\w-]*$";
const FLAG_WORD = "^[\\w=-]*$";
const NAME_BOOST = 10;
const FLAG_BOOST = -1;
const COMMENT = "#";

/** Names a session looks up for completion: topics, groups or subjects starting with a prefix. */
export interface NameSuggester {
  suggestNames(kind: "topic" | "group" | "subject", prefix: string): Promise<readonly string[]>;
}

const OFFLINE_VALUES: Partial<Record<ValueKind, readonly string[]>> = {
  format: MESSAGE_FORMATS,
  schemaType: SCHEMA_TYPES,
  level: COMPATIBILITY_LEVELS,
  state: GROUP_STATES,
  resource: ["topic", "broker"],
};

function suggesterOf(session: Session | null): NameSuggester | null {
  if (session === null || !("suggestNames" in session)) return null;
  return typeof session.suggestNames === "function" ? (session as unknown as NameSuggester) : null;
}

interface Line {
  readonly start: number;
  readonly text: string;
  readonly before: readonly Token[];
  readonly current: Token | null;
}

function lineAt(request: CompletionRequest): Line {
  const start = request.text.lastIndexOf("\n", request.offset - 1) + 1;
  const text = request.text.slice(start, request.offset);
  const tokens = tokenize(text);
  const last = tokens.at(-1);
  const current = last !== undefined && last.to === text.length ? last : null;
  return { start, text, before: current === null ? tokens : tokens.slice(0, -1), current };
}

function empty(offset: number): CompletionResult {
  return { from: offset, to: offset, items: [], validFor: null };
}

function item(
  label: string,
  kind: CompletionItem["kind"],
  detail: string | null,
  apply = label,
  boost = 0,
): CompletionItem {
  return { label, kind, detail, apply, boost, info: null, caret: null };
}

function commandItems(): CompletionItem[] {
  return COMMANDS.map((doc) => ({
    ...item(doc.name, "function", doc.kind),
    info: `${syntaxOf(doc)}\n\n${doc.summary}`,
  }));
}

function flagItems(doc: CommandDoc, used: readonly Token[]): CompletionItem[] {
  const given = new Set(used.filter(isFlag).map((token) => flagOf(doc, token).name));
  return doc.flags
    .filter((flag) => flag.repeat === true || !given.has(flag.name))
    .map((flag) => ({
      ...item(
        `--${flag.name}`,
        "keyword",
        flag.value ?? null,
        `--${flag.name}${flag.value === undefined ? "" : " "}`,
        FLAG_BOOST,
      ),
      info: flag.summary,
    }));
}

/** The positional argument the caret is at, skipping flags and their separate values. */
function positionAt(doc: CommandDoc, args: readonly Token[]): number {
  let index = 0;
  for (let at = 0; at < args.length; at += 1) {
    const token = args[at];
    if (token === undefined) continue;
    if (!isFlag(token)) {
      index += 1;
      continue;
    }
    const { flag, inline } = flagOf(doc, token);
    if (flag?.value !== undefined && inline === null) at += 1;
  }
  return index;
}

async function valueItems(
  kind: ValueKind | undefined,
  choices: readonly string[] | undefined,
  prefix: string,
  suggester: NameSuggester | null,
): Promise<CompletionItem[]> {
  if (choices !== undefined) return choices.map((choice) => item(choice, "keyword", null));
  if (kind === undefined) return [];
  const offline = OFFLINE_VALUES[kind];
  if (offline !== undefined) return offline.map((value) => item(value, "keyword", kind));
  if (suggester === null || (kind !== "topic" && kind !== "group" && kind !== "subject")) return [];
  const names = await suggester.suggestNames(kind, prefix).catch(() => []);
  return names.map((name) => item(name, "table", kind, quoteArgument(name), NAME_BOOST));
}

function flagNeedingValue(doc: CommandDoc, last: Token | undefined): FlagDoc | null {
  if (last === undefined || !isFlag(last)) return null;
  const { flag, inline } = flagOf(doc, last);
  return flag?.value !== undefined && inline === null ? flag : null;
}

async function completeLine(request: CompletionRequest, suggester: NameSuggester | null): Promise<CompletionResult> {
  const line = lineAt(request);
  if (line.text.trimStart().startsWith(COMMENT)) return empty(request.offset);
  const from = line.start + (line.current?.from ?? line.text.length);
  if (line.before.length === 0) return { from, to: request.offset, items: commandItems(), validFor: COMMAND_WORD };
  const doc = commandOf(line.before[0]?.text ?? "");
  if (doc === null) return empty(request.offset);
  const args = line.before.slice(1);
  const current = line.current;
  const pending = flagNeedingValue(doc, args.at(-1));
  if (pending !== null) {
    const items = await valueItems(pending.completion, pending.choices, current?.text ?? "", suggester);
    return { from, to: request.offset, items, validFor: null };
  }
  if (current !== null && isFlag(current)) {
    const { flag, inline } = flagOf(doc, current);
    if (inline !== null && flag !== null) {
      const at = from + current.text.indexOf("=") + 1;
      return {
        from: at,
        to: request.offset,
        items: await valueItems(flag.completion, flag.choices, inline, suggester),
        validFor: null,
      };
    }
    return { from, to: request.offset, items: flagItems(doc, args), validFor: FLAG_WORD };
  }
  if (current?.text === "-") return { from, to: request.offset, items: flagItems(doc, args), validFor: FLAG_WORD };
  const parameter = doc.parameters[positionAt(doc, args)];
  const items = await valueItems(parameter?.completion, parameter?.choices, current?.text ?? "", suggester);
  if (current === null) items.push(...flagItems(doc, args));
  return { from, to: request.offset, items, validFor: null };
}

/** What fits at the caret: a command, a flag or its value, or a topic, group or subject name. */
export async function complete(request: CompletionRequest, session: Session | null): Promise<CompletionResult> {
  try {
    return await completeLine(request, suggesterOf(session));
  } catch {
    return empty(request.offset);
  }
}

/** The command the caret is in and which of its positional arguments the caret is at. */
export function signatureAt(request: CompletionRequest, _session: Session | null): Promise<SignatureHelp | null> {
  try {
    const line = lineAt(request);
    const first = line.before[0];
    if (first === undefined || line.text.trimStart().startsWith(COMMENT)) return Promise.resolve(null);
    const doc = commandOf(first.text);
    if (doc === null) return Promise.resolve(null);
    const end = request.text.indexOf("\n", request.offset);
    return Promise.resolve({
      name: doc.name,
      summary: doc.summary,
      signatures: [
        {
          parameters: [
            ...doc.parameters.map((parameter) => ({
              name: parameter.name,
              ...(parameter.optional === true ? { optional: true } : {}),
              ...(parameter.variadic === true ? { variadic: true } : {}),
            })),
            ...doc.flags.map((flag) => ({
              name: `--${flag.name}${flag.value === undefined ? "" : ` <${flag.value}>`}`,
              optional: true,
            })),
          ],
          returns: "",
        },
      ],
      argument: positionAt(doc, line.before.slice(1)),
      from: line.start + first.from,
      to: end === -1 ? request.text.length : end,
    });
  } catch {
    return Promise.resolve(null);
  }
}
