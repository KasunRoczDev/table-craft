# 175: Search pages past the first come from a point in time

Status: Accepted

## Decision

The Elasticsearch plugin reads page one of an index search as a plain `_search`, counting hits up
to 10,000 (`track_total_hits`), with one hit past the page so the host's look-ahead row needs
nothing more. Only a reader past it opens a cursor. On Elasticsearch 7.10+ and OpenSearch 2.4+ it
is a point in time, read by `search_after` from page one's last sort values plus tiebreakers that
order every hit once: `_shard_doc` on Elasticsearch 7.12+, `_index` and `_id` on OpenSearch and
Elasticsearch 7.10 and 7.11. The first point in time page starts at page one's last sort values,
ties included, and drops the hits page one showed. Older servers, and a server that refuses the
point in time, re-run the search by scroll, without `track_total_hits`, and drop what sorts before
page one's last hit. A scored search sorts by `_score` outright, so its hits carry the value to
go on from. The cursor is released when the rows run out, the result or tab closes, or the
session ends: through the transport's `releaseCursors` when it has one, else by the server's own
`DELETE`. A release the server refuses is said once, as a warning on the next search; the
keep-alive ends the cursor.

## Rationale

A scroll opened with page one stays on the server for minutes even when the user only reads the
first rows, which is most searches, and a large cluster limits open scroll contexts. A point in
time costs less and pages with `search_after`, but needs a sort that tells every hit apart:
`_doc` repeats across shards, so paging by it skips hits (measured on OpenSearch 2.19: 56 of 60
documents across 3 shards), and OpenSearch has no `_shard_doc`. Its only per-document sortable
field is `_id`. Page one cannot sort by the point in time's tiebreaker, so page two goes on from
the sort values and drops the ties page one already showed.

## Consequences

Page one leaves nothing open. On OpenSearch, paging past page one sorts by `_id`, which loads its
field data; a cluster that disallows it answers 400 and the pages go on by scroll. The scroll
path re-reads what page one showed once. The count in the footer reads `≥ 10,000` past the limit,
and Count still counts every hit.
