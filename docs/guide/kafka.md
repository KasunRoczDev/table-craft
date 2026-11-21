# Apache Kafka

The Kafka plugin [downloads the first time you add a Kafka data
source](plugins.md#databases-in-the-box-and-on-demand). List the **Bootstrap servers**
(`host:port`, comma separated) and pick the **Security** protocol: `PLAINTEXT`, `SSL` (TLS, with a
client certificate for mutual TLS), `SASL_PLAINTEXT` or `SASL_SSL`, with SASL `PLAIN`,
`SCRAM-SHA-256` or `SCRAM-SHA-512`. Kafka hands clients the addresses its brokers advertise, so the
machine running TableCraft must reach those addresses; an SSH tunnel to the bootstrap server alone
would not, and the form offers none. A **Schema Registry URL**, with basic authentication if it asks
for one, lets TableCraft decode and encode Avro, Protobuf and JSON Schema messages.

TableCraft checks on connect that the brokers answer the requests it needs, and names the missing
one when they do not. On a cluster shared by many teams, the advanced **Name filter** (globs
separated by commas, such as `orders.*, payments.*`) lists only the topics, consumer groups and
subjects whose names match; a console command or a tab opened by name still reaches any of them.

- **Database tree.** **Topics** with their full names, folded on the part before the first `.`
  when two or more topics share it (and not every topic does), each with its partition count and
  an estimated message count, such as `12 partitions · ~3.4 M messages`. **Show Internal Topics**
  lists Kafka's own. **Consumer groups** with their state and total lag; a lag above the data
  source's **Lag warning** shows a warning sign and the word _lagging_. **Brokers**, the controller
  marked. **Subjects** of the Schema Registry, with their latest version and type.
- **Reading a topic never joins a group.** A topic tab reads partitions directly, so it commits no
  offset, starts no rebalance and leaves no group behind
  ([decision 170](../decisions/170-browsing-a-topic-never-joins-a-group.md)).
- **Topic tab.** **Messages** reads the latest N (500 by default), from the earliest offset, from an
  offset, from a time, or from a group's committed offsets, for all partitions or the ones you type
  (`0, 3, 7`), up to 50,000 rows and 128 MB of messages, whichever comes first. **Read** turns into **Cancel** while it runs; a cancelled read
  keeps the rows of the previous one. **Filter** keeps the messages whose key, value or headers
  contain the text, or match a `/regex/`. The footer says how many messages were scanned and
  matched; under Latest N a filter searches only the newest N of each partition, the footer says
  so, and **Search Earlier** reads the topic from its earliest offset with the same filter. **Scan
  Further** carries on where a read stopped. A strip above the grid counts the rows read from each
  partition: click a partition to show only its rows, click it again to show all, or right-click it
  for **Read Only Partition**. Times you type are read in your local time zone, named beside the
  field with the UTC instant they resolve to; the grid's timestamps are UTC.
- **Formats.** Pick the key and value format per topic: Auto, String, JSON, Avro, Protobuf, JSON
  Schema, Hex, Base64 or a number. Auto reads the Schema Registry's framing and shows the schema each
  message used; a value that does not decode shows as Hex with a warning, and the row stays.
- **Message details.** With the grid's **Value Panel** on, the selected message shows its value laid
  out, its headers, and its partition, offset, time, size and schema ids. **Copy Message as JSON**
  copies all of it and **Open Message in Console** writes the `consume` command that reads it again.
  When the read started from a group, the message at that group's committed offset says so.
- **Partitions, Configs and Consumers.** **Partitions** lists leaders, replicas, in-sync replicas
  (an under-replicated partition says so) and watermarks, with **Add Partitions…** and **Delete
  Records…**. **Configs** lists each setting with its source, with **Edit Topic Configs…**.
  **Consumers** lists the groups that commit on the topic with their state and lag.
- **Consumer group tab.** Its state, members and their assignments, and per partition the committed
  offset, the end offset and the lag on one scale, the partitions far behind the rest in amber. It
  refreshes itself while you look at it and says when it last did. **Read from Here** (or a
  double-click on a lag row) opens the topic on that partition from the committed offset. **Reset
  Offsets…** moves the group to the earliest or latest offset, to an offset, to a time or by a
  shift, for one topic or all, on every partition or the ones you type. It previews every partition
  first, and its button names the consequence: **Apply and Skip N**, **Apply and Re-read N**, or
  both; it warns when messages are skipped or more than the lag warning would be read again. **Skip
  Record on Partition N…** on a lag row, or **Skip This Record for a Group…** on a message, opens it
  as a shift of one past a poison message. Kafka only lets an empty group move, so a group with
  members is refused, naming them.
- **Producing.** **Produce Message…** sends a key, a value and headers to a partition you pick or
  the one Kafka picks, encoded in the topic's format. When the topic has a `<topic>-value` subject,
  its latest version is picked and named; the value is checked against it before anything is sent.
  The dialog shows the partition and offset it landed on and stays open for the next message.
- **Topic administration.** **Create Topic…** with its partitions, replication factor and settings
  picked from the common ones; it warns when the name would collide with another topic once `.`
  becomes `_` in Kafka's metrics. **Edit Topic Configs…** edits settings or resets them to the
  default, listing each change before **Apply**. **Add Partitions…**. **Delete Records…** before an
  offset, a time or all records, previewed per partition first. **Delete Topic…**.
- **Confirming.** Every write dialog names the data source in its title, and on a production
  (red) data source says so in a strip. In Reset Offsets, Delete Records and Produce Message, Enter
  only refreshes the preview: the button that applies runs on a click. Deleting a topic, deleting
  records, and resetting a group on a production data source ask you to type its name.
- **Read-only data sources.** Produce and every change to a topic or group are off, and their
  buttons say why.
- **Live tail.** **Tail Topic** follows new messages as they arrive in the **Live Tail** tool
  window, without a group. It keeps the newest messages within a memory limit, marks where it had to
  drop some, and draws the newest 1,000. **Pause** freezes the view while the tail keeps running and
  counts what arrived. **Filter** takes text or a `/regex/`. Select a message to see its key, headers
  and value; **Open in Topic Tab at This Offset** (or a double-click) reads from it. **Export…**
  writes the held messages to a JSON Lines file, and **Copy as JSON Lines** copies them.
- **Schema Registry.** Double-click a subject for its tab: its versions, each version's schema, the
  compatibility level, **Check Compatibility…** for a new schema and **Register New Version…**.
  Double-click a broker for its information.
- **Console.** `kcat`-shaped commands with completion: `topics`, `describe`, `consume`, `produce`,
  `create-topic`, `delete-topic`, `alter-config`, `add-partitions`, `delete-records`, `groups`,
  `group`, `lag`, `reset-offsets` (`--dry-run` previews), `delete-group`, `delete-offsets`,
  `brokers`, `subjects`, `schema`, `register` and `compatibility`. Commands that change the cluster
  are refused on a read-only data source, and deleting asks you to confirm.

See [decision 169](../decisions/169-stream-services-are-capabilities-with-their-own-tree.md) and
[decision 171](../decisions/171-the-kafka-plugin-has-its-own-schema-registry-client.md).
