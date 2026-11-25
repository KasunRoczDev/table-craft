import { z } from "@table-craft/plugin-api";
import {
  COMMAND_ADMIT_MAX_COMMANDS,
  COMMAND_ADMIT_MAX_TEXT,
  COMMAND_TXN_MAX_DEPTH,
  COMMAND_TXN_MAX_OPERATIONS,
  KEY_ADVANCED_MAX_BYTES,
  KEY_ADVANCED_MAX_COUNT,
  KEY_ADVANCED_MAX_CURSOR_LENGTH,
  KEY_ADVANCED_MAX_TEXT,
  KEY_ADVANCED_MAX_TIMEOUT_MS,
  KEY_WATCH_MAX_EVENTS,
  KEY_WATCH_MAX_RING_BYTES,
  type CommandTransaction,
} from "@table-craft/desktop/engine/protocol.js";
import { DECIMAL_MAX_LENGTH, index, keyName, leaseId, requestId } from "@table-craft/desktop/engine/requestParts.js";

const ADVANCED_MAX_ID_LENGTH = 256;
const ADVANCED_MAX_NAME_LENGTH = 1_024;
const ADVANCED_MAX_ENDPOINTS = 100;
const advancedId = z.string().min(1).max(ADVANCED_MAX_ID_LENGTH);
const advancedName = z.string().min(1).max(ADVANCED_MAX_NAME_LENGTH);
const advancedToken = z.string().min(1).max(KEY_ADVANCED_MAX_CURSOR_LENGTH);
const advancedCursor = advancedToken.nullable();
const decimal = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/)
  .max(DECIMAL_MAX_LENGTH);
const positiveDecimal = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(DECIMAL_MAX_LENGTH);
const advancedBytes = keyName.extend({
  text: z.string().max(KEY_ADVANCED_MAX_BYTES),
  hex: z
    .string()
    .regex(/^(?:[0-9a-f]{2})*$/)
    .max(KEY_ADVANCED_MAX_BYTES * 2)
    .nullable(),
});
const keyRange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("key"), key: advancedBytes }),
  z.strictObject({ kind: z.literal("prefix"), prefix: advancedBytes }),
  z.strictObject({ kind: z.literal("range"), from: advancedBytes, to: advancedBytes }),
  z.strictObject({ kind: z.literal("all") }),
]);
const advancedCount = z.number().int().min(1).max(KEY_ADVANCED_MAX_COUNT);
const advancedMaxBytes = z.number().int().min(1).max(KEY_ADVANCED_MAX_BYTES);
const advancedTimeout = z.number().int().min(1).max(KEY_ADVANCED_MAX_TIMEOUT_MS);
const leaseAssignment = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preserve") }),
  z.strictObject({ kind: z.literal("detach") }),
  z.strictObject({ kind: z.literal("attach"), leaseId }),
]);
const accessPermission = z.strictObject({ access: z.enum(["read", "write", "readwrite"]), range: keyRange });
const accessChange = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("deleteUser"), user: advancedName }),
  z.strictObject({ kind: z.literal("grantRole"), user: advancedName, role: advancedName }),
  z.strictObject({ kind: z.literal("revokeRole"), user: advancedName, role: advancedName }),
  z.strictObject({ kind: z.literal("createRole"), role: advancedName }),
  z.strictObject({ kind: z.literal("deleteRole"), role: advancedName }),
  z.strictObject({ kind: z.literal("grantPermission"), role: advancedName, permission: accessPermission }),
  z.strictObject({ kind: z.literal("revokePermission"), role: advancedName, range: keyRange }),
  z.strictObject({ kind: z.literal("enableAuth") }),
  z.strictObject({ kind: z.literal("disableAuth") }),
]);
const transactionCompare = z
  .strictObject({
    range: keyRange,
    target: z.enum(["value", "version", "createRevision", "modRevision", "lease"]),
    operator: z.enum(["=", "!=", "<", ">"]),
    operand: z.union([
      advancedBytes,
      z
        .string()
        .regex(/^-?(?:0|[1-9][0-9]*)$/)
        .max(DECIMAL_MAX_LENGTH),
    ]),
  })
  .refine(
    (value) => (value.target === "value" ? typeof value.operand !== "string" : typeof value.operand === "string"),
    {
      message: "Value compares require bytes; revision, version and lease compares require decimal strings.",
    },
  );

function transactionSchema(depth: number): z.ZodType<CommandTransaction> {
  const operations = [
    z.strictObject({ kind: z.literal("get"), range: keyRange }),
    z.strictObject({ kind: z.literal("delete"), range: keyRange }),
    z.strictObject({ kind: z.literal("put"), key: advancedBytes, value: advancedBytes, lease: leaseAssignment }),
  ] as const;
  const operation =
    depth === 0
      ? z.discriminatedUnion("kind", operations)
      : z.discriminatedUnion("kind", [
          ...operations,
          z.strictObject({ kind: z.literal("txn"), transaction: transactionSchema(depth - 1) }),
        ]);
  return z.strictObject({
    compare: z.array(transactionCompare).max(COMMAND_TXN_MAX_OPERATIONS),
    success: z.array(operation).max(COMMAND_TXN_MAX_OPERATIONS),
    failure: z.array(operation).max(COMMAND_TXN_MAX_OPERATIONS),
  });
}

function transactionBudget(transaction: CommandTransaction): number {
  let count = transaction.compare.length + transaction.success.length + transaction.failure.length;
  for (const operation of [...transaction.success, ...transaction.failure]) {
    if (count > COMMAND_TXN_MAX_OPERATIONS) return count;
    if (operation.kind === "txn") count += transactionBudget(operation.transaction);
  }
  return count;
}

const commandTransaction = transactionSchema(COMMAND_TXN_MAX_DEPTH).refine(
  (transaction) => transactionBudget(transaction) <= COMMAND_TXN_MAX_OPERATIONS,
  { message: "Transaction exceeds the total operation budget." },
);
const endpointIds = z
  .array(advancedId)
  .min(1)
  .max(ADVANCED_MAX_ENDPOINTS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "Endpoint IDs must be unique." });
const transferScope = { fileGrantId: advancedId, database: index, range: keyRange };

/** The key-value requests beyond reading and editing keys: keyspace ranges, leases, watches, cluster, access, transactions and transfers. */
export const ADVANCED_REQUESTS = [
  z.strictObject({ id: requestId, type: z.literal("keyspace.features") }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyspace.children"),
    database: index,
    range: keyRange,
    parent: advancedBytes,
    cursor: advancedCursor,
    count: advancedCount,
    timeoutMs: advancedTimeout,
  }),
  z.strictObject({ id: requestId, type: z.literal("keyspace.countRange"), database: index, range: keyRange }),
  z.strictObject({ id: requestId, type: z.literal("keyspace.prepareDelete"), database: index, range: keyRange }),
  z.strictObject({ id: requestId, type: z.literal("keyspace.deletePrepared"), token: advancedToken }),
  z.strictObject({ id: requestId, type: z.literal("leases.list") }),
  z.strictObject({ id: requestId, type: z.literal("leases.get"), leaseId }),
  z.strictObject({
    id: requestId,
    type: z.literal("leases.keys"),
    leaseId,
    cursor: advancedCursor,
    count: advancedCount,
  }),
  z.strictObject({ id: requestId, type: z.literal("leases.grant"), ttlSeconds: positiveDecimal }),
  z.strictObject({ id: requestId, type: z.literal("leases.keepAliveOnce"), leaseId }),
  z.strictObject({ id: requestId, type: z.literal("leases.keepAliveStart"), leaseId }),
  z.strictObject({ id: requestId, type: z.literal("leases.keepAliveStop"), keepAliveId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("leases.prepareRevoke"), leaseId }),
  z.strictObject({ id: requestId, type: z.literal("leases.revokePrepared"), token: advancedToken }),
  z.strictObject({
    id: requestId,
    type: z.literal("watch.start"),
    database: index,
    range: keyRange,
    from: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("now") }),
      z.strictObject({ kind: z.literal("revision"), revision: positiveDecimal }),
    ]),
    maxEvents: z.number().int().min(1).max(KEY_WATCH_MAX_EVENTS),
    maxBytes: z.number().int().min(1).max(KEY_WATCH_MAX_RING_BYTES),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("watch.window"),
    watchId: advancedId,
    afterSequence: decimal.nullable(),
    count: advancedCount,
    maxBytes: advancedMaxBytes,
  }),
  z.strictObject({ id: requestId, type: z.literal("watch.stop"), watchId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("watch.clear"), watchId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("watch.list") }),
  z.strictObject({ id: requestId, type: z.literal("watch.exportStart"), watchId: advancedId, fileGrantId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("watch.exportList") }),
  z.strictObject({ id: requestId, type: z.literal("watch.exportCancel"), taskId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("cluster.endpoints") }),
  z.strictObject({ id: requestId, type: z.literal("cluster.members") }),
  z.strictObject({ id: requestId, type: z.literal("cluster.status"), endpointId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("cluster.alarms") }),
  z.strictObject({
    id: requestId,
    type: z.literal("cluster.disarm"),
    alarm: z.strictObject({ memberId: positiveDecimal, kind: z.enum(["NOSPACE", "CORRUPT", "unknown"]) }),
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("cluster.compact"),
    revision: positiveDecimal,
    physical: z.boolean(),
  }),
  z.strictObject({ id: requestId, type: z.literal("cluster.promote"), memberId: positiveDecimal }),
  z.strictObject({ id: requestId, type: z.literal("cluster.remove"), memberId: positiveDecimal }),
  z.strictObject({ id: requestId, type: z.literal("maintenance.defragmentStart"), endpointIds }),
  z.strictObject({
    id: requestId,
    type: z.literal("maintenance.snapshotStart"),
    endpointId: advancedId,
    fileGrantId: advancedId,
  }),
  z.strictObject({ id: requestId, type: z.literal("maintenance.consistencyStart"), endpointIds, revision: decimal }),
  z.strictObject({ id: requestId, type: z.literal("maintenance.list") }),
  z.strictObject({ id: requestId, type: z.literal("maintenance.cancel"), taskId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("access.status") }),
  z.strictObject({ id: requestId, type: z.literal("access.users") }),
  z.strictObject({ id: requestId, type: z.literal("access.roles") }),
  z.strictObject({ id: requestId, type: z.literal("access.apply"), change: accessChange }),
  z.strictObject({ id: requestId, type: z.literal("coordination.prefixes") }),
  z.strictObject({
    id: requestId,
    type: z.literal("coordination.read"),
    prefixId: advancedId,
    cursor: advancedCursor,
    count: advancedCount,
  }),
  z.strictObject({
    id: requestId,
    type: z.literal("commands.admit"),
    commands: z.array(z.string().max(COMMAND_ADMIT_MAX_TEXT)).max(COMMAND_ADMIT_MAX_COMMANDS),
  }),
  z
    .strictObject({
      id: requestId,
      type: z.literal("commandTxn.parse"),
      text: z.string().max(KEY_ADVANCED_MAX_TEXT),
      offset: index,
    })
    .refine((request) => request.offset <= request.text.length, { message: "Offset is outside the command text." }),
  z.strictObject({ id: requestId, type: z.literal("commandTxn.serialize"), transaction: commandTransaction }),
  z.strictObject({ id: requestId, type: z.literal("keyTransfer.previewImport"), ...transferScope }),
  z.strictObject({
    id: requestId,
    type: z.literal("keyTransfer.importStart"),
    ...transferScope,
    policy: z.enum(["skipExisting", "overwrite", "ifUnchanged"]),
  }),
  z.strictObject({ id: requestId, type: z.literal("keyTransfer.exportStart"), ...transferScope }),
  z.strictObject({ id: requestId, type: z.literal("keyTransfer.resume"), taskId: advancedId }),
  z.strictObject({ id: requestId, type: z.literal("keyTransfer.list") }),
  z.strictObject({ id: requestId, type: z.literal("keyTransfer.cancel"), taskId: advancedId }),
] as const;
