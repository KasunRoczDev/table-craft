# 170: Browsing a topic never joins a consumer group

Status: Accepted

## Decision

Reading a topic, the live tail and the console's `consume` assign partitions directly and fetch
by offset. They send no JoinGroup, SyncGroup, Heartbeat or OffsetCommit, and no group id ever
reaches the cluster from a read. The plugin resolves the partition leaders from metadata, lists
the offsets it needs and fetches from each leader itself. Consumer group requests are sent only by
the actions that are about groups: describing them, previewing and applying an offset reset,
deleting offsets and deleting a group.

## Rationale

The obvious way to read a topic with a Kafka client is a consumer with a throwaway group id. On a
shared cluster that leaves `tablecraft-*` groups behind for every read, shows them to every
monitoring tool, and, with a careless id, can join a real application's group, trigger a
rebalance and commit offsets that move the application's position. An IDE that someone opens to
look at a production topic must not be able to do that by browsing.

`@platformatic/kafka` can fetch without a group: a consumer that never joins sends no group
request on fetch or on close. On brokers that resolve fetches by topic name (Kafka 2.8 and
earlier fetch versions), the plugin registers the topic with the client before fetching so the
name travels with the request.

## Consequences

Reads cannot use the group coordinator's committed position, so "start from a group's committed
offset" is a separate, explicit lookup through `OffsetFetch` that changes nothing. A read never
appears in a broker's group list, and the tests check that a run leaves no group behind.
