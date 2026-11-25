# 169: Stream services are capabilities with their own tree

Status: Accepted

## Decision

A message log such as Apache Kafka enters the plugin API (2.3.0) as three optional session
services, each a key of `session.services` gated by a capability of the same name (decision 155):

| Capability       | Service                             | What the host does with it                                              |
| ---------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `topics`         | `topics` (`TopicBrowser`)           | the stream tree's Topics, the topic tab, produce, topic admin, the tail |
| `consumerGroups` | `consumerGroups` (`GroupManager`)   | Consumer groups in the tree, the group tab, previewed offset resets     |
| `schemaRegistry` | `schemaRegistry` (`SchemaRegistry`) | Subjects in the tree, registry formats in reads and produce             |

All three require `commands`, so every action also exists as a console command an agent can run
through `run_query`. `topics` excludes `schemaTree` and `keyValue`: a datasource draws one tree
kind. A plugin that declares `schemaRegistry` returns the service on every session; without a
registry URL it answers `available: false` with the reason, so "present exactly when declared"
still holds.

The Database pane draws a datasource that declares `topics` as a stream tree: Topics folded on
`.`, Consumer groups, Brokers (from `nodes`, decision 114) and Subjects. A topic opens in a topic
tab whose Messages view is an `ExecuteResult` in the result store (decision 009), so the grid,
find, copy, export and the value panel need nothing new.

Offsets, counts and lag are decimal strings; `null` means unknown, never zero. An offset reset is
previewed and applied by token, the prepare and apply pattern of decision 137, and Kafka's rule
that only an `Empty` group may move stays visible as a refusal in the preview.

## Rationale

Decision 007 forbids the UI from branching on plugin ids, and the names say what the services do,
not which broker answers them: Redpanda or any Kafka-API broker uses the same UI, and a Pulsar
plugin could declare `topics` alone. A topic is neither a table (no schema, no primary key, rows
are never edited) nor a key (it is an append-only sequence per partition), so reusing the catalog
or the key tree would hide what makes it a log: partitions, offsets and the consumers behind them.

## Consequences

The renderer has a third tree kind beside the catalog and the key tree, chosen by capability. The
plugin API takes 2.3.0; every block of the contract suite for these services is gated on what a
plugin declares, so existing plugins and the frozen SQLite plugin keep passing.
