import { StringStream } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { highlighterOf, keywordDialectOf } from "@table-craft/desktop/renderer/console/Editor.js";
import { kafkaLanguage, kafkaParser } from "@table-craft/desktop/renderer/console/highlighters/kafka.js";

const INDENT = 2;

/** Each line's styled tokens, `style:text`; the state carries over lines as in the editor. */
function tokens(...lines: string[]): string[][] {
  const state = kafkaParser.startState?.(INDENT) ?? { commandSeen: false, jsonDepth: 0 };
  return lines.map((line) => {
    if (line === "") kafkaParser.blankLine?.(state, INDENT);
    const stream = new StringStream(line, INDENT, INDENT);
    const found: string[] = [];
    while (!stream.eol()) {
      const style = kafkaParser.token(stream, state);
      if (style !== null) found.push(`${style}:${stream.current()}`);
      stream.start = stream.pos;
    }
    return found;
  });
}

describe("kafka highlighter", () => {
  it("givenHighlightKafka_whenEditorBuilt_thenCommandHighlighterAndNoSqlKeywords", () => {
    expect(highlighterOf({ capabilities: ["commands"], highlight: "kafka" })).toBe(kafkaLanguage);
    expect(keywordDialectOf({ capabilities: ["commands"], highlight: "kafka" })).toBeNull();
  });

  it("givenConsumeWithFlags_whenTokenized_thenCommandFlagsAndValues", () => {
    expect(tokens("consume orders.v1 -p 3,7 --from -500 --grep cust-42")).toEqual([
      ["keyword:consume", "name.special:-p", "name.special:--from", "number:-500", "name.special:--grep"],
    ]);
  });

  it("givenProduceWithJsonOverLines_whenTokenized_thenJsonStyledAndNextLineIsACommand", () => {
    expect(tokens('produce orders.v1 --key "cust-42" {', '  "total": 12.5, "paid": true', "}", "brokers")).toEqual([
      ["keyword:produce", "name.special:--key", 'string:"cust-42"', "punctuation:{"],
      [
        'string:"total"',
        "punctuation::",
        "number:12.5",
        "punctuation:,",
        'string:"paid"',
        "punctuation::",
        "atom:true",
      ],
      ["punctuation:}"],
      ["keyword:brokers"],
    ]);
  });

  it("givenCommentAndUnknownCommand_whenTokenized_thenCommentStyledAndUnknownPlain", () => {
    expect(tokens("# lag of the billing worker", "lag billing-worker", "frobnicate 1")).toEqual([
      ["lineComment:# lag of the billing worker"],
      ["keyword:lag"],
      ["number:1"],
    ]);
  });
});
