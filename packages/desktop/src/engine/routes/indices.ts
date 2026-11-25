import type { SessionServices } from "@table-craft/plugin-api";
import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import { helperRequestFailed } from "@table-craft/desktop/engine/failures.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { serviceOf } from "@table-craft/desktop/engine/services.js";

/** The indices of a `searchIndices` datasource (plan 165): reads on the helper session, searches on a tab's. */
export function indicesRoutes(connection: ConnectionContext): RoutesFor<"indices"> {
  const read = <T>(work: (indices: SessionServices["searchIndices"]) => Promise<T>): Promise<T> => {
    connection.keyOperations.scope.capability("searchIndices");
    return connection
      .onHelper((session) => work(serviceOf(session, "searchIndices")))
      .catch((cause: unknown) => {
        throw helperRequestFailed(cause);
      });
  };
  return {
    "indices.list": () => read((indices) => indices.list()),
    "indices.describe": ({ target }) => read((indices) => indices.describe(target)),
    "indices.open": (request) => connection.openSearch(request),
    "indices.count": ({ request }) => read((indices) => indices.count(request)),
    "indices.histogram": ({ request, buckets }) => read((indices) => indices.histogram(request, buckets)),
    "indices.analyze": ({ request }) => read((indices) => indices.analyze(request)),
  };
}
