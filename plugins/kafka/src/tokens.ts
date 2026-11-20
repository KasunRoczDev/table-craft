/**
 * How the console reads a command (decision 9 of plan 164): words split on blanks with
 * `redis-cli`'s quoting (`"…"` with backslash escapes, `'…'` literal, a bare backslash escaping
 * the next character), and a word that starts with `{` or `[` read as one JSON value up to its
 * matching bracket, blanks and line breaks included. Shared by split, classify, complete and run.
 */

/** One argument of a command, in UTF-16 offsets into the text read. */
export interface Token {
  readonly from: number;
  readonly to: number;
  /** The argument as the command receives it. */
  readonly text: string;
  readonly quoted: boolean;
  /** A `{…}` or `[…]` JSON value, taken verbatim. */
  readonly json: boolean;
  /** False for a quote or bracket the text never closes. */
  readonly closed: boolean;
}

const COMMENT = "#";
const BLANK = /\s/;
const HEX_ESCAPE = /^[0-9a-fA-F]{2}$/;
const HEX_RADIX = 16;
const HEX_ESCAPE_LENGTH = 2;
const ESCAPES: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };
const OPENERS: Readonly<Record<string, string>> = { "{": "}", "[": "]" };

function isBlank(char: string | undefined): boolean {
  return char !== undefined && BLANK.test(char);
}

/** Reads a balanced JSON value from its opening bracket; returns where it ends and whether it closed. */
export function readJson(text: string, start: number): { end: number; closed: boolean } {
  const stack: string[] = [];
  let index = start;
  let inString = false;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (OPENERS[char] !== undefined) {
      stack.push(OPENERS[char]);
    } else if (char === "}" || char === "]") {
      if (stack.at(-1) === char) stack.pop();
      if (stack.length === 0) return { end: index + 1, closed: true };
    }
    index += 1;
  }
  return { end: text.length, closed: false };
}

/** Reads one quoted argument from its quote; returns its text and where it ends. */
export function readQuoted(text: string, start: number): { text: string; end: number; closed: boolean } {
  const quote = text[start];
  let value = "";
  let index = start + 1;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === quote) return { text: value, end: index + 1, closed: true };
    if (quote === '"' && char === "\\" && index + 1 < text.length) {
      const next = text[index + 1] ?? "";
      const hex = text.slice(index + 2, index + 2 + HEX_ESCAPE_LENGTH);
      if (next === "x" && HEX_ESCAPE.test(hex)) {
        value += String.fromCharCode(Number.parseInt(hex, HEX_RADIX));
        index += 2 + HEX_ESCAPE_LENGTH;
        continue;
      }
      value += ESCAPES[next] ?? next;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  return { text: value, end: text.length, closed: false };
}

/** Every argument of `command`; a word that runs into a quote, `ab"c d"`, is one argument. */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < command.length) {
    while (isBlank(command[index])) index += 1;
    if (index >= command.length) break;
    const from = index;
    if (OPENERS[command[index] ?? ""] !== undefined) {
      const read = readJson(command, index);
      tokens.push({
        from,
        to: read.end,
        text: command.slice(from, read.end),
        quoted: false,
        json: true,
        closed: read.closed,
      });
      index = read.end;
      continue;
    }
    let text = "";
    let quoted = false;
    let closed = true;
    while (index < command.length && !isBlank(command[index])) {
      const char = command[index] ?? "";
      if (char === '"' || char === "'") {
        const read = readQuoted(command, index);
        text += read.text;
        quoted = true;
        closed = read.closed;
        index = read.end;
        if (!read.closed) break;
      } else if (char === "\\" && index + 1 < command.length) {
        text += command[index + 1] ?? "";
        index += 2;
      } else {
        text += char;
        index += 1;
      }
    }
    tokens.push({ from, to: index, text, quoted, json: false, closed });
  }
  return tokens;
}

/** Whether the line is blank or a `#` comment, so it starts no command. */
export function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed === "" || trimmed.startsWith(COMMENT);
}

/** Text as an argument the console reads back to the same text: bare when it can be, else double-quoted. */
export function quoteArgument(value: string): string {
  if (value !== "" && !/[\s"'\\#{}[\]]/.test(value) && !value.startsWith("-")) return value;
  return `"${value
    .replace(/[\\"]/g, (char) => `\\${char}`)
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t")}"`;
}
