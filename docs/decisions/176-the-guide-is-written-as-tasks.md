# 176: The guide is written as tasks

Status: Accepted

## Decision

A page in `docs/guide/` opens with what the feature is and where it sits, then its GIF. Its `##`
headings name areas of the app with nouns and keep the text they have, and the `###` headings
under them name tasks with verbs. A task with three or more actions is a numbered list, one action
per step, the control before its shortcut, ending with what you see; a shorter one is a sentence.
Modes and levels are a list of names with what each does and when to pick it. Limits are said where
they apply, and a plugin page collects its own under `## Limits` after `## Connect` and one `##` per
area it adds. Menu paths use `→`. One page per topic stays, so the README index and the website
sidebar do not move. `test/renderer/userDocs.test.ts` holds prose paragraphs to 120 words and menu
paths to the arrow; the rest is in `CONTRIBUTING.md`, "Write the guide".

## Rationale

The guide explained every feature but read as prose to get through from the top. The answer to "how
do I let an agent run an `UPDATE`" sat in a 346-word paragraph that also covered four access
levels, the Plan button, row caps, re-runs and timeouts. Eight pages had no `##` heading, so the
website's table of contents was empty and a search result could only link to the top of the page.
DataGrip's help answers the same questions with verb headings, numbered steps that end with the
result, and modes listed with when to use them. We take that shape and leave out its boilerplate
openers, its paragraphs copied between pages and its separate concept, task and reference pages,
which would push the README index past its 200 lines.

`##` headings keep their text because in-repo links, the website, old release notes and the tests
that read the shortcut, settings, themes, capabilities and database tables all find sections by it.

## Consequences

Pages grow by about a fifth while their paragraphs shrink. A new feature's documentation is a task
under the area it belongs to, so a reviewer can check it by following the steps. The 120-word cap
is a judgement call; a paragraph that needs more is usually a list or two tasks. Screenshots with
numbered callouts stay out, since the recorded GIFs already show the controls.
