import { ConfigResourceTypes, IncrementalAlterConfigOperationTypes } from "@platformatic/kafka";
import type {
  AdminOptions,
  ConfigChange,
  DeleteRecordsPartition,
  DeleteRecordsPreview,
  RecordsBefore,
  TopicCreate,
} from "@table-craft/plugin-api";
import type { ConfigResource, KafkaAdmin } from "./admin.js";
import { failures, refused } from "./failures.js";
import type { PreparedStore } from "./prepared.js";
import { timestampMillis } from "./readPlan.js";
import { guardInternal, guardWrite } from "./readOnly.js";

/** Kafka's topic name rule, from `org.apache.kafka.common.internals.Topic`. */
const TOPIC_NAME = /^[a-zA-Z0-9._-]+$/;
const MAX_TOPIC_NAME = 249;
const DEFAULT_REPLICATION = -1;
const DELETE_RECORDS = "deleteRecords";

interface PreparedDelete {
  readonly topic: string;
  readonly partitions: readonly { readonly partition: number; readonly offset: bigint }[];
}

/** Why `name` cannot be a topic, or null when it can. */
export function topicNameProblem(name: string): string | null {
  if (name === "" || name === "." || name === "..") return `"${name}" cannot name a topic.`;
  if (name.length > MAX_TOPIC_NAME) return `A topic name is at most ${String(MAX_TOPIC_NAME)} characters.`;
  if (!TOPIC_NAME.test(name)) return `Topic "${name}" may hold only letters, digits, ".", "_" and "-".`;
  return null;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/**
 * Topic writes (Phase 4 of plan 164): each refused on a read-only session before anything is
 * sent, and none retried (decision 139). CreateTopics, CreatePartitions and DeleteTopics go to the
 * controller by hand, so `validateOnly` reaches the broker and a timeout is not resent.
 */
export class TopicAdmin {
  readonly #admin: KafkaAdmin;
  readonly #prepared: PreparedStore;
  readonly #readOnly: boolean;
  readonly #timeoutMs: number;

  constructor(admin: KafkaAdmin, prepared: PreparedStore, readOnly: boolean, timeoutMs: number) {
    this.#admin = admin;
    this.#prepared = prepared;
    this.#readOnly = readOnly;
    this.#timeoutMs = timeoutMs;
  }

  async create(request: TopicCreate, options: AdminOptions): Promise<void> {
    guardWrite(this.#readOnly, `creating topic ${request.name}`);
    const problem = topicNameProblem(request.name);
    if (problem !== null) throw refused(problem);
    if (!Number.isInteger(request.partitions) || request.partitions < 1) {
      throw refused("A topic needs at least 1 partition.");
    }
    const topics = [
      {
        name: request.name,
        numPartitions: request.partitions,
        replicationFactor: request.replicationFactor ?? DEFAULT_REPLICATION,
        assignments: [],
        configs: request.configs.map((config) => ({ name: config.name, value: config.value })),
      },
    ];
    await failures(
      () => this.#admin.controllerCall("CreateTopics", topics, this.#timeoutMs, options.validateOnly),
      `Kafka refused to create ${request.name}: `,
    );
  }

  alterConfigs(topic: string, changes: readonly ConfigChange[], options: AdminOptions): Promise<void> {
    return this.alter("topic", topic, changes, options);
  }

  /** An incremental alter of a topic's or a broker's configs; a null value resets the entry to its default. */
  async alter(
    resource: ConfigResource,
    name: string,
    changes: readonly ConfigChange[],
    options: AdminOptions,
  ): Promise<void> {
    guardWrite(this.#readOnly, `changing the configs of ${resource} ${name}`);
    if (changes.length === 0) return;
    const resourceType = resource === "topic" ? ConfigResourceTypes.TOPIC : ConfigResourceTypes.BROKER;
    const configs = changes.map((change) =>
      change.value === null
        ? { name: change.name, configOperation: IncrementalAlterConfigOperationTypes.DELETE }
        : { name: change.name, configOperation: IncrementalAlterConfigOperationTypes.SET, value: change.value },
    );
    await failures(
      () =>
        this.#admin.writer.incrementalAlterConfigs({
          resources: [{ resourceType, resourceName: name, configs }],
          validateOnly: options.validateOnly,
        }),
      `Kafka refused the config change on ${name}: `,
    );
  }

  async addPartitions(topic: string, total: number, options: AdminOptions): Promise<void> {
    guardWrite(this.#readOnly, `adding partitions to ${topic}`);
    guardInternal(topic, "adding partitions");
    const current = (await this.#admin.topic(topic)).partitionsCount;
    if (!Number.isInteger(total) || total <= current) {
      throw refused(
        `${topic} has ${String(current)} partitions; the new total must be more, since Kafka never removes partitions.`,
      );
    }
    await failures(
      () =>
        this.#admin.controllerCall(
          "CreatePartitions",
          [{ name: topic, count: total, assignments: null }],
          this.#timeoutMs,
          options.validateOnly,
        ),
      `Kafka refused to add partitions to ${topic}: `,
    );
  }

  async prepareDeleteRecords(
    topic: string,
    partitions: readonly number[] | null,
    before: RecordsBefore,
  ): Promise<DeleteRecordsPreview> {
    guardWrite(this.#readOnly, `deleting records of ${topic}`);
    guardInternal(topic, "deleting its records");
    const count = (await this.#admin.topic(topic)).partitionsCount;
    const chosen = partitions ?? range(count);
    const outside = chosen.filter((partition) => partition < 0 || partition >= count);
    if (outside.length > 0) throw refused(`${topic} has no partition ${outside.join(", ")}.`);
    const marks = await this.#admin.topicWatermarks(topic, chosen);
    const at =
      before.kind === "timestamp"
        ? ((await this.#admin.offsetsAt(new Map([[topic, chosen]]), timestampMillis(before.timestamp))).get(topic) ??
          new Map<number, bigint>())
        : new Map<number, bigint>();
    if (before.kind === "offset" && !/^\d+$/.test(before.offset)) {
      throw refused(`The offset ${before.offset} is not a whole number.`);
    }
    const rows: DeleteRecordsPartition[] = [];
    const plan: { partition: number; offset: bigint }[] = [];
    let removed = 0n;
    for (const partition of chosen) {
      const mark = marks.get(partition);
      if (mark === undefined) continue;
      let target: bigint;
      if (before.kind === "latest") target = mark.high;
      else if (before.kind === "offset") target = BigInt(before.offset);
      else {
        const found = at.get(partition) ?? -1n;
        target = found < 0n ? mark.high : found;
      }
      const newLow = target < mark.low ? mark.low : target > mark.high ? mark.high : target;
      removed += newLow - mark.low;
      rows.push({
        partition,
        low: mark.low.toString(),
        newLow: newLow.toString(),
        high: mark.high.toString(),
        removed: (newLow - mark.low).toString(),
      });
      if (newLow > mark.low) plan.push({ partition, offset: newLow });
    }
    const token = this.#prepared.put(DELETE_RECORDS, { topic, partitions: plan } satisfies PreparedDelete);
    return { token, topic, partitions: rows, removed: removed.toString() };
  }

  async deleteRecordsPrepared(token: string): Promise<void> {
    guardWrite(this.#readOnly, "deleting records");
    const prepared = this.#prepared.take<PreparedDelete>(DELETE_RECORDS, token);
    if (prepared.partitions.length === 0) return;
    await failures(
      () =>
        this.#admin.writer.deleteRecords({
          topics: [{ name: prepared.topic, partitions: prepared.partitions.map((entry) => ({ ...entry })) }],
        }),
      `Kafka refused to delete records of ${prepared.topic}: `,
    );
  }

  async remove(topic: string): Promise<void> {
    guardWrite(this.#readOnly, `deleting topic ${topic}`);
    guardInternal(topic, "deleting it");
    await this.#admin.topic(topic);
    await failures(
      () => this.#admin.controllerCall("DeleteTopics", [{ name: topic }], this.#timeoutMs),
      `Kafka refused to delete ${topic}: `,
    );
  }
}
