# 166: The website is built from the guide and the app tokens

Status: Proposed.

## Decision

The project website lives in `packages/website` (`@table-craft/website`, private), an Astro site on
Starlight. It owns no copy of the docs and no colour of its own.

- **The guide is the only source.** `scripts/sync.ts` runs before `astro dev` and `astro build`. It
  turns each `docs/guide/*.md` into a Starlight page: the H1 becomes `title`, the README index line
  becomes `description`, and `editUrl` points at the guide file. Links are rewritten:
  `../media/x.gif` to `/media/x.gif`, `foo.md#a` to `/docs/foo/#a`, anything else outside the guide
  to its GitHub URL on `main`. The output, the copied GIFs and the icons are git-ignored.
- **The README index is the sidebar.** The groups, order and link text of README `## Documentation`
  become the sidebar and the `/docs/` overview. A guide page missing from the index fails the sync.
- **Colours and fonts come from `themes.ts`.** Sync writes `tokens.css`, which maps `DARK_COLORS`
  and `LIGHT_COLORS` onto Starlight's `--sl-color-*` and the site's `--tc-*` variables. The
  code-block themes are built from the same `syntax` tokens. Fonts are `SYSTEM_UI_FONT` and
  `SYSTEM_MONO_FONT`, and radii are the Islands ones. Dark is the default and Light follows the
  toggle. No web font is downloaded.
- **The layout follows Linear, without its lines.** A panel ladder that steps by tone, as Islands
  do: no hairlines, outlined boxes or shadows, no eyebrow labels and no monospace outside code. GIFs
  from `docs/media/` run large beside each highlight. Keycaps for the DataGrip chords come from
  Raycast.
- **Downloads and the changelog come from GitHub.** Download links are the README's
  `releases/latest/download/` URLs, held once in `scripts/site.ts` and checked against the README by
  a test. The changelog is the published releases, fetched at build time. Drafts and prereleases are
  left out, the repeated Install block is dropped, and guide links point back into the site. A
  failed fetch leaves an empty changelog that links to GitHub Releases. The build still passes.
- **Broken links fail CI.** `starlight-links-validator` checks every internal link and anchor, and
  `verify` runs `bun run website:build`.
- **Pure parts are tested.** The guide transform, tokens, code themes, releases and platform
  detection live in `packages/website/scripts/` and are unit-tested from `test/website/`.
  `.astro` files hold markup. The website has its own TypeScript program, since it needs the DOM
  and Astro types the root program leaves out.

## Rationale

A hand-kept docs copy would drift from the guide that `test/renderer/userDocs.test.ts` already
checks against the code. The guide cannot carry frontmatter, since its H1 must stay on line 0, and
its links are relative to GitHub. So a build-time transform is the only way to serve the guide as
it is.

Starlight brings a sidebar, a table of contents, Pagefind search, a theme toggle and a 404 page,
which a docs site would otherwise build by hand.

Taking the colours from `themes.ts` keeps the site looking like the screenshots it shows, and a
theme change in the app reaches the site with no second edit. The awesome-design-md survey ranked
Linear first among dense developer-tool sites. Its dark surface ladder maps onto Darcula's tones
one for one.

## Consequences

- A guide link must now resolve on GitHub and on the site.
- Astro, Starlight, the validator, `marked` and `sharp` join `bun.lock`, scoped to
  `packages/website`. The app and plugins never import them.
- `verify` builds the site, which adds about a minute and one GitHub API call per run.
- Deploying the site (GitHub Pages or a domain) is left to the maintainer. `TABLE_CRAFT_WEBSITE_URL`
  sets the canonical URL and sitemap when it is deployed.
