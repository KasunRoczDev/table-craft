import type { ServerInfo, ServerInfoSection, ServerNode } from "@table-craft/plugin-api";
import type { KafkaAdmin } from "./admin.js";
import { refused } from "./failures.js";
import type { BrokerApi, ClusterMode } from "./version.js";

const MASKED = "(sensitive)";

export interface BrokerRow {
  readonly id: number;
  readonly host: string;
  readonly port: number;
  readonly rack: string | null;
  readonly controller: boolean;
}

export interface ClusterFacts {
  readonly clusterId: string;
  readonly mode: ClusterMode;
  readonly serverVersion: string;
  readonly apis: readonly BrokerApi[];
}

export async function brokerRows(admin: KafkaAdmin): Promise<BrokerRow[]> {
  const metadata = await admin.metadata([]);
  return [...metadata.brokers.entries()]
    .map(([id, broker]) => ({
      id,
      host: broker.host,
      port: broker.port,
      rack: broker.rack ?? null,
      controller: id === metadata.controllerId,
    }))
    .sort((a, b) => a.id - b.id);
}

/** Every broker as a primary (decision 15): Kafka has no replica nodes, only replica partitions. */
export async function brokerNodes(admin: KafkaAdmin): Promise<ServerNode[]> {
  return (await brokerRows(admin)).map((broker) => ({
    id: String(broker.id),
    address: `${broker.host}:${String(broker.port)}`,
    role: "primary",
    slots: [],
    primaryId: null,
    state: ["online", broker.controller ? "controller" : null, broker.rack === null ? null : `rack ${broker.rack}`]
      .filter((part) => part !== null)
      .join(", "),
  }));
}

/** What a broker says about itself and the cluster: ids, mode, its configs and the APIs it answers. */
export async function brokerInfo(admin: KafkaAdmin, facts: ClusterFacts, node: string | null): Promise<ServerInfo> {
  const brokers = await brokerRows(admin);
  const broker =
    node === null
      ? (brokers.find((row) => row.controller) ?? brokers[0])
      : brokers.find((row) => String(row.id) === node);
  if (broker === undefined) throw refused(`There is no broker ${node ?? ""} in this cluster; refresh the broker list.`);
  const controller = brokers.find((row) => row.controller);
  const configs = await admin.configs("broker", String(broker.id)).catch(() => []);
  const sections: ServerInfoSection[] = [
    {
      title: "Cluster",
      entries: [
        { name: "cluster_id", value: facts.clusterId },
        { name: "controller", value: controller === undefined ? "unknown" : String(controller.id) },
        { name: "mode", value: facts.mode },
        { name: "brokers", value: String(brokers.length) },
        { name: "version", value: facts.serverVersion },
      ],
    },
    {
      title: "Broker",
      entries: [
        { name: "id", value: String(broker.id) },
        { name: "address", value: `${broker.host}:${String(broker.port)}` },
        { name: "rack", value: broker.rack ?? "" },
      ],
    },
    {
      title: "API versions",
      entries: [...facts.apis]
        .sort((a, b) => a.apiKey - b.apiKey)
        .map((api) => ({ name: api.name, value: `v${String(api.minVersion)}–v${String(api.maxVersion)}` })),
    },
  ];
  if (configs.length > 0) {
    sections.push({
      title: "Configs",
      entries: configs.map((config) => ({
        name: config.name,
        value: config.sensitive ? MASKED : (config.value ?? ""),
      })),
    });
  }
  return { node: String(broker.id), sections };
}
