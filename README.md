# abap2UI5 for VS Code

VS Code extension for developing **abap2UI5** apps: launch an app with **F9**,
see it right next to the source, and have it reload automatically when you
activate the class — without the context switch to the browser. The whole
[abap2UI5-linter](https://github.com/abap2UI5/linter) runs in the editor while
you type, so a broken view is a squiggle rather than a blank screen.

Works with any system running abap2UI5 (on-premise or cloud). The only thing
tying the extension to a system is the launch URL you configure once.

## Documentation

**→ [The extension, in full](https://abap2ui5.github.io/docs/advanced/vscode.html)**
— F9 and the embedded preview, the auth proxy and why it exists, reload on
activation, the view checks and quick fixes, completion and hover for the whole
UI5 API, the systemless view preview, the refactorings, the MCP servers, what
works in the browser, and every setting.

## Installing

Install **abap2UI5** from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=abap2ui5.abap2ui5):
Extensions panel (`Ctrl/Cmd + Shift + X`) → search for *abap2UI5* →
**Install**. Through the terminal:

```bash
code --install-extension abap2ui5.abap2ui5
```

On [Open VSX](https://open-vsx.org/extension/abap2ui5/abap2ui5) for VSCodium,
Eclipse Theia, SAP Business Application Studio and friends. Without Marketplace
access, every
[release](https://github.com/abap2UI5/vscode-extension/releases/latest) carries
the `.vsix` — Extensions panel → `…` menu → **Install from VSIX…** — or build
it yourself, see *Packaging* below.

> **Coming from a pre-Marketplace `.vsix` install?** Those builds used the
> placeholder publisher `abap2ui5-local`, which makes them a different
> extension to VS Code — they keep working but never update. Uninstall once
> (`code --uninstall-extension abap2ui5-local.abap2ui5`), then install from the
> Marketplace. Settings are kept; the stored SAP credentials are asked for once
> again.

On the first F9 the extension asks for the launch URL, with `{class}` as the
placeholder:

```
https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100
```

## What you get

- **F9 runs the app** next to the source, and the cursor stays where it was.
  **Ctrl+F3** activates the class through your ABAP tooling and reloads the
  preview — activations done any other way are noticed on the server too.
- **The preview is more than a browser tab**: device widths, themes and
  languages; runtime errors forwarded into the editor; a click-the-control →
  jump-to-the-builder-call inspector; the live JSON model; a traffic log with
  roundtrip timings; headless screenshots; and a pin that carries the model
  across a reload.
- **Static view checks while you type** — the linter's property gate in
  process, the abap2UI5 rules with it, the render gate on demand. Quick fixes,
  waivers that CI honours, and a findings view grouping the repository's
  findings by rule.
- **The whole UI5 API in completion and hover**, plus the binding paths your
  class's model actually has, and the `client->` API with its ABAP signature.
- **Write the view faster**: Format Document repairs a chain's indentation,
  Emmet-style abbreviations expand into one, Extract to View Method splits a
  long one, and *Convert XML View to Builder Chain* turns a demo kit sample
  into ABAP.
- **See the view without a system** — *Preview View (No System)* renders what
  the class builds, with a device matrix and a compare-with-HEAD mode.
- **Navigate an app**: the view hierarchy in the Outline pane, Go to Definition
  between an event and its `WHEN`, F2 renaming every literal an app is wired
  together with, and a navigation map of the workspace's apps.
- **Templates**: *New App from Template* is a gallery of linter-clean
  skeletons; *New Project from Template* writes a whole
  [app-template](https://github.com/abap2UI5/app-template) project.
- **For AI agents**: the
  [abap2UI5 MCP server](https://github.com/abap2UI5/mcp-server) registered for
  every MCP client in the window, plus a second, in-extension server holding
  what only the extension has — the configured systems, the credentials and the
  proxy (`list_systems`, `search_apps`, `run_app_on_system`).
- **Works in the browser** — vscode.dev, github.dev and browser-based SAP
  Business Application Studio get the language half.

All commands are in the Command Palette (`Ctrl/Cmd + Shift + P`) under
*abap2UI5*.

## Settings

Everything lives under the `abap2ui5.` prefix. The full descriptions (with
examples) are in the Settings UI; this reference is generated from
`package.json` with `npm run settings`, and `npm run settings:check` fails
when the two drift apart.

<!-- BEGIN GENERATED SETTINGS (npm run settings) -->
| Setting | Default | Description |
| --- | --- | --- |
| `abap2ui5.launchUrlTemplate` | `""` | URL template used to launch an abap2UI5 app. The `{class}` placeholder is replaced with the (upper-cased) class name. |
| `abap2ui5.systems` | `[]` | The systems F9 can launch against. The active one is picked with the command **"abap2UI5: Select System"** and is remembered per window, so two windows can work against two systems at once. Credentials are stored per host, so switching does not ask again. |
| `abap2ui5.allowUnauthorizedCerts` | `true` | Allow the embedded preview's local auth proxy to talk to systems whose **TLS certificate cannot be verified** - self-signed certificates, private CAs not in the OS trust store, hostname mismatches. SAP development systems typically serve self-signed certificates, which is why this is on by default. |
| `abap2ui5.codeLens` | `true` | Show *Run*, *Activate & reload*, *Check views* and *Autofix n findings* above the class definition of an abap2UI5 app. The autofix lens appears only while the view check has findings it can correct mechanically. |
| `abap2ui5.openMode` | `"tab"` | How F9 opens the app. |
| `abap2ui5.reloadOn` | `"activation"` | When the preview of the shown app class reloads by itself. |
| `abap2ui5.reloadOnSave` | `true` | Reload the preview when the shown app class is saved. *(deprecated)* |
| `abap2ui5.viewCheck.onSave` | `true` | Run the static view check every time a checkable file is saved: an ABAP class building views with `z2ui5_cl_ui5_view_builder`, or a raw `*.view.xml` / `*.fragment.xml`. Findings appear in the Problems panel. The command *"abap2UI5: Check Views (Static)"* runs the same check on demand. |
| `abap2ui5.viewCheck.live` | `true` | Also check while typing, shortly after each pause. Only the bundled property gate runs on a keystroke - it works in-process and needs no I/O; the render gate stays on save and on demand. |
| `abap2ui5.viewCheck.command` | `""` | Command that runs the [abap2UI5-linter](https://github.com/abap2UI5/linter) CLI **for the render gate** - the property gate is bundled with the extension and needs no command. Leave empty for the default: a local checkout under `abap2ui5.mcp.reposRoot` when present (runs with VS Code's own Node.js), otherwise `npx --yes github:abap2UI5/linter`. |
| `abap2ui5.viewCheck.distribution` | `"sapui5"` | Which UI5 distribution the target system serves. SAPUI5 ships libraries OpenUI5 does not (`sap.ui.comp`, `sap.suite.*`, `sap.ushell`, `sap.fe`, `sap.viz`, ...), so a SmartTable is fine on SAPUI5 and a guaranteed runtime error on OpenUI5. With `openui5` such controls are reported as errors. |
| `abap2ui5.viewCheck.minUi5` | `"1.71"` | The UI5 version to check against - **the version your system runs**. A control or property introduced after it is reported (it would not exist on your system), and a deprecation is only reported once it is in effect at that version. The metadata itself comes from the bundled snapshot; see the abap2UI5 output channel for the version it was generated from. |
| `abap2ui5.viewCheck.render` | `false` | Also run the render gate: the reconstructed view is loaded with a real `XMLView.create` in headless Chromium. Unlike the bundled property gate this needs the external checker - install it once with *"abap2UI5: Install Render Gate"* (downloads the checker bundle and Chromium, runs with VS Code's own runtime), or provide your own via `abap2ui5.viewCheck.command` / `abap2ui5.mcp.reposRoot`. |
| `abap2ui5.viewCheck.rollingBundle` | `false` | Download the render gate from the linter's **rolling** bundle instead of the immutable one published for the linter commit this extension build pins. |
| `abap2ui5.viewCheck.allow` | `[]` | Accepted deviations for the property gate, e.g. `sap.m.GenericTile.systemInfo` - each entry is passed to the checker as `--allow`. Merges with the `allow` list of a workspace's `abap2ui5lint.jsonc`. |
| `abap2ui5.viewCheck.rules` | `{}` | Which view-check rules are active, and how loudly. A rule id maps to `false` to switch it off, to `"hint"` / `"warning"` / `"error"` to change its severity, or to `{ "severity": …, "exclude": […] }`. |
| `abap2ui5.inlineFindings` | `"problems"` | Show the view check's message at the end of the line it concerns, next to the squiggle. A builder chain is long and the Problems panel is far away, so the message is put where you are already looking. |
| `abap2ui5.inlineSince` | `true` | Show the UI5 version a control or attribute arrived in, at the end of its line - warned when it is above `abap2ui5.viewCheck.minUi5`. The metadata ships with the extension, so this answers *"does my system have this yet?"* while you write the line rather than after the check runs. |
| `abap2ui5.inlineDeprecated` | `true` | Show a control's or attribute's deprecation at the end of its line, with the replacement the UI5 documentation names. Deprecations and `abap2ui5.inlineSince` share one decoration pass; this switch governs only the deprecation half. |
| `abap2ui5.inlineRoundtripCost` | `true` | Show what each **PUBLIC** attribute adds to a roundtrip, next to its declaration. abap2UI5 serializes every public attribute into the model on every roundtrip; the size is measured from the class's own literal seeds, or from a `<class>.mock.json` when there is one. |
| `abap2ui5.renamePreview` | `true` | Show the refactor preview when **F2** renames an event, a control id or a bound attribute, so every occurrence can be seen before it changes. |
| `abap2ui5.previewThemes` | `[]` | Additional UI5 themes the preview's theme picker offers, merged after the built-in list - for a custom theme deployed on your system. |
| `abap2ui5.previewLanguages` | `[]` | Additional logon languages the preview's language picker offers, merged after the built-in list - passed to the app as `sap-language`. |
| `abap2ui5.viewPreview.theme` | `"sap_horizon"` | The UI5 theme *"abap2UI5: Preview View (No System)"* renders in. Any theme name the runtime ships, e.g. `sap_horizon`, `sap_horizon_dark`, `sap_fiori_3`, `sap_belize`. |
| `abap2ui5.viewPreview.viewport` | `"1280x900"` | The viewport(s) the systemless preview renders at, `<width>x<height>` in CSS pixels - e.g. `390x844` to see the view the way a phone lays it out. **Several, comma-separated, become a device matrix**: `390x844,1280x900` renders both in one browser session and shows them side by side. The picture is taken full-page, so a view taller than the viewport is shown whole. |
| `abap2ui5.mcp.enabled` | `true` | Offer the [abap2UI5 MCP server](https://github.com/abap2UI5/mcp-server) to MCP clients in this window (Copilot agent mode and others). The server gives AI agents the abap2UI5 dev loop without an SAP system: capability queries, static view validation, deploy, build, headless run with screenshot. |
| `abap2ui5.mcp.system` | `true` | Also offer the **abap2UI5 System** MCP server: real-system tools hosted by the extension itself - list the configured systems, search classes on the system (ADT quick search) and run an app through the auth proxy with a headless screenshot. Uses the same credentials the preview stores; the run tool needs the render gate's Chromium. |
| `abap2ui5.mcp.command` | `""` | Command that starts the MCP server. Leave empty for the default: a local checkout under `abap2ui5.mcp.reposRoot` when present, otherwise `npx --yes @abap2ui5/mcp-server`. |
| `abap2ui5.mcp.reposRoot` | `""` | Folder containing the checkouts the MCP server orchestrates (`abap2UI5`, `samples-controls`, `samples`, `samples-stack`, and optionally `linter`, `mcp-server`). The matching `A2UI5_HOME` / `SAMPLES_CONTROLS_HOME` / `SAMPLES_HOME` / `SAMPLES_STACK_HOME` / `AI_VIEW_CHECK_HOME` environment variables are passed to the server, and local `mcp-server` / `linter` checkouts found here are preferred over downloading via npx. |
<!-- END GENERATED SETTINGS -->

## Development

```bash
npm install
npm run compile      # builds dist/extension.js with esbuild
```

Open this repository in VS Code and press **F5** → a second VS Code window
(Extension Development Host) starts with the extension loaded.

Handy while developing: `npm run watch` rebuilds on every change,
`npm run lint` runs `tsc --noEmit` plus eslint, and `npm test` runs the unit
suite with `node --test` — several hundred tests over every `vscode`-free
module (bundled with the same esbuild config the extension ships with), plus
the cross-checks: the manifest against the registered commands, the property
gate against the linter's own pipeline, the snippets and templates through the
bundled linter. The in-host smoke tests (`npm run test:web`,
`npm run test:desktop`) each download a VS Code build and run in CI.

## Packaging as a `.vsix`

```bash
npm install
npm run vsix
```

The result is a file such as `abap2ui5-<version>.vsix`.

> `vsce` is included as a devDependency, so `npm run vsix` uses the local
> version. Alternatively install it globally: `npm install -g @vscode/vsce`.

Every push and pull request builds the same `.vsix` in CI and attaches it to
the run as an artifact — handy for trying out a branch without building it
locally.

## Releasing

Bump `version` in `package.json`, add the matching `CHANGELOG.md` section, then
either

- run the **Release** workflow from the Actions tab — it tags the current
  commit with `v<version>` and releases it, or
- tag the commit yourself:

  ```bash
  git tag v<version>
  git push origin v<version>
  ```

Either way the workflow builds the `.vsix`, creates the GitHub release and
attaches the file, with the changelog section of that version as the release
notes. Tag and `package.json` have to agree, otherwise the run fails on
purpose — and a version that is already released is refused instead of
overwritten.

## Contributing

**This project is English-only.** Code, comments, identifiers, commit messages,
documentation, and every user-facing string in the extension are written in
English — see [AGENTS.md](AGENTS.md) for the full conventions.

## License

MIT — see [LICENSE](LICENSE).
