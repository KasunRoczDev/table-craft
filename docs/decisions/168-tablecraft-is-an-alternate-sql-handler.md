# 168: TableCraft is an alternate handler for .sql files

Status: Proposed.

## Decision

TableCraft tells each OS it can open `.sql` files, as an alternative to whatever opens them today,
and opens every file the OS hands it as a file console in the running window (plan 163).

- **macOS.** `mac.extendInfo` in `electron-builder.yml` declares one `CFBundleDocumentTypes` entry,
  `org.iso.sql` with the `sql` extension, role Editor and `LSHandlerRank` Alternate, and imports the
  `org.iso.sql` type. Finder sends the file as `open-file`, heard before `ready`.
- **Windows.** `build/installer.nsh` writes the `TableCraft.sql` ProgID, adds it to
  `.sql\OpenWithProgids` and lists `.sql` under `Applications\TableCraft.exe\SupportedTypes`; the
  uninstaller removes them. Explorer passes the path on the command line.
- **Linux.** `linux.fileAssociations` gives the desktop entry `MimeType=application/sql`.
- **One way in.** `main/launchFiles.ts` gathers the paths from `open-file`, the first command line
  and a second launch's command line, keeps existing regular files only, and holds them until the
  window has restored its layout and asks (`sqlFiles.launched`); later ones are pushed
  (`sql-files.open-launched`). The renderer opens them with the same `fileConsoles.open` as Open
  File… and Recent Files.

## Rationale

Users who chose TableCraft from Open With saw an empty window: no bundle declared a document type,
no installer registered the extension, and main never read the paths it was given. Most people who
open `.sql` files already have an editor set for them, often an IDE; taking the default on install
would be a surprise and is hard to undo on Windows. So TableCraft only offers itself, and the user
makes it the default through the OS if they want to.

electron-builder's top-level `fileAssociations` was rejected for macOS and Windows: on macOS it
writes no `LSItemContentTypes`, so Finder may not match the system's `org.iso.sql` type, and its
NSIS script writes the extension's default value, which takes `.sql` over. On Linux it writes only
the MIME type and a desktop entry, which is what an alternate handler needs.

Holding the paths until the renderer asks, rather than pushing them when the window loads, keeps the
launched file from racing the restored layout: it opens last and is the active tab.

## Consequences

A file opened with TableCraft is added to Recent Files and remembered like any other file console.
Only `.sql` is registered; other extensions still open through Open File…. A second launch naming
files on Windows and Linux exits after handing them over, as it always did on the single-instance
lock. The registry entries live under the install's own context, per user or per machine.
