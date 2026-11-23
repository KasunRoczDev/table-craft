# 117: Shown schemas are a per-datasource allow-list

Status: Accepted

## Decision

**Manage Shown Schemas…** saves, on the datasource in `datasources.json`, an optional
`shownNamespaces`: the names of the top-level namespaces (the databases or schemas
`catalog.namespaces` lists with no parent) the Database pane shows. Absent means every one, which
is how every record saved before this reads, so the file needs no migration and its version stays

1. Only the top level is filtered; a PostgreSQL database's schemas show as before. The dialog's
   **All schemas** is the absent list; it never saves every name.

## Rationale

A shared server with dozens of databases buries the one a user works in. DataGrip answers with
Manage Shown Schemas, and its users expect the same model: a list of what to show.

An allow-list was chosen over a deny-list of hidden names. With a deny-list, a database someone
else creates on the shared server appears in everyone's tree the next time it is listed, which is
the clutter the feature removes; with an allow-list it stays hidden until picked, as in DataGrip.
The cost is the reverse case: a user who hid one database also misses new ones, and **All
schemas** is there for that. Names, not paths, are kept because a top-level namespace's path is its
name, and a name survives the server being recreated.

The filter is a view of the tree, not of the catalog: the engine still lists and caches every
namespace, so completion, Search Everywhere and a console's namespace switcher still reach hidden
ones.

## Consequences

- A saved name the server no longer has is kept, so a database dropped and created again comes
  back shown; the "N of M" counts only names the server lists.
- An ephemeral datasource (`TABLE_CRAFT_DATASOURCE`) cannot be filtered, as it is never saved.
- The Properties dialog does not edit the list but carries it through a save, and Duplicate copies
  it.
- A stream datasource (Kafka, decision 169) has topics, not namespaces, so **Manage Shown Topics…**
  keeps the same allow-list in its own optional `shownTopics` (plan 166). Reusing
  `shownNamespaces` would have the MCP server read topic names as schemas. The filter is the
  tree's alone, after the plugin's **Name filter** and **Show Internal Topics**: an internal topic
  stays hidden while that is off, even when picked.
- A search datasource (Elasticsearch and OpenSearch, decision 174) keeps **Manage Shown Indices…**
  in its own `shownIndices` (plan 169). Exact names would hide tomorrow's `logs-2026.11.24`, so an
  entry is a name or a family, `orders-*`, which keeps every index sharing the base once its
  rollover or date suffix is gone, and the alias whose write index is one of them. Only that `-*`
  shape is read; a general glob would be a second filter beside the plugin's **Index filter**.
  The filter applies after that one and before the tree's own filter field.
