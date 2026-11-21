import { MESSAGE_FORMATS, SCHEMA_TYPES, TOPIC_READ_LIMIT, z } from "@table-craft/plugin-api";
import {
  KEY_ADVANCED_MAX_CURSOR_LENGTH,
  PRODUCE_MAX_HEADERS,
  PRODUCE_TEXT_MAX_LENGTH,
  SCHEMA_TEXT_MAX_LENGTH,
  STREAM_NAME_MAX_LENGTH,
  TOPIC_NAME_MAX_LENGTH,
  TOPIC_TAIL_MAX_MESSAGES,
  TOPIC_TAIL_MAX_RING_BYTES,
  TOPIC_TAIL_MAX_WINDOW,
  TOPIC_TAIL_MAX_WINDOW_BYTES,
} from "@table-craft/desktop/engine/protocol.js";
import { paging, requestId, sessionId, statementLimit } from "@table-craft/desktop/engine/requestParts.js";

/** 2^64 has 20 digits: no Kafka offset or count is longer. */
const DECIMAL_MAX_LENGTH = 20;
const TAIL_ID_MAX_LENGTH = 256;
/** A broker config value, such as a long `follower.replication.throttled.replicas` list. */
const CONFIG_VALUE_MAX_LENGTH = 65_536;

const topic = z.string().min(1).max(TOPIC_NAME_MAX_LENGTH);
const name = z.string().min(1).max(STREAM_NAME_MAX_LENGTH);
const glob = name.nullable();
const partition = z.number().int().nonnegative();
const partitions = z.array(partition).min(1).nullable();
const offset = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .max(DECIMAL_MAX_LENGTH);
const signedOffset = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)$/)
  .max(DECIMAL_MAX_LENGTH + 1);
const timestamp = z.iso.datetime({ offset: true });
const token = z.string().min(1).max(KEY_ADVANCED_MAX_CURSOR_LENGTH);
const format = z.enum(MESSAGE_FORMATS);
const validateOnly = z.boolean();
const text = z.string().max(PRODUCE_TEXT_MAX_LENGTH).nullable();
const tailId = z.string().min(1).max(TAIL_ID_MAX_LENGTH);
const version = z.number().int().positive();
const schemaType = z.enum(SCHEMA_TYPES);
const schema = z.string().min(1).max(SCHEMA_TEXT_MAX_LENGTH);

const start = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("earliest") }),
  z.strictObject({ kind: z.literal("latest") }),
  z.strictObject({ kind: z.literal("latestN"), count: z.number().int().min(1).max(TOPIC_READ_LIMIT) }),
  z.strictObject({ kind: z.literal("offset"), offset }),
  z.strictObject({ kind: z.literal("timestamp"), timestamp }),
  z.strictObject({ kind: z.literal("group"), group: name }),
]);
const readRequest = z.strictObject({
  topic,
  partitions,
  from: start,
  limit: z.number().int().min(1).max(TOPIC_READ_LIMIT),
  keyFormat: format,
  valueFormat: format,
  filter: name.nullable(),
  maxScan: z.number().int().positive().nullable(),
  resume: token.nullable(),
});
const schemaReference = z.strictObject({ subject: name, version: version.nullable() }).nullable();
const record = z.strictObject({
  topic,
  partition: partition.nullable(),
  key: text,
  value: text,
  headers: z.array(z.strictObject({ name, value: text })).max(PRODUCE_MAX_HEADERS),
  keyFormat: format,
  valueFormat: format,
  keySchema: schemaReference,
  valueSchema: schemaReference,
});
const configValue = z.string().max(CONFIG_VALUE_MAX_LENGTH);
const create = z.strictObject({
  name: topic,
  partitions: z.number().int().positive(),
  replicationFactor: z.number().int().positive().nullable(),
  configs: z.array(z.strictObject({ name, value: configValue })),
});
const before = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("offset"), offset }),
  z.strictObject({ kind: z.literal("timestamp"), timestamp }),
  z.strictObject({ kind: z.literal("latest") }),
]);
const resetTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("earliest") }),
  z.strictObject({ kind: z.literal("latest") }),
  z.strictObject({ kind: z.literal("offset"), offset }),
  z.strictObject({ kind: z.literal("timestamp"), timestamp }),
  z.strictObject({ kind: z.literal("shift"), by: signedOffset }),
]);

/** The `topics.*`, `groups.*` and `schemas.*` requests (plan 164), spread into `engineRequestSchema`. */
export const STREAM_REQUESTS = [
  z.strictObject({ id: requestId, type: z.literal("topics.list"), glob, internal: z.boolean() }),
  z.strictObject({ id: requestId, type: z.literal("topics.describe"), topic }),
  z.strictObject({
    id: requestId,
    type: z.literal("topics.open"),
    sessionId,
    request: readRequest,
    spill: z.boolean().optional(),
    ...paging,
    ...statementLimit,
  }),
  z.strictObject({ id: requestId, type: z.literal("topics.message"), handle: z.string().min(1), partition, offset }),
  z.strictObject({ id: requestId, type: z.literal("topics.produce"), record }),
  z.strictObject({ id: requestId, type: z.literal("topics.create"), request: create, validateOnly }),
  z.strictObject({
    id: requestId,
    type: z.literal("topics.alterConfigs"),
    topic,
    changes: z.array(z.strictObject({ name, value: configValue.nullable() })).min(1),
    validateOnly,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("topics.addPartitions"),
    topic,
    total: z.number().int().positive(),
    validateOnly,
  }),
  z.strictObject({ id: requestId, type: z.literal("topics.prepareDeleteRecords"), topic, partitions, before }),
  z.strictObject({ id: requestId, type: z.literal("topics.deleteRecords"), token }),
  z.strictObject({ id: requestId, type: z.literal("topics.delete"), topic }),
  z.strictObject({
    id: requestId,
    type: z.literal("topics.tailStart"),
    topic,
    partitions,
    from: start,
    keyFormat: format,
    valueFormat: format,
    maxMessages: z.number().int().min(1).max(TOPIC_TAIL_MAX_MESSAGES),
    maxBytes: z.number().int().min(1).max(TOPIC_TAIL_MAX_RING_BYTES),
    spill: z.boolean().optional(),
  }),
  z.strictObject({ id: requestId, type: z.literal("topics.tailMessage"), tailId, sequence: offset }),
  z.strictObject({
    id: requestId,
    type: z.literal("topics.tailWindow"),
    tailId,
    after: offset.nullable(),
    count: z.number().int().min(1).max(TOPIC_TAIL_MAX_WINDOW),
    maxBytes: z.number().int().min(1).max(TOPIC_TAIL_MAX_WINDOW_BYTES),
  }),
  z.strictObject({ id: requestId, type: z.literal("topics.tailStop"), tailId }),
  z.strictObject({ id: requestId, type: z.literal("topics.tailClear"), tailId }),
  z.strictObject({ id: requestId, type: z.literal("topics.tailList") }),
  z.strictObject({ id: requestId, type: z.literal("groups.list") }),
  z.strictObject({ id: requestId, type: z.literal("groups.describe"), group: name }),
  z.strictObject({ id: requestId, type: z.literal("groups.consumersOf"), topic }),
  z.strictObject({
    id: requestId,
    type: z.literal("groups.prepareReset"),
    group: name,
    scope: z.strictObject({ topic: topic.nullable(), partitions }),
    target: resetTarget,
  }),
  z.strictObject({ id: requestId, type: z.literal("groups.applyReset"), token }),
  z.strictObject({ id: requestId, type: z.literal("groups.deleteOffsets"), group: name, topic }),
  z.strictObject({ id: requestId, type: z.literal("groups.delete"), group: name }),
  z.strictObject({ id: requestId, type: z.literal("schemas.status") }),
  z.strictObject({ id: requestId, type: z.literal("schemas.subjects"), glob }),
  z.strictObject({ id: requestId, type: z.literal("schemas.versions"), subject: name }),
  z.strictObject({ id: requestId, type: z.literal("schemas.get"), subject: name, version: version.nullable() }),
  z.strictObject({ id: requestId, type: z.literal("schemas.check"), subject: name, schemaType, schema }),
  z.strictObject({ id: requestId, type: z.literal("schemas.register"), subject: name, schemaType, schema }),
  z.strictObject({
    id: requestId,
    type: z.literal("schemas.compatibility"),
    subject: name.nullable(),
    level: name.nullable(),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("schemas.delete"),
    subject: name,
    version: version.nullable(),
    permanent: z.boolean(),
  }),
] as const;
