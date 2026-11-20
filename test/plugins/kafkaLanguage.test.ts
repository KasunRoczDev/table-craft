import { describe, expect, it } from "vitest";
import { argumentsOf } from "@table-craft/plugin-kafka/args";
import { complete, signatureAt } from "@table-craft/plugin-kafka/complete";
import { commandOf } from "@table-craft/plugin-kafka/docs";
import { classify, COSTLY_INSPECTION, inspect, split } from "@table-craft/plugin-kafka/language";
import { noteTopicSize } from "@table-craft/plugin-kafka/sizes";
import { tokenize } from "@table-craft/plugin-kafka/tokens";

function at(text: string, caret = text.length) {
  return { text, offset: caret };
}

describe("kafka console split", () => {
  it("givenProduceWithJsonOverLines_whenSplit_thenOneCommand", () => {
    const text = 'topics\nproduce orders {\n  "id": 1,\n  "items": [1,\n    2]\n}\n# a comment\nbrokers';
    const spans = split(text);
    expect(spans.map((span) => span.sql.split("\n")[0])).toEqual(["topics", "produce orders {", "brokers"]);
    expect(spans[1]?.sql.endsWith("}")).toBe(true);
    expect(text.slice(spans[1]?.from, spans[1]?.to)).toBe(spans[1]?.sql);
  });

  it("givenQuotedValueOverLines_whenSplit_thenOneCommand", () => {
    const spans = split('produce t "line one\nline two"\ngroups');
    expect(spans).toHaveLength(2);
    expect(tokenize(spans[0]?.sql ?? "").at(-1)?.text).toBe("line one\nline two");
  });

  it("givenJsonValue_whenTokenized_thenOneVerbatimToken", () => {
    const tokens = tokenize('produce t {"a": "b c", "d": [1, {"e": "}"}]} --key k');
    expect(tokens.map((token) => token.text)).toEqual([
      "produce",
      "t",
      '{"a": "b c", "d": [1, {"e": "}"}]}',
      "--key",
      "k",
    ]);
    expect(tokens[2]?.json).toBe(true);
  });
});

describe("kafka console classify", () => {
  it("givenDeleteTopic_whenClassify_thenConfirmByName", () => {
    expect(classify("delete-topic orders.v1")).toMatchObject({ kind: "write", confirmByName: true });
    expect(classify("delete-topic orders.v1").destructive).toContain("orders.v1");
    expect(classify("delete-records orders.v1 3 1200")).toMatchObject({ kind: "write", confirmByName: true });
    expect(classify("delete-group billing")).toMatchObject({ kind: "write" });
    expect(classify("delete-group billing").confirmByName).toBeUndefined();
  });

  it("givenResetDryRun_whenClassify_thenRead", () => {
    expect(classify("reset-offsets billing orders --to earliest --dry-run")).toEqual({
      kind: "read",
      destructive: null,
    });
    const apply = classify("reset-offsets billing orders --to earliest");
    expect(apply.kind).toBe("write");
    expect(apply.destructive).toContain("billing");
  });

  it("givenCompatibilityWithLevel_whenClassify_thenWrite", () => {
    expect(classify("compatibility orders-value").kind).toBe("read");
    expect(classify("compatibility orders-value FULL").kind).toBe("write");
    expect(classify("compatibility --global").kind).toBe("read");
    expect(classify("compatibility --global NONE").kind).toBe("write");
  });

  it("givenReadsAndWrites_whenClassify_thenKindsOfDecision10", () => {
    for (const read of ["topics", "describe t", "consume t --limit 5", "lag g", "groups", "schema s", "brokers"]) {
      expect(classify(read).kind).toBe("read");
    }
    for (const write of [
      "produce t v",
      "create-topic t",
      "alter-config topic t a=b",
      "add-partitions t 4",
      "register s AVRO {}",
    ]) {
      expect(classify(write).kind).toBe("write");
    }
    expect(classify("nonsense").kind).toBe("other");
  });

  it("givenConsumeWithoutLimitOnBigTopic_whenInspect_thenCostlyWithFix", async () => {
    noteTopicSize("big.topic", "1200000");
    noteTopicSize("small.topic", "10");
    expect(classify("consume big.topic").costly).toContain("--limit");
    expect(classify("consume big.topic --limit 10").costly).toBeUndefined();
    expect(classify("consume big.topic --from -50").costly).toBeUndefined();
    expect(classify("consume small.topic").costly).toBeUndefined();
    const text = "topics\nconsume big.topic --grep cust-42";
    const problems = await inspect({ text });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.inspection).toBe(COSTLY_INSPECTION);
    expect(problems[0]?.fixes[0]?.edits[0]?.insert).toBe("consume big.topic --grep cust-42 --limit 500");
    expect(await inspect({ text, disabled: [COSTLY_INSPECTION] })).toEqual([]);
  });
});

describe("kafka console arguments", () => {
  it("givenRepeatedHeaders_whenParsed_thenAllKept", () => {
    const doc = commandOf("produce");
    if (doc === null) throw new Error("no produce");
    const args = argumentsOf(doc, tokenize("t v --header a=1 --header=b=2"));
    expect(args.flags.get("header")).toEqual(["a=1", "b=2"]);
    expect(args.positional.map((token) => token.text)).toEqual(["t", "v"]);
  });

  it("givenUnknownFlag_whenParsed_thenRefusedNamingFlags", () => {
    const doc = commandOf("consume");
    if (doc === null) throw new Error("no consume");
    expect(() => argumentsOf(doc, tokenize("t --nope 1"))).toThrow(/--nope.*--partitions/s);
  });

  it("givenShortPartitionFlagAndLatestN_whenParsed_thenValuesTaken", () => {
    const doc = commandOf("consume");
    if (doc === null) throw new Error("no consume");
    const args = argumentsOf(doc, tokenize("t -p 0,3 --from -5"));
    expect(args.flags.get("partitions")).toEqual(["0,3"]);
    expect(args.flags.get("from")).toEqual(["-5"]);
  });
});

describe("kafka console completion", () => {
  it("givenPartialFlag_whenComplete_thenFlagsOfThatCommand", async () => {
    const result = await complete(at("consume orders --va"), null);
    const labels = result.items.map((item) => item.label);
    expect(labels).toContain("--value-format");
    expect(labels).toContain("--limit");
    expect(labels).not.toContain("--dry-run");
    expect(result.from).toBe("consume orders ".length);
  });

  it("givenFormatFlag_whenComplete_thenFormats", async () => {
    const result = await complete(at("consume orders --value-format "), null);
    expect(result.items.map((item) => item.label)).toContain("avro");
  });

  it("givenTopicArgument_whenComplete_thenSessionTopics", async () => {
    const session = {
      suggestNames: (kind: string, prefix: string) =>
        Promise.resolve(kind === "topic" ? ["orders.v1", "orders.v2"].filter((name) => name.startsWith(prefix)) : []),
    };
    const result = await complete(at("describe ord"), session as never);
    expect(result.items.map((item) => item.label)).toEqual(["orders.v1", "orders.v2"]);
  });

  it("givenEmptyLine_whenComplete_thenCommands", async () => {
    const result = await complete(at(""), null);
    expect(result.items.map((item) => item.label)).toContain("reset-offsets");
  });

  it("givenCaretInArguments_whenSignature_thenArgumentIndex", async () => {
    const help = await signatureAt(at("delete-records orders 3 "), null);
    expect(help?.name).toBe("delete-records");
    expect(help?.argument).toBe(2);
  });
});
