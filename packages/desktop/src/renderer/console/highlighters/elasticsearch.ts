import { StreamLanguage, type StreamParser, type StringStream } from "@codemirror/language";

/** Where the tokenizer is: inside a request's JSON body, or on a SQL query's lines. */
interface ElasticState {
  /** Braces and brackets open in the body; a request line only starts at depth 0. */
  depth: number;
  /** On the lines of a SQL query, up to its `;` or a blank line. */
  sql: boolean;
  /** The query is PPL (`source=logs | ...`) rather than SQL. */
  ppl: boolean;
}

const REQUEST_LINE = /^(?:GET|POST|PUT|DELETE|HEAD)(?=\s)/i;
const SQL_START = /^(?:select|show|describe|desc|explain)\b/i;
const PPL_START = /^(?:source|search)\s*=/i;
const ENDPOINT = /^_[\w.*-]+/;
const PATH_PART = /^[^\s/?_][^\s/?]*/;
const QUERY_STRING = /^\?\S*/;
const NUMBER = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/i;
const ATOM = /^(?:true|false|null)\b/;
const PUNCTUATION = /^[{}[\]:,]/;
const SQL_KEYWORD =
  /^(?:select|from|where|group|by|order|having|limit|and|or|not|as|asc|desc|show|tables|describe|explain|like|in|is|null|count|sum|avg|min|max|distinct|between|case|when|then|else|end|join|on)\b/i;
const PPL_KEYWORD = /^(?:source|search|where|fields|stats|by|sort|head|eval|dedup|rename|top|rare|and|or|not)\b/i;
const WORD = /^[^\s"'{}[\]:,()]+/;
const NO_STATE: ElasticState = { depth: 0, sql: false, ppl: false };

function quoted(stream: StringStream): void {
  let escaped = false;
  for (let next = stream.next(); next !== undefined; next = stream.next()) {
    if (next === '"' && !escaped) return;
    escaped = next === "\\" && !escaped;
  }
}

/** The rest of a `METHOD path` line: endpoints such as `_search` stand out from index names. */
function pathToken(stream: StringStream): string | null {
  if (stream.eat("/")) return "punctuation";
  if (stream.match(ENDPOINT)) return "typeName";
  if (stream.match(QUERY_STRING)) return "name.special";
  if (stream.match(PATH_PART)) return "variableName";
  stream.next();
  return null;
}

function jsonToken(stream: StringStream, state: ElasticState): string | null {
  const char = stream.peek();
  if (char === '"') {
    stream.next();
    quoted(stream);
    return stream.match(/^\s*:/, false) ? "propertyName" : "string";
  }
  if (stream.match(NUMBER)) return "number";
  if (stream.match(ATOM)) return "atom";
  if (stream.match(PUNCTUATION)) {
    const text = stream.current();
    if (text === "{" || text === "[") state.depth += 1;
    else if (text === "}" || text === "]") state.depth = Math.max(0, state.depth - 1);
    return "punctuation";
  }
  if (!stream.match(WORD)) stream.next();
  return null;
}

function queryToken(stream: StringStream, keywords: RegExp): string | null {
  if (stream.peek() === "'" || stream.peek() === '"') {
    const quote = stream.next();
    for (let next = stream.next(); next !== undefined && next !== quote; next = stream.next());
    return "string";
  }
  if (stream.match(keywords)) return "keyword";
  if (stream.match(NUMBER)) return "number";
  if (!stream.match(WORD)) stream.next();
  return null;
}

/**
 * Kibana Dev Tools lines (plan 165): `METHOD path` with its endpoints, the JSON body under it,
 * `#` and `//` comments, and the SQL and PPL queries the console sends to those endpoints.
 */
export const elasticsearchParser: StreamParser<ElasticState> = {
  name: "elasticsearch",
  startState: () => ({ ...NO_STATE }),
  copyState: (state) => ({ ...state }),
  blankLine: (state) => {
    state.sql = false;
  },
  token(stream, state) {
    if (stream.sol() && state.depth === 0) {
      if (stream.match(/^\s*(?:#|\/\/)/)) {
        stream.skipToEnd();
        return "lineComment";
      }
      stream.eatSpace();
      if (stream.match(REQUEST_LINE)) {
        state.sql = false;
        return "keyword";
      }
      if (stream.match(PPL_START, false) || stream.match(SQL_START, false)) {
        state.sql = true;
        state.ppl = stream.match(PPL_START, false) !== null;
      }
    }
    if (stream.eatSpace()) return null;
    if (state.sql) return queryToken(stream, state.ppl ? PPL_KEYWORD : SQL_KEYWORD);
    if (state.depth === 0 && stream.peek() !== "{" && stream.peek() !== "[") return pathToken(stream);
    return jsonToken(stream, state);
  },
  languageData: { commentTokens: { line: "#" } },
};

export const elasticsearchLanguage = StreamLanguage.define(elasticsearchParser);
