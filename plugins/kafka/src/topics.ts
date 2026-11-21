import {
  MESSAGE_FORMATS,
  type AdminOptions,
  type ConfigChange,
  type DeleteRecordsPreview,
  type MessageFormat,
  type PartitionInfo,
  type ProduceRecord,
  type ProduceResult,
  type RecordsBefore,
  type TopicBrowser,
  type TopicCreate,
  type TopicDescription,
  type TopicRead,
  type TopicReadRequest,
  type TopicSummary,
  type TopicTail,
  type TopicTailRequest,
} from "@table-craft/plugin-api";
import type { ClusterTopicMetadata } from "@platformatic/kafka";
import { isInternalTopic, type KafkaAdmin, type Watermarks } from "./admin.js";
import { globMatcher } from "./glob.js";
import { noteTopicSize } from "./sizes.js";

/** What the topic service hands to the parts that write, read and tail. */
export interface TopicParts {
  read(request: TopicReadRequest): Promise<TopicRead>;
  produce(record: ProduceRecord): Promise<ProduceResult>;
  create(request: TopicCreate, options: AdminOptions): Promise<void>;
  alterConfigs(topic: string, changes: readonly ConfigChange[], options: AdminOptions): Promise<void>;
  addPartitions(topic: string, total: number, options: AdminOptions): Promise<void>;
  prepareDeleteRecords(
    topic: string,
    partitions: readonly number[] | null,
    before: RecordsBefore,
  ): Promise<DeleteRecordsPreview>;
  deleteRecordsPrepared(token: string): Promise<void>;
  remove(topic: string): Promise<void>;
  tail(request: TopicTailRequest): Promise<TopicTail>;
}

/** High minus low over every partition, as a decimal string; null when a partition is unknown. */
export function messageEstimate(partitions: readonly number[], marks: ReadonlyMap<number, Watermarks>): string | null {
  let total = 0n;
  for (const partition of partitions) {
    const mark = marks.get(partition);
    if (mark === undefined) return null;
    total += mark.high - mark.low;
  }
  return total.toString();
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

/** The `topics` service (plan 164): listing and describing here, the rest in its parts. */
export class KafkaTopics implements TopicBrowser {
  readonly formats: readonly MessageFormat[];
  readonly #admin: KafkaAdmin;
  readonly #parts: TopicParts;
  readonly #listed: (name: string) => boolean;

  constructor(admin: KafkaAdmin, parts: TopicParts, registry: boolean, listed: (name: string) => boolean) {
    this.#admin = admin;
    this.#parts = parts;
    this.#listed = listed;
    this.formats = registry
      ? MESSAGE_FORMATS
      : MESSAGE_FORMATS.filter((format) => format !== "avro" && format !== "protobuf" && format !== "jsonSchema");
  }

  async list(filter: { readonly glob: string | null; readonly internal: boolean }): Promise<readonly TopicSummary[]> {
    const matches = globMatcher(filter.glob);
    const names = (await this.#admin.topicNames(filter.internal))
      .filter((name) => (filter.internal || !isInternalTopic(name)) && matches(name) && this.#listed(name))
      .sort();
    if (names.length === 0) return [];
    const regular = names.filter((name) => !isInternalTopic(name));
    const metadata =
      regular.length === 0 ? new Map<string, ClusterTopicMetadata>() : (await this.#admin.metadata(regular)).topics;
    // The driver's metadata cache drops internal topics; the admin reads those by hand.
    for (const name of names.filter(isInternalTopic)) metadata.set(name, await this.#admin.topic(name));
    const requests = new Map<string, number[]>();
    for (const name of names) requests.set(name, range(metadata.get(name)?.partitionsCount ?? 0));
    const marks = await this.#admin.watermarks(requests).catch(() => new Map<string, Map<number, Watermarks>>());
    return names.map((name) => {
      const topic = metadata.get(name);
      const partitions = requests.get(name) ?? [];
      const messages = messageEstimate(partitions, marks.get(name) ?? new Map());
      noteTopicSize(name, messages);
      return {
        name,
        internal: isInternalTopic(name),
        partitions: partitions.length,
        replicationFactor: topic?.partitions[0]?.replicas.length ?? null,
        messages,
      };
    });
  }

  async describe(name: string): Promise<TopicDescription> {
    const topic = await this.#admin.topic(name);
    const partitions = range(topic.partitionsCount);
    const [marks, configs, sizes] = await Promise.all([
      this.#admin.topicWatermarks(name, partitions),
      this.#admin.configs("topic", name),
      this.#admin.partitionSizes(name, partitions),
    ]);
    const infos = topic.partitions.map((partition, index): PartitionInfo => {
      const mark = marks.get(index);
      return {
        partition: index,
        leader: partition.leader >= 0 ? partition.leader : null,
        replicas: partition.replicas,
        isr: partition.isr,
        offline: partition.offlineReplicas,
        low: mark?.low.toString() ?? null,
        high: mark?.high.toString() ?? null,
        bytes: sizes.get(index)?.toString() ?? null,
      };
    });
    const messages = messageEstimate(partitions, marks);
    noteTopicSize(name, messages);
    return { name, id: topic.id, internal: isInternalTopic(name), partitions: infos, configs, messages };
  }

  read(request: TopicReadRequest): Promise<TopicRead> {
    return this.#parts.read(request);
  }

  produce(record: ProduceRecord): Promise<ProduceResult> {
    return this.#parts.produce(record);
  }

  create(request: TopicCreate, options: AdminOptions): Promise<void> {
    return this.#parts.create(request, options);
  }

  alterConfigs(topic: string, changes: readonly ConfigChange[], options: AdminOptions): Promise<void> {
    return this.#parts.alterConfigs(topic, changes, options);
  }

  addPartitions(topic: string, total: number, options: AdminOptions): Promise<void> {
    return this.#parts.addPartitions(topic, total, options);
  }

  prepareDeleteRecords(
    topic: string,
    partitions: readonly number[] | null,
    before: RecordsBefore,
  ): Promise<DeleteRecordsPreview> {
    return this.#parts.prepareDeleteRecords(topic, partitions, before);
  }

  deleteRecordsPrepared(token: string): Promise<void> {
    return this.#parts.deleteRecordsPrepared(token);
  }

  remove(topic: string): Promise<void> {
    return this.#parts.remove(topic);
  }

  tail(request: TopicTailRequest): Promise<TopicTail> {
    return this.#parts.tail(request);
  }
}
