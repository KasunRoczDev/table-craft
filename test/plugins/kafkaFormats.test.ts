import { describe, expect, it } from "vitest";
import { avroCodec } from "@table-craft/plugin-kafka/avro";
import { decode, encodePlain, schemaIdOf, type SchemaLookup } from "@table-craft/plugin-kafka/formats";
import { jsonSchemaCodec, jsonSchemaProblems } from "@table-craft/plugin-kafka/jsonSchema";
import { confluentHeader } from "@table-craft/plugin-kafka/produce";
import { protobufCodec, readMessageIndexes, writeMessageIndexes } from "@table-craft/plugin-kafka/protobuf";
import type { RegistryCodec } from "@table-craft/plugin-kafka/codec";

const ORDER_SCHEMA = JSON.stringify({
  type: "record",
  name: "Order",
  fields: [
    { name: "id", type: "string" },
    { name: "amount", type: "long" },
    { name: "note", type: ["null", "string"], default: null },
  ],
});
const PAYMENT_PROTO = `syntax = "proto3";
package pay;
message Envelope { string trace = 1; }
message Payment {
  string id = 1;
  int64 cents = 2;
  message Line { string sku = 1; int32 qty = 2; }
  repeated Line lines = 3;
}`;

function lookupOf(...codecs: RegistryCodec[]): SchemaLookup {
  return {
    codec: (id) => codecs.find((codec) => codec.id === id) ?? null,
    failure: () => null,
  };
}

const PLAIN = { lookup: null, fullBytes: false } as const;

describe("kafka formats", () => {
  it("givenConfluentPrefix_whenAuto_thenRegistryDecoder", () => {
    const codec = avroCodec(7, ORDER_SCHEMA, []);
    const bytes = Buffer.concat([confluentHeader(7), codec.encode({ id: "o-1", amount: 1250, note: "gift" })]);
    expect(schemaIdOf(bytes)).toBe(7);
    const decoded = decode(bytes, "auto", { lookup: lookupOf(codec), fullBytes: false });
    expect(decoded.warning).toBeNull();
    expect(decoded.schema).toBe("AVRO id 7");
    expect(decoded.cell).toEqual({ kind: "json", text: '{"id":"o-1","amount":1250,"note":"gift"}' });
  });

  it("givenConfluentPrefixWithoutRegistry_whenAuto_thenBytesNotText", () => {
    const bytes = Buffer.concat([confluentHeader(7), Buffer.from("text-looking")]);
    expect(decode(bytes, "auto", PLAIN).cell).toMatchObject({ kind: "bytes", length: bytes.length });
  });

  it("givenProtobufWithMessageIndex_whenAuto_thenNestedMessageDecoded", () => {
    const codec = protobufCodec(9, PAYMENT_PROTO, []);
    expect(readMessageIndexes(writeMessageIndexes([1, 0])).indexes).toEqual([1, 0]);
    expect(writeMessageIndexes([0])).toEqual(Buffer.from([0]));
    const encoded = codec.encode({ trace: "t-1" });
    const decoded = decode(Buffer.concat([confluentHeader(9), encoded]), "protobuf", {
      lookup: lookupOf(codec),
      fullBytes: false,
    });
    expect(decoded.cell).toEqual({ kind: "json", text: '{"trace":"t-1"}' });
  });

  it("givenInt64BigEndian_whenDecoded_thenJavaLayout", () => {
    expect(decode(Buffer.from([0, 0, 0, 0, 0, 0, 1, 0]), "int64", PLAIN).cell).toBe(256);
    expect(decode(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe]), "int64", PLAIN).cell).toBe(-2);
    expect(decode(Buffer.from([0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), "int64", PLAIN).cell).toEqual({
      kind: "bigint",
      value: "9223372036854775807",
    });
    expect(encodePlain("256", "int64")).toEqual(Buffer.from([0, 0, 0, 0, 0, 0, 1, 0]));
    expect(decode(Buffer.from([0, 0, 1, 0]), "int32", PLAIN).cell).toBe(256);
    expect(decode(encodePlain("1.5", "double"), "double", PLAIN).cell).toBe(1.5);
  });

  it("givenBinaryValue_whenAuto_thenBytes", () => {
    const decoded = decode(Buffer.from([0xff, 0x00, 0x10]), "auto", PLAIN);
    expect(decoded.cell).toEqual({ kind: "bytes", preview: "ff0010", length: 3 });
    expect(decoded.text).toBe("ff0010");
    expect(decoded.warning).toBeNull();
  });

  it("givenJsonAndText_whenAuto_thenJsonThenString", () => {
    expect(decode(Buffer.from('{"a":1}'), "auto", PLAIN).cell).toEqual({ kind: "json", text: '{"a":1}' });
    expect(decode(Buffer.from("hello"), "auto", PLAIN).cell).toBe("hello");
    expect(decode(null, "auto", PLAIN).cell).toBeNull();
  });

  it("givenWrongFormat_whenDecoded_thenBytesWithWarning", () => {
    const json = decode(Buffer.from("not json"), "json", PLAIN);
    expect(json.cell).toMatchObject({ kind: "bytes" });
    expect(json.warning).toContain("not valid JSON");
    expect(decode(Buffer.from([1, 2, 3]), "int32", PLAIN).warning).toContain("3 bytes");
    const avro = decode(Buffer.from("plain"), "avro", PLAIN);
    expect(avro.warning).toContain("no Schema Registry header");
  });

  it("givenAvroSchemaForProtobufFormat_whenDecoded_thenWarningNamesType", () => {
    const codec = avroCodec(3, ORDER_SCHEMA, []);
    const bytes = Buffer.concat([confluentHeader(3), codec.encode({ id: "x", amount: 1, note: null })]);
    expect(decode(bytes, "protobuf", { lookup: lookupOf(codec), fullBytes: false }).warning).toContain("AVRO");
  });

  it("givenInvalidValue_whenValidated_thenProblemsNamePath", () => {
    expect(avroCodec(1, ORDER_SCHEMA, []).validate({ id: "x", amount: "lots" }).join()).toContain("amount");
    expect(
      jsonSchemaProblems('{"type":"object","required":["id"],"properties":{"n":{"type":"integer"}}}', { n: 1.5 }),
    ).toEqual(["id is required", "n is number, not integer"]);
    expect(jsonSchemaCodec(2, '{"type":"object"}').validate({})).toEqual([]);
  });
});
