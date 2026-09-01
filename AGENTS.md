# AGENTS.md

Single source of truth for agents working on the **abap2UI5 VS Code
extension** — the extension that launches `z2ui5_if_app` classes in an
embedded preview from the editor.

> These instructions OVERRIDE any default behavior and must be followed exactly.

## Language

**This entire project is in English.** All code, comments, identifiers, commit
messages, PR titles, PR descriptions, documentation, and any other text must be
written in English.

This explicitly includes **everything the user sees inside VS Code**:

- command titles in `contributes.commands`
- setting descriptions and `enumDescriptions` in `contributes.configuration`
- input-box titles and prompts, information/warning/error messages
- text rendered inside the webview (including `lang="en"` on the HTML)
- snippet names and descriptions

The extension was originally written in German and translated in 0.7.0. If you
find a German string anywhere, it is a leftover — translate it.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Desktop activation: builds the `Session`, wires the preview surfaces, registers every command |
| `src/session.ts` | The desktop session object: all mutable state (shown app, tab, status bar, channels, proxy, focus bookkeeping) with one `dispose()` registered in `context.subscriptions` |
| `src/preview.ts` | The preview surfaces: panel view provider, editor tab, webview message handling, moving the app between tab and panel |
| `src/launch.ts` | F9 (`runApp`), the Ctrl+F3 activate-and-reload command, the proxy-status watch, the connect-system flow, the connection check command |
| `src/connectcheck.ts` | `vscode`-free: what the connection check's probes MEAN - launch-URL shape, DNS/TCP/TLS failure and HTTP-status classification, bootstrap-page detection - behind "Check System Connection" |
| `src/previewcore.ts` | `vscode`-free preview core: the `AppTarget`, the load/stale messages, reload-trigger resolution, model roots, the recent-apps list |
| `src/activationwatch.ts` | `vscode`-free activation watch: polls the class state on the server while the preview is stale and reloads on the observed activation |
| `src/web/extension.ts` | Web-host activation (vscode.dev/BAS): loads the snapshot via `workspace.fs`, registers the in-process features only - including the navigation map, the Control Properties view and the findings tree (fed by `webFindingsNow`, no baseline machinery) |
| `src/webcheck.ts` | The web build's view check: the property gate scheduled live/on-save, repo config through `workspace.fs` (no render gate) |
| `src/gate.ts` | The in-process property gate itself, shared by `viewcheck.ts` (desktop) and `webcheck.ts` (web) |
| `src/diagnostics.ts` | Findings -> VS Code diagnostics (ranges, severities, rule links), shared by both checks |
| `src/selector.ts` | The document selector all view providers share |
| `src/template.ts` | The app-class skeleton both entries insert |
| `src/ui5detect.ts` | Reads the system's `sap-ui-version.json` and offers to align the view-check settings |
| `src/appsearch.ts` | "Run an App from the System": QuickPick over the ADT quick search |
| `src/inspect.ts` | Inspect mode's matcher: runtime control chain -> outline node (the builder call to jump to) |
| `src/modelview.ts` | The live-model document the preview's `{ }` button fills |
| `src/webview.ts` | HTML for the preview and the welcome screen (theme variables, CSP nonce, theme/language pickers, the open-mode-aware empty state) |
| `src/proxy.ts` | Local reverse proxy that injects basic auth so the embedded iframe avoids a 401; authorized by the token in its own url |
| `src/systems.ts` | Named launch profiles, the active-system state, credentials per host |
| `src/viewcheck.ts` | Static view checks via abap2UI5-linter: live + on-save + on-demand + workspace, findings as diagnostics |
| `src/checkcore.ts` | The view check's `vscode`-free decisions: checkability, the render-gate command ladder, scratch-file naming, the JSON report parsing, where a disable directive may be written |
| `src/childproc.ts` | `vscode`-free: the ONE way a checker is started - shell quoting of program AND arguments, timeout, kill of the whole process tree, "nobody is waiting any more" |
| `src/configcore.ts` | `vscode`/`fs`/`path`-free: what an `abap2ui5lint.jsonc` MEANS for a check (precedence, nearest-config discovery, baseline application) - shared by the desktop and web readers |
| `src/lintconfig.ts` | Discovers and merges the repo's `abap2ui5lint.jsonc` with the VS Code settings; applies its `baseline` file (mtime-cached) |
| `src/quickfix.ts` | Code actions: the linter's own fixes, "fix all", the disable-directive waiver, and "add to baseline" |
| `src/language.ts` | The VS Code plumbing for completion/hover (`languagecore.ts` decides the offers); the chain formatter and method navigation |
| `src/languagecore.ts` | The `vscode`-free completion/hover core: combines `context.ts` (where the cursor is) with `metadata.ts` + `bindingpaths.ts` (what may go there) into plain offers |
| `src/clientapi.ts` | The bundled `z2ui5_if_client` method reference (signatures + docs) behind the `client->` hover and completion |
| `src/chainformat.ts` | Format Document for builder chains: hands on the linter's own `chain-house-layout` fixes (never a second layout algorithm) |
| `src/renderloc.ts` | Places a render-gate error message on the source line quoting its token |
| `scripts/generate-client-api.mjs` | Regenerates `src/data/client-api.json` from `z2ui5_if_client.intf.abap` (local checkout or GitHub raw) |
| `src/bindingpaths.ts` | Binding-path offers from the model shape the linter derives (`prepareAbap( ).modelShape`) |
| `src/viewpreview.ts` | "Preview View (No System)": runs the linter's `--screenshot` over the buffer and shows the PNGs in a panel that re-renders on save |
| `src/xmlpreview.ts` | "Show Reconstructed XML View": virtual document + live refresh |
| `src/xmlformat.ts` | Pretty-printer for the reconstructed view trees (`prepareAbap( ).nodes`) |
| `src/renamewires.ts` | `vscode`-free: where a control id and a bound attribute are written - both ends of the strings an app is wired with, for F2 |
| `src/extractview.ts` | `vscode`-free: the edits that move a chain tail into a handle-taking method (where a chain may be cut) |
| `src/examples.ts` | `vscode`-free: finds and ranks a control's uses in the sample catalogues |
| `src/catalogue.ts` | `vscode`-free: parses the sample repositories' committed `catalogue.json` (three sibling shapes, pinned in `src/test/fixtures/catalogue-*.json`) and matches a control against the entries |
| `src/exampleview.ts` | "Show Examples for this Control": catalogue discovery, the remote-catalogue fallback (fetch + day cache in memory and `globalState`), QuickPick, opens the hit (editor or GitHub) |
| `src/annotations.ts` | `vscode`-free: what a line deserves to be told about it - `@since` per control/member, roundtrip cost per PUBLIC attribute |
| `src/inlineview.ts` | The one decoration pass that renders all three inline annotations (findings, `@since`, cost) |
| `src/abbreviation.ts` | `vscode`-free: Emmet-style abbreviations -> element tree -> chain (emitted by `xmltoabap.ts`) |
| `src/appview.ts` | The "abap2UI5 Apps" tree: every z2ui5_if_app class with run/preview/check |
| `src/findingsview.ts` | The "abap2UI5 Findings" tree in the Explorer: the published diagnostics grouped by rule |
| `src/findingsbar.ts` | The view check's status-bar line: counts of the active file's findings, from the published diagnostics |
| `src/codelens.ts` | Run / Activate & reload / Check views / Autofix above the class definition |
| `src/mcp.ts` | Registers the abap2UI5 MCP server (mcp-server) and the in-extension system server for MCP clients in the window |
| `src/mcprpc.ts` | Minimal MCP JSON-RPC dispatch (initialize, tools/list, tools/call) behind the system server |
| `src/mcpsystem.ts` | The abap2UI5 System MCP server: HTTP host + the real-system tools (`list_systems`, `search_apps`, `run_app_on_system`) |
| `src/traffic.ts` | Formatting for the proxy's traffic log (the "abap2UI5 Traffic" channel and the roundtrip badge) |
| `src/screenshot.ts` | "Take App Screenshot": finds the render gate's Chromium and renders the proxied URL headless |
| `src/colors.ts` | Colour spans for colour-typed property values (the swatch/picker provider's logic) |
| `src/xmltoabap.ts` | "Convert XML View to Builder Chain": XML parser + corpus-style chain emitter |
| `src/convert.ts` | The convert command's plumbing (source pick, result document) |
| `src/wizard.ts` | "New App from Template" and "New Project from Template": template gallery pick, class name input, writing the project |
| `src/scaffold.ts` | `vscode`-free: every file a new project gets, as data — app-template's own files copied from `src/data/app-template.json`, the name-carrying ones written here |
| `scripts/generate-app-template.mjs` | Regenerates `src/data/app-template.json` from abap2UI5/app-template (local checkout or GitHub raw); `--check` fails when it is stale |
| `src/repolayout.ts` | The sibling-checkout directory names, out of the generated `src/data/repo-dirs.json` snapshot |
| `scripts/generate-repo-dirs.mjs` | Regenerates `src/data/repo-dirs.json` from abap2UI5/mcp-server's `lib/repo-dirs.json` (local checkout or GitHub raw); `--check` fails when it is stale |
| `src/propedit.ts` | Property-editor edits: set/add/remove one `a( )` attribute as a span edit |
| `src/propview.ts` | The "Control Properties" webview view: cursor -> `controlCallAt` -> form -> WorkspaceEdit |
| `src/navmap.ts` | App navigation graph: nav_app_call extraction, column layout, SVG rendering |
| `src/navview.ts` | "Show App Navigation Map": workspace scan + the webview panel around the SVG |
| `src/snapshot.ts` | Loads the bundled UI5 metadata once, for the gate and the language features |
| `src/abapscan.ts` | The ONE ABAP lexer: where the literals, comments and string templates are, and the blanked source every regex-reading feature runs over |
| `src/abapsources.ts` | "Which ABAP does this window know about?" — the workspace's files PLUS the open documents, so the features that used to glob work when a class comes from ADT rather than from disk |
| `src/appclasses.ts` | "Is this class an app?" answered across INHERITANCE: indexes the window's classes so `isAppSource` can follow `INHERITING FROM` to a base class that carries `z2ui5_if_app` (issue #81) |
| `src/settings.ts` | `CONFIG_SECTION` — the settings prefix, in one dependency-free module so the web build can read it without pulling in the session |
| `src/text.ts` | `plural(count, noun)` — the one pluralizer behind every counted string users read (dependency-free) |
| `src/abap.ts`, `src/urls.ts`, `src/context.ts`, `src/metadata.ts` | The `vscode`-free helpers — see below |
| `src/test/` | `node --test` suite over exactly those modules |
| `src/test/desktop/` | The `@vscode/test-electron` smoke test: `suite.ts` runs inside a real VS Code, `runner.mjs` writes the throwaway workspace and launches it |
| `scripts/lib/snapshot.mjs` | The one lifecycle the three snapshot generators share: upstream read (local checkout or GitHub raw), shape check, `--check` byte-compare, write |
| `snippets/` | ABAP snippets contributed to the editor |
| `media/` | Icons: `icon.svg` (panel), `icon-light/dark.svg` (preview tab), `icon.png` (gallery) |
| `esbuild.js` | Bundles `src/extension.ts` into `dist/extension.js`, and `src/test/` into `dist-test/` |
| `.github/workflows/` | `ci.yml` builds every push and PR, `release.yml` publishes a tagged `.vsix`, `bump-snapshot.yml` is the one implementation the four weekly `bump-*.yml` callers share |

`dist/`, `dist-test/`, `node_modules/` and `*.vsix` are build output and are
not committed.

**The `vscode`-free boundary is load-bearing.** `abap.ts`, `urls.ts`,
`context.ts`, `metadata.ts`, `lintconfig.ts`, `snapshot.ts`,
`bindingpaths.ts`, `xmlformat.ts`, `gate.ts`, `template.ts`, `inspect.ts`,
`clientapi.ts`, `chainformat.ts`, `renderloc.ts`, `traffic.ts`, `scaffold.ts`, `childproc.ts`,
`colors.ts`, `xmltoabap.ts`, `propedit.ts`, `navmap.ts`, `mcprpc.ts`, `examples.ts`,
`catalogue.ts`,
`abapscan.ts`, `settings.ts`, `text.ts`,
`configcore.ts` (which must stay free of `path` too - the web bundle's shim
does not implement it), `renamewires.ts`, `extractview.ts`, `annotations.ts`,
`abbreviation.ts`, `connectcheck.ts`,
`proxy.ts`, `previewcore.ts`, `activationwatch.ts`, `languagecore.ts`,
`checkcore.ts` and `webview.ts` (HTML strings only — the state it renders is
passed in) must not import `vscode`: the test suite bundles them for plain
Node, and an accidental import turns a unit test into a module-not-found
error. Put the interesting logic
there and keep the VS Code modules to plumbing — that is what made the regex
bugs (`INTERFACES:`, a class name inside a comment) testable at all.

**Every shipped piece of ABAP must pass the bundled linter.** The snippets
and the app template are corpus too: `src/test/snippets.test.ts` expands
each snippet, wraps it in a class and runs the linter's ABAP rules (plus the
full gate where a view is built) — zero error/warning findings, enforced by
`npm test`. API conventions come from the linter's rules and the
`z2ui5_if_client` abapdoc (the `obsolete` flags in `src/data/client-api.json`
are parsed from it), never from assumption: a method existing with the right
parameters says nothing about whether the ecosystem still wants it called —
that is exactly how an obsolete `_bind_edit` once made it into a snippet.
When the interface changes, regenerate with
`node scripts/generate-client-api.mjs /path/to/abap2UI5` and commit the JSON.

## Build and verify

Run all three before pushing. CI runs the same commands on every push and pull
request, so a failure there means you skipped this:

```bash
npm install
npm run check     # the three below, in order
```

```bash
npm run lint      # tsc --noEmit + eslint (eslint.config.mjs)
npm test          # esbuild -> dist-test, then node --test
npm run vsix      # vsce package - runs vscode:prepublish, i.e. the production build
```

`npm run check` is the ecosystem-wide name for "what CI will say about this
tree" — every repository has one, and it means the same thing in each. Here it
is the three commands above. `npm run vsix` covers `npm run package`: vsce runs
the `vscode:prepublish` script, which *is* the production build, so listing both
built the identical bundles twice — `ci.yml` had already worked that out and
avoided it, and `check` is now aligned with it. The two gates it does not
include are the in-host smoke tests, `npm run test:web` and
`npm run test:desktop`: each needs to download somebody else's VS Code, so
neither can run in a restricted environment. The paragraphs below say why.

The eslint config is tuned to the codebase (empty catch as best-effort
probe, the tests' mid-test `require()`), so a clean tree lints clean -
a finding is a real mistake, not a formatting opinion. There is
deliberately no Prettier: a full pass would reformat nearly every file,
and the gate exists to catch bugs, not to churn the history.

CI installs with `npm ci`, so `package-lock.json` has to stay in sync with
`package.json` — a lockfile left behind fails the build before anything else
runs.

CI additionally runs `npm run test:web`: the web bundle activated in a
headless browser host via `@vscode/test-web` (suite in
`src/web/test/suite.ts`). It needs to download VS Code web and a playwright
chromium, so it may not run in restricted environments — treat it as the CI
gate for "does the web build actually load", not as part of the local loop.

CI also runs `npm run test:desktop`: the desktop bundle activated in a real
VS Code by `@vscode/test-electron` (suite in `src/test/desktop/suite.ts`,
launcher in `src/test/desktop/runner.mjs`). It is the desktop counterpart of
`test:web` and answers what neither `npm test` nor `npm run vsix` can — that
`src/extension.ts` and the `Session` wiring survive a real activation, and that
`dist/properties.json` is found next to the bundle that is actually packaged.
There is no probe API for the last one, so the suite drives the property gate
end to end and insists on a real `unknown-property` diagnostic. It skips itself
(exit 0, with a notice) when there is no display or VS Code cannot be
downloaded; `ABAP2UI5_DESKTOP_TEST_REQUIRED=1`, which CI sets, turns every such
skip into a failure so "it quietly stopped running" cannot become normal.
`npm test` also runs on `windows-latest` in CI: `childproc.ts` exists for
cross-platform shell quoting and process-tree kill, and `checkcore.ts` /
`scaffold.ts` build paths — all of it used to be proven on Ubuntu only.

## Releasing

The `.vsix` is not committed; users download it from the GitHub release.
Releasing is a tag:

1. Bump `version` in `package.json` and add the matching `CHANGELOG.md` section.
2. Either run the **Release** workflow from the Actions tab (it tags
   `v<version>` itself) or push the tag by hand:
   `git tag v<version> && git push origin v<version>`.

`release.yml` verifies that tag and `package.json` agree, refuses a version
that is already released, builds the `.vsix` and attaches it to the release,
using that version's changelog section as the release notes. **The changelog heading has to be exactly `## <version>`** — the
notes are extracted by matching that line, and a mismatch silently produces an
empty release body (the workflow falls back to a placeholder).

After the GitHub release, the same `.vsix` is published to the **VS Code
Marketplace** (as `abap2ui5.abap2ui5`) and to **Open VSX**. Each publish step
runs only when its token is configured as a repository secret and is skipped
with a notice otherwise: `VSCE_PAT` is an Azure DevOps personal access token
with the "Marketplace → Manage" scope for the `abap2ui5` publisher,
`OVSX_PAT` a token from open-vsx.org for the `abap2ui5` namespace. Do not
rename the `name` or `publisher` fields — together they are the Marketplace
identity (see Conventions).

## Conventions

- **Keep the manifest and the code in sync.** Every command registered with
  `registerCommand` needs a matching entry in `contributes.commands`, and vice
  versa — a mismatch only shows up at runtime, not in `tsc`.
- **Settings live under the `abap2ui5.` prefix** and are read through
  `CONFIG_SECTION`. Command IDs use the same prefix.
- **"An app" includes a class that INHERITS `z2ui5_if_app`.** `isAppClass`
  answers only for the source in front of it; every feature that decides
  whether something is an app — F9, the CodeLens, the apps tree, the
  navigation map — asks `isAppSource` (`appclasses.ts`) instead, which
  follows `INHERITING FROM` through the classes the window can see. A shared
  base class holding the interface is a common house pattern and used to make
  the whole extension go quiet on every app built that way. The lookup is
  synchronous by necessity (a CodeLens provider cannot await a scan), so the
  index is rebuilt in the background; an unknown base class means "not an
  app", never a guess.
- **The preview reloads on activation, not on save.** A saved ABAP class is
  still inactive on the server, so reloading would show the old version. Keys
  that other ABAP extensions own (F9, Ctrl+F3) are taken over only with a
  fallback: the command delegates to what the key would otherwise do.
- **Do not rename `name` or `publisher` casually.** Together they form the
  extension ID; changing it makes VS Code treat the result as a different
  extension, orphaning the old install and the SecretStorage entries (which are
  scoped per extension ID). Settings are unaffected — they live in
  `settings.json`.
- **Bump `version` and add a `CHANGELOG.md` entry** with every user-visible
  change. The changelog is written for users of the extension, not for
  reviewers of the diff.
- **Webview markup lives in `src/webview.ts`,** styled only with `--vscode-*`
  theme variables so it works in light, dark and high-contrast themes. Inline
  `<style>`/`<script>` carry the CSP nonce - no `unsafe-inline`, and therefore
  no `style="..."` attributes in the markup either.
- **Never log or persist credentials** anywhere but `context.secrets`. The
  proxy holds them in memory only, as a prepared header. They are keyed by
  origin (`abap2ui5.user:<origin>`); the unscoped pre-0.14 keys are migrated
  on first use, so do not reuse those names for anything else.
- **Every local listener carries a secret in its path.** Both the auth proxy
  (`proxy.ts`) and the system MCP server (`mcpsystem.ts`) forward or act with
  the system credentials, and a port on 127.0.0.1 is reachable by every
  process on the machine and by any page that resolves a name to loopback.
  So: a `randomBytes(16)` token in the url, everything else answered 404, and
  a `Host` that is not loopback refused outright. `proxy.origin` hands the
  token out as part of the base url — callers swap the system origin for it
  and never see the token, and what the app asks for afterwards is relative
  to it. The one path that cannot inherit a prefix, an absolute bootstrap
  like `/sap/public/...`, is covered by the HttpOnly cookie the first
  authorized answer plants. Do not add a second listener without both.
- **A setting that names a program to start is `"scope": "machine"`.**
  `viewCheck.command`, `mcp.command` and `mcp.reposRoot` decide which binary
  the extension spawns; machine scope keeps a cloned repository's
  `.vscode/settings.json` out of that decision. The same three are listed
  under `capabilities.untrustedWorkspaces.restrictedConfigurations`.
- **The linter owns the rules, this extension owns the presentation.**
  Severity, wording, the `fixes` on a finding, the `rules` block and the
  `abap2ui5lint-disable…` directives all live in `@abap2ui5/linter` and are
  applied through it — never re-derived here. Two copies of that semantics is
  exactly how the editor and CI drifted apart before. **Format Document is the
  same rule, not a sibling of it**: `chainformat.ts` asks the linter for
  `chain-house-layout` (switching the opt-in rule on for that one call) and
  hands its whitespace-only fixes to the editor. It used to derive the layout
  itself, and was measurably stricter — eight of samples-controls' 637 builder
  classes would have been re-indented by the editor although the rule calls
  them correct. The **types** come from
  the linter too: it ships `types.d.ts` and declares it per subpath in its
  `exports` map, so `@abap2ui5/linter/reconstruct` and friends type-check
  straight out of `node_modules`. There used to be a hand-written
  `src/linter.d.ts` here; it was a second description of the same shapes and
  could only ever go stale. Do not reintroduce one — if a shape is missing or
  wrong, fix it in the linter.

## Toolchain & supply chain

Facts an agent cannot see from the code but will trip over:

- **The linter is a git devDependency pinned to a COMMIT — in BOTH manifests.**
  `package.json` carries the spec with the SHA appended
  (`"github:abap2UI5/linter#<sha>"`), so a plain `npm install` cannot drift to
  whatever the linter's main happens to be that day, and `package-lock.json`
  records the same commit for `npm ci` (as a `git+ssh://` URL — `npm ci` can
  fail in HTTPS-only/tokenless environments, and it pulls the linter's full
  tree: all `@openui5/*` packages plus playwright, hundreds of MB. In a sandbox
  without the playwright CDN, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci`).
  Consequences: a new linter finding type is **invisible in the editor until
  the pin is bumped** — bump deliberately with
  `npm install @abap2ui5/linter@github:abap2UI5/linter`, which rewrites the
  spec to the BARE form, so append the resolved SHA back into `package.json`
  and commit both files. `bump-linter.yml` does exactly that once a week; it
  used to commit the lockfile alone, which would have left the two manifests
  naming different commits.
  This is the release lever: it tracks the linter's `main`, not its npm
  releases, so a rule reaches the editor before it reaches a version number.
- **`esbuild.js` carries two load-bearing hacks** — do not "clean them up":
  the `import.meta.url` define + `scripts/import-meta-url-shim.mjs` inject
  (ESM linter modules bundled into CJS), and `copySnapshot()`, which copies
  the linter's `data/properties.json` into `dist/` at build time. If
  `dist/properties.json` is missing, the property gate runs with **no
  metadata and finds nothing**, and completion and hover go quiet with it —
  `snapshot.ts` logs why, which is the only signal you get. The test build
  copies the same file into `dist-test/`, because `snapshot.ts` resolves it
  next to its own bundle.
  `copySnapshot()` also copies the linter's **`data/icons.json` into the
  extension root's `data/`** — not next to the bundle. The icon rules are the
  one place the linter resolves its own data file, from `import.meta.url` +
  `"../data"`, which in this CJS bundle is `dist/../data` (and `dist-test/..`,
  so one copy serves both). Nothing fails when it is absent: `loadIcons`
  treats an unreadable file as an empty registry by design, so `unknown-icon`,
  `icon-too-new` and `icon-removed` simply never fired in the editor while CI
  reported them. `data/` is build output — gitignored, and packaged into the
  `.vsix` because `.vscodeignore` does not exclude it.
- **`gate.ts` is a second CALLER of the linter's pipeline, never a second
  pipeline.** It exists because the two hosts feed the metadata snapshot in
  differently (desktop reads a file, the browser gets text through
  `workspace.fs`) while `checkAbapSource` only takes a *path*. Everything else
  it must do exactly as `lib/index.mjs` does — and it silently stopped:
  `models`, `jsonPaths`, `fromAbap`, `prep.structure` and `minUi5` had gone
  missing from the copy, each switching off whole rules (`unknown-model`,
  `json-bind-on-scalar-property`, `raw-javascript-to-frontend`, `excess-shut`
  / `duplicate-property` / `attribute-without-element`, and the icon floor)
  with no symptom beyond CI and the editor disagreeing. `gate.parity.test.ts`
  now diffs the two over fixtures and is the reason a sixth missing input
  fails a test instead of going quiet. The one known difference is written
  down there: the XML branch cannot run `checkIcons`, which the linter does
  not export through its `exports` map.
- **The rule reference is coupled by URL, not by import.** Every diagnostic's
  code links to `https://abap2ui5.github.io/linter/#<rule-id>`, which the
  linter's `generate-rules-page` emits one anchor per rule for. The rule ids
  themselves come from the linter's exported `RULES`, so an id that stops
  existing stops being linked rather than producing a dead link — but the page
  URL is hard-coded in `viewcheck.ts` and moves with the linter's Pages
  deployment.
- **The snapshot's shape is a contract now.** `metadata.ts` reads
  `parent` / `members` / `properties` / `aggregations` / `associations` /
  `events` / `__enums` out of it for completion and hover. `metadata.test.ts`
  runs against the *real* bundled snapshot on purpose: a regenerated snapshot
  that renamed a section would pass any mocked test and silently empty the
  completion list.
- **The web bundle is built with node-builtin shims.** `esbuild.js` builds a
  second bundle (`dist/web/extension.js`, platform `browser`) from
  `src/web/extension.ts`; `fs`/`path`/`url` are aliased to
  `scripts/web-shims/*` because the linter computes a default snapshot path
  with them at import time. Nothing in the web graph may actually CALL `fs` —
  the snapshot arrives via `vscode.workspace.fs` and `setSnapshotText( )`.
  A module that newly pulls `child_process`/`os`/`crypto` into the web graph
  breaks the web build, which is why the desktop-only plumbing stays behind
  `extension.ts` and the shared pieces live in `gate.ts`/`diagnostics.ts`/
  `selector.ts`. `webview.ts` is web-safe in fact, not merely `vscode`-free:
  its nonce comes from Web Crypto (`globalThis.crypto.getRandomValues`), not
  node's `crypto` module - that one import used to be what kept every webview
  out of the web host. Desktop-only commands are hidden from the web palette
  with `"when": "!isWeb"` entries under `menus.commandPalette`.
- **The render gate is downloaded at runtime**, not bundled:
  `src/rendergate.ts` fetches `view-check-bundle.tgz` from the linter's
  rolling prerelease tag `render-gate-bundle` (published by the linter's
  `bundle.yml` on every merge to its main). What installed extensions
  execute for the render gate therefore changes without any release of this
  extension — when debugging a render-gate report, check what the bundle
  currently contains, not only the pinned package.
- **The editor/CI divergence is closed, keep it closed.** `src/lintconfig.ts`
  discovers the workspace's `abap2ui5lint.jsonc` through the linter's own
  `findConfigFrom`/`loadConfig` and lets it win over the VS Code settings, and
  `viewcheck.ts` applies the linter's `applyRules` and `applyDirectives`. Any
  new knob the linter's config grows belongs in that merge — and never as a
  second implementation of the JSONC parsing or the directive syntax here.
- **"New Project from Template" hands out abap2UI5/app-template's own files,
  from a snapshot.** `src/data/app-template.json` carries that repository's
  `abaplint.jsonc`, `abap2ui5lint.jsonc`, `.claude/settings.json`,
  `.gitattributes`, `.gitignore`, `dependabot.yml`, `AGENTS.md`, its
  `package.json` and its `check.yml`; `scaffold.ts` writes the first six
  verbatim and reads the dependency versions, the framework pin, the linter
  action's pin and the app-building guide out of the rest. A snapshot rather
  than a clone because `abap2ui5.newProject` is registered in the WEB entry
  too and vscode.dev has neither git nor a child process — and because the
  content is then data the test suite can run through the bundled linter.
  The cost is drift, which is why there are two halves and only one of them
  runs in CI: `src/test/scaffold.test.ts` holds the scaffold to the snapshot
  (`npm test`), and `npm run app-template:check` holds the snapshot to
  app-template's main. That second half deliberately does **not** run in CI —
  this repository's build must not go red when somebody merges a pull request
  in another one — so `bump-app-template.yml` regenerates weekly instead and
  opens a pull request when the template moved. The cost of that choice is a
  window: between an upstream merge and the Monday bump the snapshot is stale,
  and only `npm run app-template:check` locally says so. **Do not re-type any of those files here.** That is precisely
  how the scaffold came to emit `@abap2ui5/linter@^0.1.1` against an ecosystem
  on 0.2.1, with no framework pin at all.
- **Which files those are is app-template's answer too.** That repository
  describes itself in `template.json` — `files.shared` (what a project takes
  unchanged), `files.named` (what carries a name), what stays with the template
  and why, and the substitutions. The snapshot carries that spec alongside the
  files (`appTemplate.template`), the generator takes its file list from it,
  and `VERBATIM_FILES` in `scaffold.ts` is `files.shared` minus the three the
  scaffold composes around values it reads (`package.json`,
  `.github/workflows/check.yml`, `AGENTS.md`). So a file added to app-template
  reaches a new project here without an edit. mcp-server's `scaffold_app` executes
  the same description; the three executors differ, the description does not.
- **The sibling-checkout naming is mcp-server's, snapshotted here.** The MCP
  registration (`src/mcp.ts`), the view checker (`src/viewcheck.ts`) and the
  example catalogues (`src/exampleview.ts`) all probe a repos root by
  directory name — `linter` plus the **pre-rename aliases** `abap2UI5-linter`
  and `ai-view-check`, `samples-controls` plus `abap2UI5-api` and
  `ai-demokit`, and so on. That history belongs to `abap2UI5/mcp-server`, which is
  the component that RESOLVES the root; it owns it as data in
  `lib/repo-dirs.json`. `src/repolayout.ts` exports the lists out of
  `src/data/repo-dirs.json`, a generated snapshot of that file — same shape as
  app-template and the client API: `scripts/generate-repo-dirs.mjs`,
  `npm run repo-dirs:check` locally and a weekly regeneration through
  `bump-repo-dirs.yml`, and
  `src/test/repolayout.test.ts` holding the module to the snapshot in
  `npm test`. **Add a directory name in mcp-server and regenerate here** — never
  by editing `repolayout.ts`. This used to be two hand-written lists with no
  gate between them, which is a rename that half-lands.
- **The four weekly bump workflows share one implementation.**
  `.github/workflows/bump-snapshot.yml` holds the shape (regenerate → diff →
  gate → open a pull request) and is called through `workflow_call`; the four
  named files are thin callers carrying only the schedule, what to regenerate
  and what to say in the PR. They open their pull requests with
  `BUMP_PR_TOKEN` when that repository secret is configured, and with the
  default `GITHUB_TOKEN` otherwise — GitHub does not fire `pull_request`
  workflows for a PR opened with the default token, so **without the secret
  `ci.yml` never runs on a bump PR**, and the generated PR body says so
  outright instead of claiming a check that did not happen. Because of that the
  workflow itself runs the same four commands `ci.yml` runs (`lint`, `test`,
  `vsix`, `test:web`) before opening the PR. `secrets: inherit` on each caller
  is load-bearing: without it the secret is invisible in the called workflow and
  every bump silently falls back to the default token.
- **The `.vsix` size is a gate, not just a number.** `ci.yml` prints the
  package size and its file list and fails above `MAX_VSIX_MB`. 0.25.1 packages
  to ~457 KB, so the 5 MB limit is an order of magnitude of headroom for the
  linter's `properties.json` drifting with the weekly pin — it exists to catch
  an accident (a test bundle, a downloaded VS Code, a `node_modules` tree),
  which is exactly how `dist/web/test.js` used to end up in locally built
  packages before `.vscodeignore` excluded it.

## Related repositories

| Repository | Purpose |
| --- | --- |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Core framework |
| [samples](https://github.com/abap2UI5/samples) | Sample applications |
| [samples-controls](https://github.com/abap2UI5/samples-controls) | Ported demo-kit samples (formerly `abap2UI5-api`, before that `ai-demokit` — where this extension used to live, until 0.6.0) |
| [abap2UI5-linter](https://github.com/abap2UI5/linter) | The view checker behind `src/viewcheck.ts` (SHA-pinned package) and `src/rendergate.ts` (runtime bundle download) |
| [mcp-server](https://github.com/abap2UI5/mcp-server) | The MCP server `src/mcp.ts` registers for MCP clients in the window |
