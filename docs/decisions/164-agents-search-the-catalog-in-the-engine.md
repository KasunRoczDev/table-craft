# 164: Agents search the catalog in the engine

Status: Proposed.

## Decision

The MCP tool `search_catalog` finds tables, views and columns by name across the schemas an agent
may see, through one engine request, `catalog.search`.

- **Substring, not fuzzy.** A hit's name contains the query, ignoring case. Hits rank exact, then
  prefix, then the start of a word (after `_`, `-`, `.`, a space or a lower-to-upper case change),
  then anywhere, then a comment match when the name did not match. Tables and views come before
  columns of the same rank; otherwise the order the plugin returned holds.
- **In the engine.** `catalog.search` takes the paths to search and runs the pure `searchCatalog` of
  core over the catalog cache. Only the hits cross the port.
- **Every searched schema is read.** A schema nobody opened is described through the cache, as
  `catalog.describe` does, so a search never answers from whatever happens to be loaded. A schema
  that fails to describe is listed as unread and the rest still answer; when every one fails, the
  request fails.
- **Bounded.** One call describes at most 50 schemas (`CATALOG_SEARCH_MAX_PATHS`) and returns at most
  50 hits. Past either, the answer counts what it skipped or held back and tells the agent to pass
  `schema` or a longer query.
- **Shown schemas only.** The MCP process picks the paths: the shown namespaces (decision 117)
  without system ones, or the one schema the agent names. The engine knows nothing of shown
  schemas.
- **Never asks.** Like `list_tables` and `describe_table`, the search reads names and comments, not
  rows, so it answers at every access level but off (decision 130).

## Rationale

The catalog tools walk one level at a time, so an agent looking for a column on a server with many
databases calls `list_tables` once per schema and then guesses which tables to describe. Search
Everywhere's Tables tab already searches the catalog, but fuzzily and only over schemas the window
loaded; a fuzzy subsequence buries the real hits for a word the agent already has (`ord` matches
`customer_id`), and a cache-only search silently misses schemas. Sending every schema's full catalog
to the MCP process to keep a few names would cost more than the search on a large Oracle or MySQL
schema.

## Consequences

The first search on a datasource with many shown schemas introspects all of them, which can take
seconds on a remote server; hiding schemas or naming one bounds it, and later searches reuse the
cache. Routines and sequences are not searched. Search Everywhere keeps its own cache-only fuzzy
provider, since it searches on every keystroke and must not introspect.
