import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { highlighterOf, keywordDialectOf } from "@table-craft/desktop/renderer/console/Editor.js";
import {
  elasticsearchLanguage,
  elasticsearchParser,
} from "@table-craft/desktop/renderer/console/highlighters/elasticsearch.js";

const INDENT = 2;

/** Each line's styled tokens, `style:text`; the state carries over lines as in the editor. */
function tokens(...lines: string[]): string[][] {
  const state = elasticsearchParser.startState?.(INDENT) ?? { depth: 0, sql: false, ppl: false };
  return lines.map((line) => {
    if (line === "") elasticsearchParser.blankLine?.(state, INDENT);
    const stream = new StringStream(line, INDENT, INDENT);
    const found: string[] = [];
    while (!stream.eol()) {
      const style = elasticsearchParser.token(stream, state);
      if (style !== null) found.push(`${style}:${stream.current().trim()}`);
      stream.start = stream.pos;
    }
    return found;
  });
}

describe("elasticsearch highlighter", () => {
  it("givenHighlightElasticsearch_whenEditorBuilt_thenCommandHighlighterAndNoSqlKeywords", () => {
    expect(highlighterOf({ capabilities: ["commands"], highlight: "elasticsearch" })).toBe(elasticsearchLanguage);
    expect(keywordDialectOf({ capabilities: ["commands"], highlight: "elasticsearch" })).toBeNull();
  });

  it("givenRequestWithBody_whenTokenized_thenMethodEndpointKeysAndValues", () => {
    expect(tokens("GET products/_search?size=5", '{ "query": { "term": { "sku": "p-1" } },', '"size": 5 }')).toEqual([
      ["keyword:GET", "variableName:products", "punctuation:/", "typeName:_search", "name.special:?size=5"],
      [
        "punctuation:{",
        'propertyName:"query"',
        "punctuation::",
        "punctuation:{",
        'propertyName:"term"',
        "punctuation::",
        "punctuation:{",
        'propertyName:"sku"',
        "punctuation::",
        'string:"p-1"',
        "punctuation:}",
        "punctuation:}",
        "punctuation:,",
      ],
      ['propertyName:"size"', "punctuation::", "number:5", "punctuation:}"],
    ]);
  });

  it("givenCommentsAndSql_whenTokenized_thenCommentAndSqlKeywords", () => {
    expect(tokens("# counts", "SELECT category FROM products", "", "GET _cat/indices")).toEqual([
      ["lineComment:# counts"],
      ["keyword:SELECT", "keyword:FROM"],
      [],
      ["keyword:GET", "typeName:_cat", "punctuation:/", "variableName:indices"],
    ]);
  });
});
