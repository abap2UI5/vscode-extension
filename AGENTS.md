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
| `src/launch.ts` | F9 (`runApp`), the Ctrl+F3 activate-and-reload command, the proxy-status watch, the connect-system flow |
| `src/previewcore.ts` | `vscode`-free preview core: the `AppTarget`, the load/stale messages, reload-trigger resolution, model roots, the recent-apps list |
| `src/activationwatch.ts` | `vscode`-free activation watch: polls the class state on the server while the preview is stale and reloads on the observed activation |
| `src/web/extension.ts` | Web-host activation (vscode.dev/BAS): loads the snapshot via `workspace.fs`, registers the in-process features only |
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
| `src/checkcore.ts` | The view check's `vscode`-free decisions: checkability, the render-gate command ladder, scratch-file naming, the JSON report parsing |
| `src/configcore.ts` | `vscode`/`fs`/`path`-free: what an `abap2ui5lint.jsonc` MEANS for a check (precedence, nearest-config discovery, baseline application) - shared by the desktop and web readers |
| `src/lintconfig.ts` | Discovers and merges the repo's `abap2ui5lint.jsonc` with the VS Code settings; applies its `baseline` file (mtime-cached) |
| `src/quickfix.ts` | Code actions: the linter's own fixes, "fix all", the disable-directive waiver, and "add to baseline" |
| `src/language.ts` | The VS Code plumbing for completion/hover (`languagecore.ts` decides the offers); the chain formatter and method navigation |
| `src/languagecore.ts` | The `vscode`-free completion/hover core: combines `context.ts` (where the cursor is) with `metadata.ts` + `bindingpaths.ts` (what may go there) into plain offers |
| `src/clientapi.ts` | The bundled `z2ui5_if_client` method reference (signatures + docs) behind the `client->` hover and completion |
| `src/chainformat.ts` | Format Document for builder chains: per-line indents from the chain's own nesting |
| `src/renderloc.ts` | Places a render-gate error message on the source line quoting its token |
| `scripts/generate-client-api.mjs` | Regenerates `src/data/client-api.json` from `z2ui5_if_client.intf.abap` (local checkout or GitHub raw) |
| `src/bindingpaths.ts` | Binding-path offers from the model shape the linter derives (`prepareAbap( ).modelShape`) |
| `src/viewpreview.ts` | "Preview View (No System)": runs the linter's `--screenshot` over the buffer and shows the PNGs in a panel that re-renders on save |
| `src/xmlpreview.ts` | "Show Reconstructed XML View": virtual document + live refresh |
| `src/xmlformat.ts` | Pretty-printer for the reconstructed view trees (`prepareAbap( ).nodes`) |
| `src/examples.ts` | `vscode`-free: finds and ranks a control's uses in the sample catalogues |
| `src/exampleview.ts` | "Show Examples for this Control": catalogue discovery, QuickPick, opens the hit |
| `src/findingsbar.ts` | The view check's status-bar line: counts of the active file's findings, from the published diagnostics |
| `src/codelens.ts` | Run / Activate & reload / Check views / Autofix above the class definition |
| `src/mcp.ts` | Registers the abap2UI5 MCP server (ai-mcp) and the in-extension system server for MCP clients in the window |
| `src/mcprpc.ts` | Minimal MCP JSON-RPC dispatch (initialize, tools/list, tools/call) behind the system server |
| `src/mcpsystem.ts` | The abap2UI5 System MCP server: HTTP host + the real-system tools (list/search/run-with-screenshot) |
| `src/traffic.ts` | Formatting for the proxy's traffic log (the "abap2UI5 Traffic" channel and the roundtrip badge) |
| `src/screenshot.ts` | "Take App Screenshot": finds the render gate's Chromium and renders the proxied URL headless |
| `src/colors.ts` | Colour spans for colour-typed property values (the swatch/picker provider's logic) |
| `src/xmltoabap.ts` | "Convert XML View to Builder Chain": XML parser + corpus-style chain emitter |
| `src/convert.ts` | The convert command's plumbing (source pick, result document) |
| `src/wizard.ts` | "New App from Template": template gallery pick + class name input |
| `src/propedit.ts` | Property-editor edits: set/add/remove one `a( )` attribute as a span edit |
| `src/propview.ts` | The "Control Properties" webview view: cursor -> `controlCallAt` -> form -> WorkspaceEdit |
| `src/navmap.ts` | App navigation graph: nav_app_call extraction, column layout, SVG rendering |
| `src/navview.ts` | "Show App Navigation Map": workspace scan + the webview panel around the SVG |
| `src/snapshot.ts` | Loads the bundled UI5 metadata once, for the gate and the language features |
| `src/abap.ts`, `src/urls.ts`, `src/context.ts`, `src/metadata.ts` | The `vscode`-free helpers — see below |
| `src/test/` | `node --test` suite over exactly those modules |
| `snippets/` | ABAP snippets contributed to the editor |
| `media/` | Icons: `icon.svg` (panel), `icon-light/dark.svg` (preview tab), `icon.png` (gallery) |
| `esbuild.js` | Bundles `src/extension.ts` into `dist/extension.js`, and `src/test/` into `dist-test/` |
| `.github/workflows/` | `ci.yml` builds every push and PR, `release.yml` publishes a tagged `.vsix` |

`dist/`, `dist-test/`, `node_modules/` and `*.vsix` are build output and are
not committed.

**The `vscode`-free boundary is load-bearing.** `abap.ts`, `urls.ts`,
`context.ts`, `metadata.ts`, `lintconfig.ts`, `snapshot.ts`,
`bindingpaths.ts`, `xmlformat.ts`, `gate.ts`, `template.ts`, `inspect.ts`,
`clientapi.ts`, `chainformat.ts`, `renderloc.ts`, `traffic.ts`,
`colors.ts`, `xmltoabap.ts`, `propedit.ts`, `navmap.ts`, `mcprpc.ts`, `examples.ts`,
`configcore.ts` (which must stay free of `path` too - the web bundle's shim
does not implement it),
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

Run all four before pushing. CI runs the same commands on every push and pull
request, so a failure there means you skipped this:

```bash
npm install
npm run lint      # tsc --noEmit + eslint (eslint.config.mjs)
npm test          # esbuild -> dist-test, then node --test
npm run package   # production esbuild
npm run vsix      # vsce package, catches manifest errors
```

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
  exactly how the editor and CI drifted apart before.

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
  `selector.ts`. Desktop-only commands are hidden from the web palette with
  `"when": "!isWeb"` entries under `menus.commandPalette`.
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
- The MCP registration (`src/mcp.ts`) and the view checker (`src/viewcheck.ts`)
  both probe checkout directories by name: `linter` (the checker's own
  repository name) plus the **pre-rename aliases** `abap2UI5-linter` and
  `ai-view-check`. The same list lives in ai-mcp's `lib/repos.mjs` as
  `VIEW_CHECK_DIRS` — keep all three in sync, and drop an alias only in a
  coordinated change.

## Related repositories

| Repository | Purpose |
| --- | --- |
| [abap2UI5](https://github.com/abap2UI5/abap2UI5) | Core framework |
| [samples](https://github.com/abap2UI5/samples) | Sample applications |
| [samples-controls](https://github.com/abap2UI5/samples-controls) | Ported demo-kit samples (formerly `abap2UI5-api`, before that `ai-demokit` — where this extension used to live, until 0.6.0) |
| [abap2UI5-linter](https://github.com/abap2UI5/linter) | The view checker behind `src/viewcheck.ts` (SHA-pinned package) and `src/rendergate.ts` (runtime bundle download) |
| [ai-mcp](https://github.com/abap2UI5/ai-mcp) | The MCP server `src/mcp.ts` registers for MCP clients in the window |
