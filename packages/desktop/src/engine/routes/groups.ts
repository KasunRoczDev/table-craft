import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { streamAccess } from "@table-craft/desktop/engine/routes/streamAccess.js";

/** The consumer groups of a `consumerGroups` datasource (plan 164); a reset is previewed, then applied by token. */
export function groupsRoutes(connection: ConnectionContext): RoutesFor<"groups"> {
  const { read, prepare, write } = streamAccess(connection);
  return {
    "groups.list": () => read("consumerGroups", (groups) => groups.list()),
    "groups.describe": ({ group }) => read("consumerGroups", (groups) => groups.describe(group)),
    "groups.consumersOf": ({ topic }) => read("consumerGroups", (groups) => groups.consumersOf(topic)),
    "groups.prepareReset": ({ group, scope, target }) =>
      prepare("consumerGroups", (groups) => groups.prepareReset(group, scope, target)),
    "groups.applyReset": ({ token }) =>
      write("consumerGroups", async (groups) => {
        await groups.applyReset(token);
        return null;
      }),
    "groups.deleteOffsets": ({ group, topic }) =>
      write("consumerGroups", async (groups) => {
        await groups.deleteOffsets(group, topic);
        return null;
      }),
    "groups.delete": ({ group }) =>
      write("consumerGroups", async (groups) => {
        await groups.remove(group);
        return null;
      }),
  };
}
