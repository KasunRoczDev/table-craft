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

const LIST_SCHEMA = JSON.stringify({
  type: "record",
  name: "Batch",
  fields: [
    { name: "items", type: { type: "array", items: "null" } },
    { name: "tags", type: { type: "map", values: "null" } },
  ],
});
const WIDE_SCHEMA = JSON.stringify({
  type: "record",
  name: "Wide",
  fields: [
    { name: "big", type: "long" },
    { name: "either", type: ["null", "int", "long"] },
    { name: "raw", type: "bytes" },
    { name: "hash", type: { type: "fixed", name: "Hash", size: 2 } },
  ],
});
const CUSTOMER_PROTO = `syntax = "proto3";
package shop;
message Customer { string name = 1; }`;
const ORDER_PROTO = `syntax = "proto3";
package shop;
import "customer.proto";
import "google/protobuf/timestamp.proto";
message Order { string id = 1; Customer customer = 2; google.protobuf.Timestamp placed = 3; }`;
const DECODE_BUDGET_MS = 500;

function registryBytes(codec: RegistryCodec, payload: Buffer): Buffer {
  return Buffer.concat([confluentHeader(codec.id), payload]);
}

describe("kafka formats against hostile or wide payloads", () => {
  it("givenAvroBlockCountBeyondPayload_whenDecoded_thenBytesWithWarningAtOnce", () => {
    const codec = avroCodec(4, LIST_SCHEMA, []);
    const started = performance.now();
    // Zig-zag 0x80 0x80 0x80 0x80 0x08 is 2^31 items of a zero-width type in a 5-byte payload.
    const decoded = decode(registryBytes(codec, Buffer.from([0x80, 0x80, 0x80, 0x80, 0x08])), "auto", {
      lookup: lookupOf(codec),
      fullBytes: false,
    });
    expect(performance.now() - started).toBeLessThan(DECODE_BUDGET_MS);
    expect(decoded.cell).toMatchObject({ kind: "bytes" });
    expect(decoded.warning).not.toBeNull();
  });

  it("givenLongAboveTwoToThe53AndBytes_whenRoundTripped_thenExactAndBase64", () => {
    const codec = avroCodec(5, WIDE_SCHEMA, []);
    const value = { big: "9007199254740993", either: { long: 7 }, raw: "AAE=", hash: "AQI=" };
    const written = JSON.parse(
      `{"big":9007199254740993,"either":{"long":7},"raw":"${value.raw}","hash":"${value.hash}"}`,
    ) as unknown;
    expect(codec.validate({ ...(written as object), big: 9007199254740993n })).toEqual([]);
    const payload = codec.encode({ ...(written as object), big: 9007199254740993n });
    const decoded = decode(registryBytes(codec, payload), "avro", { lookup: lookupOf(codec), fullBytes: false });
    expect(decoded.warning).toBeNull();
    expect(decoded.cell).toEqual({
      kind: "json",
      text: '{"big":"9007199254740993","either":{"long":7},"raw":"AAE=","hash":"AQI="}',
    });
    expect(codec.validate({ big: 1.5, either: null, raw: "", hash: "AQI=" }).join()).toContain("big: 1.5 is not long");
  });

  it("givenProtobufReferenceInSamePackage_whenEncodedAndDecoded_thenMainMessage", () => {
    const codec = protobufCodec(6, ORDER_PROTO, [{ name: "customer.proto", schema: CUSTOMER_PROTO }]);
    const value = { id: "o-1", customer: { name: "Ann" }, placed: { seconds: "5", nanos: 0 } };
    expect(codec.validate(value)).toEqual([]);
    const payload = codec.encode(value);
    expect(payload[0]).toBe(0);
    const decoded = decode(registryBytes(codec, payload), "protobuf", { lookup: lookupOf(codec), fullBytes: false });
    expect(decoded.warning).toBeNull();
    expect(JSON.parse((decoded.cell as { text: string }).text)).toMatchObject({ id: "o-1", customer: { name: "Ann" } });
  });

  it("givenProtobufValueWithUnknownField_whenValidated_thenNamesThePath", () => {
    const codec = protobufCodec(6, ORDER_PROTO, [{ name: "customer.proto", schema: CUSTOMER_PROTO }]);
    expect(codec.validate({ id: "o-1", customer: { nmae: "Ann" } })).toEqual([
      "customer.nmae: Customer has no field nmae",
    ]);
  });

  it("givenPlainNumbers_whenEncoded_thenEmptyAndOutOfRangeRefused", () => {
    expect(() => encodePlain("", "int32")).toThrow(/the text is empty/);
    expect(() => encodePlain("  ", "int64")).toThrow(/the text is empty/);
    expect(() => encodePlain("2147483648", "int32")).toThrow(/-2147483648 to 2147483647/);
    expect(encodePlain("-2147483648", "int32")).toEqual(Buffer.from([0x80, 0, 0, 0]));
  });

  it("givenJsonSchemaIntegerAboveTwoToThe53_whenProducedAndRead_thenDigitsKept", () => {
    const codec = jsonSchemaCodec(8, '{"type":"object","properties":{"id":{"type":"integer"}}}');
    const text = '{"id":9007199254740993}';
    const payload = codec.encodeText?.(text, JSON.parse(text)) ?? Buffer.alloc(0);
    expect(payload.toString("utf8")).toBe(text);
    const decoded = decode(registryBytes(codec, payload), "auto", { lookup: lookupOf(codec), fullBytes: false });
    expect(decoded.cell).toEqual({ kind: "json", text });
  });
});
