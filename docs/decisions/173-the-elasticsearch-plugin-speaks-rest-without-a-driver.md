# 173: The Elasticsearch plugin speaks REST without a driver

Status: Accepted

## Decision

The Elasticsearch plugin talks to Elasticsearch and OpenSearch through its own small client over
Node's `http` and `https` modules, one keep-alive agent per session, with no client library. On
connect it reads `GET /` (or the reached node's version when the user may not read it) and builds a
dialect from the distribution and version: mapping types before 7.0, the hit total as a number or
an object, points in time from Elasticsearch 7.10 and OpenSearch 2.4 with scrolls before them,
`expand_wildcards` on `_cat` from 7.7, and the SQL and PPL endpoints of each. It refuses
Elasticsearch older than 6.0. It never sniffs the cluster for other nodes.

## Rationale

The official `@elastic/elasticsearch` client checks the product on its first request and refuses
to talk to OpenSearch and to Elasticsearch before 7.14, and each major of it targets one major of
the server. The OpenSearch client is its fork and refuses the other way. One plugin for both
products, and for the 6.x and 7.x clusters many teams still run, would need several clients side
by side, each with its own transport, retries and serialisation. What TableCraft sends is a handful
of documented REST calls, so a client of a few hundred lines covers every version, keeps the
plugin free of dependencies and reports the server's own error text. Sniffing is off because the
addresses a cluster publishes are often unreachable from a desktop behind a proxy or a tunnel.

## Consequences

Every request and its body are visible in one place, so the `{ }` popover of an index tab shows
exactly what a search sent. A feature a client library would bring for free (retries
across nodes, request compression) is out until the plugin adds it. The contract suite runs the
plugin against Elasticsearch 8 and OpenSearch 2 in Docker and, when `.env` names one, a shared 6.x
cluster, so a dialect change is checked on the versions it branches on.
