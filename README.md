# abap2UI5 for VS Code

VS Code extension for developing **abap2UI5** apps: launch an app with **F9**,
see it right next to the source, and have it reload automatically when you
activate the class — without the context switch to the browser. The whole
[abap2UI5 linter](https://github.com/abap2UI5/linter) runs in the editor while
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

## Development

```bash
npm install
npm run compile      # builds dist/extension.js with esbuild
```

Open this repository in VS Code and press **F5** → a second VS Code window
(Extension Development Host) starts with the extension loaded.

Handy while developing: `npm run watch` rebuilds on every change,
`npm run lint` type-checks (`tsc --noEmit`) and `npm test` runs the unit
suite. The tests cover the modules that do not import `vscode` — URL and ABAP
source handling, the completion context analysis, the metadata queries and the
`abap2ui5lint.jsonc` merge — bundled with the same esbuild config the
extension uses and run with `node --test`.

## Packaging as a `.vsix`

```bash
npm install
npm run vsix
```

The result is a file such as `abap2ui5-0.9.3.vsix`.

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
  git tag v0.9.3
  git push origin v0.9.3
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
