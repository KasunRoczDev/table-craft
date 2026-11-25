import type { Namespace } from "@table-craft/desktop/engine/protocol.js";
import type { ActionContext } from "@table-craft/desktop/renderer/actions/context.js";
import {
  copyMysqlDatabase,
  verifyMysqlData,
  verifyMysqlSchema,
  type MysqlCopyMode,
} from "@table-craft/desktop/renderer/actions/mysqlCopy.js";
import { datasourceById, useDatasources } from "@table-craft/desktop/renderer/state/datasources.js";
import { useCatalog } from "@table-craft/desktop/renderer/state/catalog.js";
import { useModal } from "@table-craft/desktop/renderer/state/modal.js";
import { toError } from "@table-craft/desktop/renderer/state/resultWindows.js";

function selectedSchema(
  context: ActionContext,
): { readonly datasourceId: string; readonly path: readonly string[] } | null {
  const selection = context.selection;
  if (selection?.kind !== "catalog" || selection.name !== null) return null;
  const namespaces = useCatalog.getState().catalogs[selection.id]?.namespaces ?? [];
  const namespace = namespaces.find(
    (item) =>
      item.path.length === selection.path.length && item.path.every((part, index) => part === selection.path[index]),
  );
  return namespace?.kind === "schema" ? { datasourceId: selection.id, path: selection.path } : null;
}
export async function verifyMysqlDatabaseAction(context: ActionContext): Promise<void> {
  const target = selectedSchema(context);
  if (target === null || target.path.length !== 1) return;
  const state = useDatasources.getState();
  const source = datasourceById(state, target.datasourceId);
  if (source?.pluginId !== "mysql") return;
  const destinations = state.datasources.filter((datasource) => datasource.pluginId === "mysql");
  const destinationId = await useModal.getState().ask({
    kind: "pick",
    title: "Verify against",
    searchLabel: "MySQL data sources",
    items: destinations.map((datasource) => ({
      id: datasource.id,
      label: datasource.name,
      detail: datasource.pluginId,
    })),
    empty: "No MySQL data sources are available.",
    confirm: "Choose",
  });
  if (destinationId === null) return;
  const destination = datasourceById(useDatasources.getState(), destinationId);
  if (destination?.pluginId !== "mysql") return;
  let destinationClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
  let availableDatabases: readonly Namespace[];
  try {
    destinationClient = await useDatasources.getState().connect(destination.id);
    availableDatabases = (
      await destinationClient.call<"catalog.namespaces">("catalog.namespaces", { refresh: true })
    ).filter(
      (namespace) =>
        namespace.kind === "schema" &&
        namespace.path.length === 1 &&
        !namespace.system &&
        !(destination.id === source.id && namespace.path[0] === target.path[0]),
    );
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Could not read verification databases",
      message: toError(cause).message,
      hint: toError(cause).hint,
    });
    return;
  }
  if (availableDatabases.length === 0) {
    await useModal.getState().ask({
      kind: "notice",
      title: "No comparison database",
      message: "Choose a MySQL connection with another existing non-system database.",
      hint: "",
    });
    return;
  }
  const destinationDatabase = await useModal.getState().ask({
    kind: "pick",
    title: "Choose database to compare",
    searchLabel: "Existing MySQL databases",
    items: availableDatabases.map((database) => ({
      id: database.path[0] ?? database.name,
      label: database.name,
      detail: database.current ? "Current database" : "MySQL database",
    })),
    empty: "No existing comparison databases are available.",
    confirm: "Choose",
  });
  if (destinationDatabase === null) return;
  const choice = await useModal.getState().ask({
    kind: "choice",
    title: "Verification scope",
    message: `Compare database ${target.path[0]} on ${source.name} with ${destinationDatabase} on ${destination.name}.`,
    choices: [
      { id: "schema", label: "Verify schema", variant: "primary" },
      { id: "data", label: "Verify data" },
      { id: "both", label: "Verify schema and data" },
    ],
  });
  if (choice === null) return;
  try {
    const sourceClient =
      destination.id === source.id ? destinationClient : await useDatasources.getState().connect(source.id);
    const schema =
      choice === "schema" || choice === "both"
        ? await verifyMysqlSchema(sourceClient, destinationClient, target.path, [destinationDatabase])
        : [];
    const data =
      choice === "data" || choice === "both"
        ? await verifyMysqlData(sourceClient, destinationClient, target.path, [destinationDatabase])
        : [];
    const findings = [...schema, ...data];
    const failures = findings.filter(({ status }) => status !== "match");
    const summary =
      findings.length === 0
        ? "No supported tables were found to compare."
        : failures.length === 0
          ? `${findings.length} checks matched.`
          : `${failures.length} of ${findings.length} checks need attention.`;
    await useModal.getState().ask({
      kind: "notice",
      title: failures.length === 0 ? "Verification passed" : "Verification found differences",
      message: [summary, ...failures.map(({ object, status, detail }) => `${object}: ${status} — ${detail}`)].join(
        "\n",
      ),
      hint: "",
      tone: failures.length === 0 ? "info" : undefined,
    });
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Verification stopped",
      message: toError(cause).message,
      hint: toError(cause).hint,
    });
  }
}

export async function copyMysqlDatabaseAction(context: ActionContext): Promise<void> {
  const target = selectedSchema(context);
  if (target === null || target.path.length !== 1) return;
  const state = useDatasources.getState();
  const source = datasourceById(state, target.datasourceId);
  if (source?.pluginId !== "mysql") return;
  const destinations = state.datasources.filter(
    (datasource) => datasource.pluginId === "mysql" && !datasource.readOnly,
  );
  if (destinations.length === 0) {
    await useModal.getState().ask({
      kind: "notice",
      title: "No MySQL destination",
      message: "Add a writable MySQL data source before copying this database.",
      hint: "",
    });
    return;
  }
  const destinationId = await useModal.getState().ask({
    kind: "pick",
    title: "Copy database to",
    searchLabel: "MySQL data sources",
    items: destinations.map((datasource) => ({
      id: datasource.id,
      label: datasource.name,
      detail: datasource.id === source.id ? "Same connection" : datasource.pluginId,
    })),
    empty: "No writable MySQL data sources are available.",
    confirm: "Choose",
  });
  if (destinationId === null) return;
  const destination = datasourceById(useDatasources.getState(), destinationId);
  if (destination?.pluginId !== "mysql" || destination.readOnly) return;
  let destinationClient: Awaited<ReturnType<ReturnType<typeof useDatasources.getState>["connect"]>>;
  let availableDatabases: readonly Namespace[];
  try {
    destinationClient = await useDatasources.getState().connect(destination.id);
    availableDatabases = (
      await destinationClient.call<"catalog.namespaces">("catalog.namespaces", { refresh: true })
    ).filter(
      (namespace) =>
        namespace.kind === "schema" &&
        namespace.path.length === 1 &&
        !namespace.system &&
        !(destination.id === source.id && namespace.path[0] === target.path[0]),
    );
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Could not read destination databases",
      message: toError(cause).message,
      hint: toError(cause).hint,
    });
    return;
  }
  if (availableDatabases.length === 0) {
    await useModal.getState().ask({
      kind: "notice",
      title: "No destination database",
      message: "Choose a MySQL connection with another existing non-system database.",
      hint: "",
    });
    return;
  }
  const destinationDatabase = await useModal.getState().ask({
    kind: "pick",
    title: "Choose destination database",
    searchLabel: "Existing MySQL databases",
    items: availableDatabases.map((database) => ({
      id: database.path[0] ?? database.name,
      label: database.name,
      detail: database.current ? "Current database" : "MySQL database",
    })),
    empty: "No existing destination databases are available.",
    confirm: "Choose",
  });
  if (destinationDatabase === null) return;
  const modeAnswer = await useModal.getState().ask({
    kind: "choice",
    title: "Copy options",
    message: `Copy database ${target.path[0]} on ${source.name} to database ${destinationDatabase} on ${destination.name}.`,
    choices: [
      { id: "schema-data", label: "Schema and data", variant: "primary" },
      { id: "schema-only", label: "Schema only" },
      { id: "data-only", label: "Data only" },
    ],
  });
  if (modeAnswer === null) return;
  const mode = modeAnswer as MysqlCopyMode;
  const confirmed = await useModal.getState().ask({
    kind: "confirm",
    title: "Copy MySQL database?",
    message: `${mode === "data-only" ? "This copies table rows" : mode === "schema-only" ? "This creates table and view definitions" : "This creates table and view definitions and copies table rows"} in the existing database ${destinationDatabase} on ${destination.name}. Existing object names stop the copy; data-only requires matching empty tables. Routines, triggers, events, generated columns, non-InnoDB tables, circular foreign keys, and cross-database foreign keys are unsupported. MySQL DDL commits implicitly, so a failed schema copy may leave created objects. Database content stays on this computer.`,
    items: [
      { label: "Source", detail: `${source.name} / ${target.path[0]}`, tone: "info" },
      { label: "Destination", detail: `${destination.name} / ${destinationDatabase}`, tone: "info" },
    ],
    confirm: "Start copy",
  });
  if (confirmed === null) return;
  try {
    const sourceClient =
      destination.id === source.id ? destinationClient : await useDatasources.getState().connect(source.id);
    await copyMysqlDatabase({
      source: sourceClient,
      destination: destinationClient,
      sourcePath: target.path,
      destinationPath: [destinationDatabase],
      mode,
    });
    await useCatalog.getState().synchronize(destination.id, [destinationDatabase]);
    await useModal.getState().ask({
      kind: "notice",
      title: "Database copy completed",
      message: `Database ${target.path[0]} was copied to ${destination.name} / ${destinationDatabase}.`,
      hint: "",
      tone: "info",
    });
  } catch (cause) {
    await useModal.getState().ask({
      kind: "notice",
      title: "Database copy stopped",
      message: toError(cause).message,
      hint: toError(cause).hint,
    });
  }
}
