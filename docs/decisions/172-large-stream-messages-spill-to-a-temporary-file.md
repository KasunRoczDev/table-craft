# 172: Large stream messages spill to a temporary file

Status: Accepted

## Decision

A topic read and a live tail keep only a preview of each large message in memory. A message whose
key, value or headers text runs past `MESSAGE_PREVIEW_CHARS` (1,024 characters, in plugin-api) keeps
those cells cut to 1,024 characters and ending in `…`; its whole cells go to a `SpillFile` in the
engine and are read back on demand.

- **The contract.** `TopicBrowser.read(request, spill?)` takes an optional `MessageSpill` with one
  method, `put(partition, offset, message)`. A plugin given one puts the whole key, value and
  headers of each large message it keeps, keeps the preview in its rows, and counts the previews
  against its memory cap (64 MB for Kafka, `READ_PREVIEW_BYTES`). A `put` that rejects stops the
  read with a warning and a resume token, as the byte cap does, so Scan Further carries on. A plugin
  that ignores the argument keeps today's whole rows, so the change is additive within API 2.
- **The engine.** `topics.open` makes one `SpillFile` per read (`spill`, default `true`), keeps it
  under the result handle, and deletes it when the handle is released, replaced, or its session or
  port closes. `topics.message` returns a row's whole cells; Copy Message as JSON, Produce Again and
  the message panel ask for them, and an export of a topic result swaps them in row by row as it
  writes. A live tail writes its large messages to its own file in rotate mode, capped at
  `TOPIC_TAIL_SPILL_BYTES` (512 MiB): the oldest 64 MiB segment goes first and `topics.tailMessage`
  answers null for what it held, which the pane says.
- **The file.** Records are JSON, appended to 64 MiB segments in
  `<os.tmpdir()>/table-craft-spill-<pid>`, made `0700` with files `0600`, behind an in-memory index
  of id to segment, position and length. One `SpillBudget` per engine caps all files together at
  2 GiB and refuses a new segment when the disk would keep less than 1 GiB free (`statfs`); either
  refusal is `SpillFull`, a failed write `SpillFailed`, and neither crashes the engine.
- **Cleanup.** Closing a file deletes its segments, the engine deletes its folder on exit, and each
  engine's start sweeps `table-craft-spill-*` folders whose process is gone, after a crash.
- **The setting.** `data.spillMessages` (Keep large messages on disk, default on); off, the
  renderer sends `spill: false`, which keeps whole messages in memory as before, within the 128 MB
  `READ_KEPT_BYTES`.

## Rationale

A topic of 256 KB messages filled the engine's memory at a few hundred rows, and the renderer's
tail at fewer: every layer held whole messages. Nobody reads a 256 KB value in a grid cell; they
read it in the message panel, one at a time, or export it.

- **Previews instead of a disk-backed result store.** Moving the whole result store to disk would
  touch sort, search, extract, aggregate and every SQL result for the sake of one data source kind.
  Previews keep the grid, sort and filter in memory at a bounded size, and only the few paths that
  need whole messages read the file.
- **The temporary directory.** It is per user, cleaned by the operating system, and needs no
  setting; `<userData>` would survive crashes and grow with the profile backups.
- **Privacy.** The file is message data in plain text on the user's disk, the same data the grid
  already shows. It is readable only by its user, lives only while its result or tail does, is
  swept after a crash, and the setting turns it off for data that must not touch the disk.
- **Caps.** 2 GiB in all and 1 GiB kept free bound what a read can cost the disk; a read that would
  pass them stops and can resume, instead of failing or filling the disk.

## Consequences

- Copy of a cell's value from the grid copies the preview; the message panel and Copy Message as
  JSON give the whole message.
- A live tail's Export and Copy as JSON Lines write previews; a topic tab's export writes whole
  messages.
- A preview of a JSON value is plain text, so the grid no longer lays out a cut JSON document.
- Another streams plugin gets previews by implementing `MessageSpill` in its read; nothing in the
  host branches on the plugin.
