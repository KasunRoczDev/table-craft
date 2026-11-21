# 174: Search indices are a capability with their own tree

Status: Accepted

## Decision

A plugin that browses search indices declares the `searchIndices` capability and provides an
`IndexBrowser` session service: list the indices, aliases and data streams; describe one (its
fields, mapping, settings and time field); search it with a Lucene or Query DSL query, a sort and a
time range, answering with an `ExecuteResult` whose rows page lazily; count; draw a histogram over
time; and analyze text. `searchIndices` requires `commands` and excludes `schemaTree`, `keyValue`
and `topics`. The Database pane shows such a datasource with its own index tree, and an index opens
in an index tab whose Documents view is a result grid like any other.

## Rationale

An index is neither a table nor a key space. Mapping it onto `schemaTree` would invent schemas and
columns the cluster does not have (a mapping is per index, fields nest, a field may be text and
keyword at once), and the table editor's generated SQL would have nothing to run. Search is
also shaped differently from SQL: the total is an estimate past 10,000, pages are reached through a
scroll, and the useful default for a log index is the newest documents in a time
range. Following decision 169, a service with its own capability lets the host show the right tree
and tab while the console stays the plugin's own command language.

## Consequences

The plugin API grows one optional capability (2.4.0); no existing plugin changes. The result grid,
its value panel, export, copy and charts work on hits unchanged because a search is an
`ExecuteResult`. A second search engine, such as Solr or Meilisearch, would implement the same
service. Writes stay in the console for now: document editing and index administration dialogs are
later work on top of the same service.
