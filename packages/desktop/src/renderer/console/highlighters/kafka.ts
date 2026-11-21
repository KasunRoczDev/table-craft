import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

/** Where the tokenizer is; a JSON value may run over several lines of one command. */
interface KafkaLineState {
  commandSeen: boolean;
  /** Open `{` and `[` of a JSON argument not yet closed. */
  jsonDepth: number;
}

const COMMANDS = new Set([
  "topics",
  "describe",
  "consume",
  "produce",
  "create-topic",
  "delete-topic",
  "alter-config",
  "add-partitions",
  "delete-records",
  "groups",
  "group",
  "lag",
  "reset-offsets",
  "delete-group",
  "delete-offsets",
  "brokers",
  "subjects",
  "schema",
  "register",
  "compatibility",
]);
const FLAG = /^--?[A-Za-z][\w-]*/;
const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?=\s|$)/i;
const JSON_NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?(?=[\s,\]}]|$)/i;
const JSON_ATOM = /^(?:true|false|null)\b/;
const JSON_OPEN = /^[{[]/;
const JSON_CLOSE = /^[}\]]/;
const JSON_PUNCTUATION = /^[:,]/;
const WORD = /^[^\s"']+/;
const JSON_WORD = /^[^\s"'{}[\]:,]+/;

function quoted(stream: StringStream, quote: string): void {
  let escaped = false;
  for (let next = stream.next(); next !== undefined; next = stream.next()) {
    if (next === quote && !escaped) return;
    escaped = quote === '"' && next === "\\" && !escaped;
  }
}

function jsonToken(stream: StringStream, state: KafkaLineState): string | null {
  if (stream.match(JSON_OPEN)) {
    state.jsonDepth += 1;
    return "punctuation";
  }
  if (stream.match(JSON_CLOSE)) {
    state.jsonDepth = Math.max(0, state.jsonDepth - 1);
    return "punctuation";
  }
  if (stream.match(JSON_PUNCTUATION)) return "punctuation";
  if (stream.match(JSON_NUMBER)) return "number";
  if (stream.match(JSON_ATOM)) return "atom";
  stream.match(JSON_WORD);
  return null;
}

/**
 * kcat-like lines (plan 164): `#` comments, the command, `--flag` and `-p`, quoted strings, numbers,
 * and JSON values (`{…}`, `[…]`) that may span lines.
 */
export const kafkaParser: StreamParser<KafkaLineState> = {
  name: "kafka",
  startState: () => ({ commandSeen: false, jsonDepth: 0 }),
  copyState: (state) => ({ ...state }),
  blankLine: (state) => {
    if (state.jsonDepth === 0) state.commandSeen = false;
  },
  token(stream, state) {
    if (stream.sol() && state.jsonDepth === 0) state.commandSeen = false;
    if (stream.eatSpace()) return null;
    if (!state.commandSeen && state.jsonDepth === 0 && stream.peek() === "#") {
      stream.skipToEnd();
      return "lineComment";
    }
    const quote = stream.peek();
    if (quote === '"' || quote === "'") {
      stream.next();
      quoted(stream, quote);
      state.commandSeen = true;
      return "string";
    }
    if (state.jsonDepth > 0 || (state.commandSeen && stream.match(JSON_OPEN, false))) return jsonToken(stream, state);
    if (!state.commandSeen) {
      state.commandSeen = true;
      const word = (stream.match(WORD) as RegExpMatchArray | null)?.[0].toLowerCase() ?? "";
      return COMMANDS.has(word) ? "keyword" : null;
    }
    if (stream.match(FLAG)) return "name.special";
    if (stream.match(NUMBER)) return "number";
    stream.match(WORD);
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

export const kafkaLanguage = StreamLanguage.define(kafkaParser);
