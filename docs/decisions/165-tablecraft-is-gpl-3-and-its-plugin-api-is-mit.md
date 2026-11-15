# 165: TableCraft is GPL-3.0-or-later and its plugin API is MIT

Status: Accepted

## Decision

TableCraft is licensed under the GNU General Public License, version 3 or (at your option) any
later version. The root `LICENSE` is the GPL v3 text, unchanged, and every workspace package
declares `GPL-3.0-or-later`, except `packages/plugin-api` (`@tablecraft-app/plugin-api`), which
stays MIT with its own `LICENSE`.

`LICENSE-EXCEPTION` grants an additional permission under GPL section 7: a datasource plugin that
interacts with TableCraft only through the interfaces of `@tablecraft-app/plugin-api` may be
conveyed under any license. `NOTICE` states the grant, points at the exception and names the MIT
package.

The packaged app ships `LICENSE`, `LICENSE-EXCEPTION` and `NOTICE` in `resources/licenses/`. The
optional plugin packages carry `LICENSE` and `LICENSE-EXCEPTION` and take their `license` field from
the root `package.json`; the published plugin API takes its MIT `LICENSE` from its own directory.

Source files carry no licence header. Releases made before the change stay MIT.

## Rationale

The GPL keeps redistributed and modified copies of the app free: whoever ships TableCraft ships its
source under the same terms. "Or later" lets the project follow a future GPL version without asking
every contributor again.

The plugin API is the one package third parties build against. Under the GPL, a plugin that links
it would itself have to be GPL, which would rule out a closed driver or a company's internal
plugin. Keeping the package MIT covers the code a plugin compiles against, but not the plugin's
combination with the GPL'd app at runtime, so the section 7 exception says so explicitly, as GCC's
runtime exception and many GPL editors' plugin exceptions do.

Per-file headers were left out: the tree has none, the GPL recommends them without requiring them,
and `LICENSE` with `NOTICE` at the root states the terms for every file.

Every dependency the app bundles is under a GPL-3-compatible licence (MIT, ISC, BSD, Apache-2.0,
CC0, and elkjs's `EPL-2.0 OR GPL-3.0-or-later`, decision 157).

## Consequences

- Anyone who redistributes TableCraft, modified or not, does so under GPL-3.0-or-later with its
  corresponding source. The public repository at the release's `v*` tag is that source.
- Plugin authors keep the choice of licence, as long as their plugin uses only the plugin API.
  `docs/guide/writing-plugins.md` says so.
- Code moved from another package into `packages/plugin-api` changes licence from GPL to MIT; only
  code its authors agree to license as MIT may move there.
- `test/scripts/license.test.ts` fails when a new workspace package declares another licence.
