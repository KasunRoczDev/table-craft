import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decode, schemaIdOf } from "@table-craft/plugin-kafka/formats";
import { encodeWithSchema } from "@table-craft/plugin-kafka/produce";
import { KafkaSchemaRegistry, NO_REGISTRY_REASON, UnavailableRegistry } from "@table-craft/plugin-kafka/registry";
import { RegistryClient, RegistryError } from "@table-craft/plugin-kafka/registryClient";
import { MAX_IDS_PER_PREPARE, RETRY_AFTER_MS, SchemaCache } from "@table-craft/plugin-kafka/schemaCache";
import { startSchemaRegistryMock, type SchemaRegistryMock } from "../support/schemaRegistryMock.js";

const TIMEOUT_MS = 5000;
const HUNG_TIMEOUT_MS = 300;
const ORDER_V1 = JSON.stringify({
  type: "record",
  name: "Order",
  fields: [
    { name: "id", type: "string" },
    { name: "amount", type: "long" },
  ],
});
const ORDER_V2 = JSON.stringify({
  type: "record",
  name: "Order",
  fields: [
    { name: "id", type: "string" },
    { name: "amount", type: "long" },
    { name: "currency", type: "string", default: "EUR" },
  ],
});
const ORDER_BREAKING = JSON.stringify({
  type: "record",
  name: "Order",
  fields: [
    { name: "id", type: "string" },
    { name: "region", type: "string" },
  ],
});
const PAYMENT_PROTO = 'syntax = "proto3";\nmessage Payment { string id = 1; int64 cents = 2; }';

let mock: SchemaRegistryMock;
let client: RegistryClient;

beforeAll(async () => {
  mock = await startSchemaRegistryMock();
  client = new RegistryClient({ url: mock.url, basicAuth: null, tls: null, timeoutMs: TIMEOUT_MS });
});

afterAll(async () => {
  await mock.close();
});

describe("kafka schema registry", () => {
  it("givenSubjects_whenVersions_thenBothVersionsAndCompatibility", async () => {
    const registry = new KafkaSchemaRegistry(client, false);
    const first = await registry.register("orders.v1-value", "AVRO", ORDER_V1);
    const second = await registry.register("orders.v1-value", "AVRO", ORDER_V2);
    expect(first).toEqual({ id: first.id, version: 1 });
    expect(second.version).toBe(2);
    expect(await registry.versions("orders.v1-value")).toEqual([1, 2]);
    expect(await registry.subjects("orders.*")).toEqual([
      { subject: "orders.v1-value", latestVersion: 2, type: "AVRO" },
    ]);
    const latest = await registry.get("orders.v1-value", null);
    expect(latest).toMatchObject({ version: 2, id: second.id, type: "AVRO", schema: ORDER_V2 });
    expect(await registry.compatibility("orders.v1-value", null)).toBe("BACKWARD");
    expect(await registry.compatibility("orders.v1-value", "full")).toBe("FULL");
    expect(await registry.compatibility(null, null)).toBe("BACKWARD");
  });

  it("givenIncompatibleSchema_whenCheck_thenRegistryMessages", async () => {
    const registry = new KafkaSchemaRegistry(client, false);
    await registry.register("audit-value", "AVRO", ORDER_V1);
    const check = await registry.check("audit-value", "AVRO", ORDER_BREAKING);
    expect(check.compatible).toBe(false);
    expect(check.messages.join()).toContain("region");
    expect(await registry.check("fresh-value", "AVRO", ORDER_BREAKING)).toEqual({ compatible: true, messages: [] });
    await expect(registry.register("audit-value", "AVRO", ORDER_BREAKING)).rejects.toThrow(/409.*incompatible/s);
  });

  it("givenMissingSubject_whenGet_thenTypedErrorWithStatus", async () => {
    const error: unknown = await client.version("nope", null).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(RegistryError);
    expect((error as RegistryError).status).toBe(404);
    expect((error as RegistryError).message).toContain("40401");
  });

  it("givenSoftDelete_whenRemoved_thenVersionGone", async () => {
    const registry = new KafkaSchemaRegistry(client, false);
    await registry.register("temp-value", "JSON", '{"type":"object"}');
    expect(await registry.remove("temp-value", 1, false)).toEqual([1]);
    await expect(registry.versions("temp-value")).rejects.toThrow(/40401/);
  });

  it("givenAvroSubject_whenEncodedThenReadAuto_thenDecodedWithSchemaId", async () => {
    const registry = new KafkaSchemaRegistry(client, false);
    const { id } = await registry.register("pay-value", "PROTOBUF", PAYMENT_PROTO);
    const bytes = await encodeWithSchema(registry.cache, "pay-value", null, "protobuf", '{"id":"p-1","cents":"1250"}');
    expect(schemaIdOf(bytes)).toBe(id);
    const decoded = decode(bytes, "auto", { lookup: registry.cache, fullBytes: false });
    expect(decoded.schema).toBe(`PROTOBUF id ${String(id)}`);
    expect(decoded.cell).toEqual({ kind: "json", text: '{"id":"p-1","cents":"1250"}' });
  });

  it("givenAvroSubject_whenProduceInvalidValue_thenRefusedBeforeSend", async () => {
    const registry = new KafkaSchemaRegistry(client, false);
    await registry.register("strict-value", "AVRO", ORDER_V1);
    await expect(
      encodeWithSchema(registry.cache, "strict-value", null, "avro", '{"id":"o-1","amount":"many"}'),
    ).rejects.toThrow(/does not fit strict-value.*amount.*Nothing was sent/s);
    await expect(encodeWithSchema(registry.cache, "strict-value", null, "protobuf", "{}")).rejects.toThrow(
      /AVRO schema, not protobuf/,
    );
  });

  it("givenReadOnly_whenRegister_thenRefusedBeforeRequest", () => {
    const before = mock.requests.length;
    const registry = new KafkaSchemaRegistry(client, true);
    expect(() => registry.register("ro-value", "AVRO", ORDER_V1)).toThrow(/read-only/);
    expect(mock.requests.length).toBe(before);
  });

  it("givenPermanentDelete_whenNotSoftDeletedFirst_thenSoftThenHardDelete", async () => {
    const registry = new KafkaSchemaRegistry(client, false);
    await registry.register("gone-value", "JSON", '{"type":"object"}');
    await registry.register("gone-value", "JSON", '{"type":"object","title":"two"}');
    expect(await registry.remove("gone-value", 1, true)).toEqual([1]);
    expect(await registry.remove("gone-value", null, true)).toEqual([2]);
    await expect(client.remove("gone-value", null, false)).rejects.toThrow(/40401/);
  });

  it("givenSubjectWithoutOwnLevel_whenCompatibility_thenGlobalLevel", async () => {
    const before = mock.requests.length;
    expect(await client.compatibility("no-level-value")).toBe("BACKWARD");
    expect(mock.requests.slice(before)).toEqual(["GET /config/no-level-value"]);
  });

  it("givenUnauthorized_whenRead_thenStatusInError", async () => {
    mock.failNext("unauthorized");
    const error: unknown = await client.subjects().catch((cause: unknown) => cause);
    expect((error as RegistryError).status).toBe(401);
  });

  it("givenServerErrorOnRegister_whenWritten_thenOutcomeUnknown", async () => {
    const registry = new KafkaSchemaRegistry(client, false);
    mock.failNext("serverError");
    const error: unknown = await registry.register("maybe-value", "AVRO", ORDER_V1).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "statementFailed", outcome: "unknown" });
    expect((error as Error).message).toMatch(/may have been applied/);
    mock.failNext("serverError");
    const read: unknown = await client.subjects().catch((cause: unknown) => cause);
    expect(read).toBeInstanceOf(RegistryError);
    expect((read as { outcome?: unknown }).outcome).toBeUndefined();
  });

  it("givenHungRegistry_whenRead_thenTimesOutWithinTheDeadline", async () => {
    const quick = new RegistryClient({ url: mock.url, basicAuth: null, tls: null, timeoutMs: HUNG_TIMEOUT_MS });
    mock.failNext("hang");
    const started = Date.now();
    await expect(quick.subjects()).rejects.toThrow(`no answer within ${String(HUNG_TIMEOUT_MS)} ms`);
    expect(Date.now() - started).toBeLessThan(HUNG_TIMEOUT_MS * 4);
  });

  it("givenDotSubject_whenRequested_thenRefusedBeforeRequest", async () => {
    const before = mock.requests.length;
    await expect(client.versions("..")).rejects.toThrow(/cannot be named/);
    expect(mock.requests.length).toBe(before);
  });

  it("givenUrlWithCredentials_whenShown_thenCredentialsLeftOut", () => {
    const secret = new RegistryClient({
      url: "http://user:hunter2@127.0.0.1:1",
      basicAuth: null,
      tls: null,
      timeoutMs: TIMEOUT_MS,
    });
    expect(secret.url).not.toContain("hunter2");
  });

  it("givenTransientFailure_whenPrepared_thenRetriedAfterTheDelayAndMissingIdCached", async () => {
    const { id } = mock.register("cache-value", "AVRO", ORDER_V1);
    let now = 0;
    const cache = new SchemaCache(client, () => now);
    mock.failNext("serverError");
    await cache.prepare([id]);
    expect(cache.codec(id)).toBeNull();
    expect(cache.failure(id)).toContain("500");
    await cache.prepare([id]);
    expect(cache.codec(id)).toBeNull();
    now += RETRY_AFTER_MS;
    await cache.prepare([id]);
    expect(cache.codec(id)?.id).toBe(id);
    const missing = 9_999;
    await cache.prepare([missing]);
    const asked = mock.requests.length;
    now += RETRY_AFTER_MS;
    await cache.prepare([missing]);
    expect(mock.requests.length).toBe(asked);
    expect(cache.failure(missing)).toContain("40403");
  });

  it("givenMoreIdsThanTheCap_whenPrepared_thenOnlyTheCapAskedThisBatch", async () => {
    const cache = new SchemaCache(client);
    const before = mock.requests.length;
    await cache.prepare(Array.from({ length: MAX_IDS_PER_PREPARE + 5 }, (_, index) => 50_000 + index));
    expect(mock.requests.length - before).toBe(MAX_IDS_PER_PREPARE);
  });

  it("givenNoRegistryUrl_whenSchemaRegistry_thenUnavailableWithReason", async () => {
    const registry = new UnavailableRegistry();
    expect(registry.available).toBe(false);
    expect(registry.reason).toBe(NO_REGISTRY_REASON);
    await expect(registry.subjects()).rejects.toThrow(NO_REGISTRY_REASON);
  });
});
