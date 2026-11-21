import type { ConnectionContext } from "@table-craft/desktop/engine/connection.js";
import type { RoutesFor } from "@table-craft/desktop/engine/routes/types.js";
import { streamAccess } from "@table-craft/desktop/engine/routes/streamAccess.js";

/** The Schema Registry of a `schemaRegistry` datasource (plan 164). */
export function schemasRoutes(connection: ConnectionContext): RoutesFor<"schemas"> {
  const { read, write } = streamAccess(connection);
  return {
    "schemas.status": () =>
      read("schemaRegistry", (registry) =>
        Promise.resolve({ available: registry.available, reason: registry.available ? null : registry.reason }),
      ),
    "schemas.subjects": ({ glob }) => read("schemaRegistry", (registry) => registry.subjects(glob)),
    "schemas.versions": ({ subject }) => read("schemaRegistry", (registry) => registry.versions(subject)),
    "schemas.get": ({ subject, version }) => read("schemaRegistry", (registry) => registry.get(subject, version)),
    "schemas.check": ({ subject, schemaType, schema }) =>
      read("schemaRegistry", (registry) => registry.check(subject, schemaType, schema)),
    "schemas.register": ({ subject, schemaType, schema }) =>
      write("schemaRegistry", (registry) => registry.register(subject, schemaType, schema)),
    "schemas.compatibility": ({ subject, level }) =>
      level === null
        ? read("schemaRegistry", (registry) => registry.compatibility(subject, null))
        : write("schemaRegistry", (registry) => registry.compatibility(subject, level)),
    "schemas.delete": ({ subject, version, permanent }) =>
      write("schemaRegistry", (registry) => registry.remove(subject, version, permanent)),
  };
}
