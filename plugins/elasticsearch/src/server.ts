import type { ServerInfo, ServerInfoSection, ServerNode } from "@table-craft/plugin-api";
import { isForbidden, type ElasticClient } from "./client.js";
import { productName, type Dialect } from "./dialect.js";

interface CatNode {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly ip?: unknown;
  readonly port?: unknown;
  readonly "node.role"?: unknown;
  readonly master?: unknown;
  readonly "heap.percent"?: unknown;
  readonly "ram.percent"?: unknown;
  readonly cpu?: unknown;
  readonly load_1m?: unknown;
  readonly version?: unknown;
}

const CAT_NODES =
  "/_cat/nodes?format=json&full_id=true&h=id,name,ip,port,node.role,master,heap.percent,ram.percent,cpu,load_1m,version";

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** Every node, the elected master first; a user who may not read them sees only the address it dialled. */
export async function nodeList(client: ElasticClient): Promise<ServerNode[]> {
  let rows: CatNode[];
  try {
    rows = await client.json<CatNode[]>("GET", CAT_NODES);
  } catch (error) {
    if (!isForbidden(error)) throw error;
    const address = new URL(client.baseUrl).host;
    return [{ id: address, address, role: "primary", slots: [], primaryId: null, state: "unknown" }];
  }
  const nodes = rows.map((row): ServerNode => ({
    id: text(row.id) || text(row.name),
    address: `${text(row.ip)}${text(row.port) === "" ? "" : `:${text(row.port)}`} (${text(row.name)})`,
    role: "primary",
    slots: [],
    primaryId: null,
    state: `${row.master === "*" ? "master · " : ""}${text(row["node.role"])}`,
  }));
  return nodes.sort((a, b) => Number(b.state.startsWith("master")) - Number(a.state.startsWith("master")));
}

interface Health {
  readonly cluster_name?: unknown;
  readonly status?: unknown;
  readonly number_of_nodes?: unknown;
  readonly number_of_data_nodes?: unknown;
  readonly active_primary_shards?: unknown;
  readonly active_shards?: unknown;
  readonly relocating_shards?: unknown;
  readonly initializing_shards?: unknown;
  readonly unassigned_shards?: unknown;
}

/** The cluster's health and, for one node, its figures from `_cat/nodes`. */
export async function serverInfo(client: ElasticClient, dialect: Dialect, node: string | null): Promise<ServerInfo> {
  const sections: ServerInfoSection[] = [
    {
      title: "Server",
      entries: [
        { name: "product", value: productName(dialect.distribution) },
        { name: "version", value: dialect.versionText },
      ],
    },
  ];
  const health = await client.json<Health>("GET", "/_cluster/health").catch((error: unknown) => {
    if (isForbidden(error)) return null;
    throw error;
  });
  if (health !== null) {
    sections.push({
      title: "Cluster",
      entries: Object.entries(health)
        .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        .map(([name, value]) => ({ name, value: String(value) })),
    });
  }
  if (node !== null) {
    const rows = await client.json<CatNode[]>("GET", CAT_NODES).catch(() => []);
    const row = rows.find((candidate) => text(candidate.id) === node);
    if (row !== undefined) {
      sections.push({
        title: "Node",
        entries: Object.entries(row).map(([name, value]) => ({ name, value: text(value) })),
      });
    }
  }
  return { node, sections };
}

/** `green`, `yellow` or `red`; null when the user may not read the cluster's health. */
export async function clusterHealth(client: ElasticClient): Promise<string | null> {
  const health = await client.json<Health>("GET", "/_cluster/health").catch(() => null);
  return typeof health?.status === "string" ? health.status : null;
}
