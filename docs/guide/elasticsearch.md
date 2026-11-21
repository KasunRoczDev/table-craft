# Elasticsearch and OpenSearch

The Elasticsearch plugin [downloads the first time you add an Elasticsearch or OpenSearch data
source](plugins.md#databases-in-the-box-and-on-demand). It speaks Elasticsearch 6.0 and later and
OpenSearch 1.0 and later over their REST API, with no driver of its own
([decision 173](../decisions/173-the-elasticsearch-plugin-speaks-rest-without-a-driver.md)). Give
the **Host** and **Port** of one node (9200 by default) and pick the **Authentication**: None, Basic
(user and password), API key, or Bearer token. Passwords, API keys and tokens are kept in your
system keychain like any other secret. **TLS** is Off (plain `http`), Verify full, Verify CA, or
Require (encrypted, without checking the certificate); the advanced fields take a CA file and a
client certificate and key. A cluster behind a proxy that serves it under a path, such as
`/es`, takes that path in the advanced **Path prefix**. TableCraft talks to the node you name and
never discovers the others.

On connect TableCraft reads the cluster's version and adapts to it: mapping types on 6.x, the shape
of hit totals, points in time on Elasticsearch 7.10 and OpenSearch 2.4 and later, scrolls before
them. When the user you sign in with may not read `GET /`, it asks the node it reached instead. On a
cluster shared by many teams, the advanced **Index filter** (globs separated by commas, such as
`logs-*, products`) lists only the indices, aliases and data streams whose names match; a console
request or a tab opened by name still reaches any of them.

- **Database tree.** **Indices** with their document count and size, such as
  `2,431 docs · 1.2 MB`, as the server counts them, so an index with `nested` fields counts each
  nested object too; a yellow or red index shows its health beside the name. Indices that roll
  over (`logs-checkout-000411`, `logs-checkout-000412`) or carry a date (`audit-2026.11.20`) fold
  into one family row, newest first. Other names fold on the part before the first `.` when two or
  more share it. **Data streams** with their backing indices, **Aliases** with the index they point
  at, and **Hidden** for system indices whose names start with `.`, folded away with their count.
- **Index tab.** Opening an index, an alias or a data stream shows its **Documents**, **Mapping**,
  **Settings** and **Analyze** views. Documents is a result grid with one row per hit: `_id`, the
  index when the target spans several, the score when the hits are not sorted, a column per
  field, and the whole `_source` as JSON. A narrow mapping shows every field; a wide one, such as a
  log index with a hundred fields, starts with the time, the level, the message and a few keyword
  fields. A field missing from a document reads `<null>`.
- **Query bar.** Type a Lucene query (`category:coffee AND price:[* TO 20]`, every term required
  unless you write `OR`) or pick **DSL** before the query and type a Query DSL object
  (`{"term": {"sku": "p-1"}}`), then press Enter or **Run**. Pick a field to sort on and its order.
  An error from the cluster shows under the bar and keeps the rows of the last search.
- **Time first.** When the target has an `@timestamp` date field, the bar offers a time range,
  _Last 15 minutes_ by default, sorts newest first and draws a histogram of the hits over the
  range above the grid, with the hits of its tallest bar and the time under every quarter; a bar
  the range cuts short reads paler. The footer says how many shards the range let the cluster skip.
- **Paging.** The grid fetches pages as you scroll, through a scroll context that is cleared when
  the result is released, the tab closes or the last page arrives.
  The footer reads `1–100 of 2,431 hits · took 6 ms · 5 shards`; past 10,000 the count reads
  `≥ 10,000`. Shard failures show as a warning with the reason.
- **The request.** **Request** shows the exact request the search sent, with **Copy** and **Open in
  Console**, so a search built in the bar becomes a console request you can change.
- **Mapping and Settings.** Mapping lists each field with its type, analyzer and multi-fields
  (`name.raw` under `name`), and the mapping as JSON. Settings shows the index settings as JSON. On
  6.x the header names the mapping type.
- **Analyze.** Pick a text field, type some text and see what each step of its analyzer makes of
  it: the tokenizer, then each token filter in turn, with the tokens a step dropped struck out. A
  query that finds nothing because a filter dropped a short word shows why here.
- **Missing permissions.** A view the signed-in user may not read, such as an index's settings,
  says so inside that view with the cluster's reason, which names the missing privilege; the rest of the tab and the tree keep
  working.

## The console

The console reads requests the way Kibana Dev Tools and OpenSearch Dashboards write them: a
`METHOD path` line, then a JSON body on the lines under it. `_bulk` and `_msearch` take one JSON
object per line. Lines starting with `#` or `//` are comments.

```text
GET products/_search
{
  "query": { "match": { "name": "flat white" } },
  "aggs": { "by_category": { "terms": { "field": "category" } } }
}

GET _cat/indices?v

SELECT category, COUNT(*) AS n FROM products GROUP BY category;
```

- **Results.** A search shows its hits as a grid, and each aggregation as a grid of its own, one row
  per bucket, which you can chart. `_cat` requests show as a grid. A line starting with `SELECT`,
  `SHOW`, `DESCRIBE` or `EXPLAIN` goes to the cluster's SQL endpoint, and on OpenSearch a line
  starting with `source=` goes to PPL; their answers show as a grid. Any other answer shows as JSON
  in Output.
- **Completion** offers the methods at the start of a line, endpoints such as `_search` and
  `_cat/indices` and the cluster's index names after the method, and Query DSL keys inside a body.
- **What a request does.** Reads run at once. `DELETE <index>` deletes the index and every document
  in it, so TableCraft asks you to type the index's name first; a `_delete_by_query` asks too, and
  one that matches every document is marked as costly. A read-only data source refuses every
  request that would change something before it is sent.
- **Cancel** stops the running request by closing its connection; Elasticsearch 7.4 and later
  and OpenSearch then stop the search on the cluster too.

## What it does not do

- Editing a document in the grid, and dialogs to create or delete indices and aliases: write the
  request in the console instead.
- Kibana Query Language (KQL), index lifecycle policies, snapshots, and security users and roles.
- Elasticsearch 5.x and older.
