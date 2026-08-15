# Changelog

## 0.23.0

- **The abap2UI5 logo, everywhere the extension shows an icon.** The generic
  placeholder is gone: the red abap2UI5 disc is now the Marketplace tile, the
  icon of the **abap2UI5** tab in the bottom panel, and the tab icon of the
  app preview and the navigation map. The Marketplace tile carries the full
  logo; the three small icons are 16 and 24 pixels wide, where two lines of
  wordmark are a smudge, so they carry a short mark — the logo's own **a** and
  **2**, in the logo's own type, side by side on the disc. The panel tab has
  them punched out of the disc rather than painted on it, because VS Code
  tints that icon with the theme colour and keeps only its silhouette.

## 0.22.0

- **TLS verification is configurable.** The auth proxy used to accept any
  certificate from the system unconditionally; the new setting
  `abap2ui5.allowUnauthorizedCerts` makes that a choice. It stays **on by
  default** — SAP development systems typically serve self-signed
  certificates — but if your system presents a properly trusted
  certificate, turn it off and the proxy verifies the chain on every
  request, closing the machine-in-the-middle window the default leaves
  open. The setting description spells out the tradeoff.

## 0.21.0

- **Traffic log with roundtrip timings.** The auth proxy sees every request
  the embedded app makes; the new **abap2UI5 Traffic** output channel logs
  each one with method, status, size and the full roundtrip duration, and
  the preview toolbar shows the last backend POST's timing as a badge
  (warning-coloured from 1 s). "Is the backend slow or the UI?" stops being
  a devtools trip.
- **Take App Screenshot.** The running app as a PNG, opened beside the code
  with Save As… one click away — rendered by the render gate's headless
  Chromium through the same auth proxy, so no login page and no browser.
  Command, plus the 📷 button in the preview toolbar.
- **Stateful reload.** The 📌 toolbar toggle captures the app's JSON model
  right before a reload and restores it into the fresh page — only the
  paths the class itself declares (the same derived model completion
  already uses), so framework state stays with the fresh load. A
  popup-deep test state survives the activate-reload loop.
- **Control Properties panel.** The builder control under the cursor as an
  editable form, next to the App Preview: written attributes with enum
  dropdowns from the UI5 metadata, expression values read-only, an add-row
  for every member the control accepts but does not set. Every change is an
  ordinary text edit of the `a( )` calls — undo works, the linter
  re-checks. With Inspect: click the control in the app, adjust it in the
  form.
- **Colour swatches.** A colour written into a colour-typed property
  (`sap.ui.core.CSSColor` and friends) gets VS Code's inline swatch and
  colour picker — in builder chains and raw view XML, on the web too.
- **Convert XML View to Builder Chain.** The reverse of the reconstructed
  XML view: paste a UI5 demo kit sample (selection, document or clipboard)
  and get the `z2ui5_cl_ai_xml` chain in the corpus style — Format Document
  is a no-op on the result, and whatever the builder cannot express becomes
  a TODO comment instead of a silent drop. Porting starts with paste.
- **New App from Template.** The single skeleton grew into a gallery:
  empty view, list, form, master & detail, popup — pick one, name the
  class, and it lands at the cursor or as a new document. Every template
  passes the bundled linter in the test suite, so the gallery cannot teach
  what the linter reports.
- **App navigation map.** *"Show App Navigation Map"* draws every
  `z2ui5_if_app` class in the workspace and each `nav_app_call( )` between
  them as a clickable graph — apps nothing navigates to on the left,
  unresolved targets dashed. Click a node, land in the class.
- **Fixed: the `z2ui5table` and `z2ui5popup` snippets' chains were
  unbalanced.** Their mid-chain `)->shut( )` segments closed one
  parenthesis too many - the linter's reconstruction scan tolerated it, a
  real system would not have. A mid-chain shut now stays open for the next
  line's `)` (the corpus style), and a new test pins the paren balance of
  every shipped snippet and template so it cannot regress.
- **The abap2UI5 System MCP server.** ai-mcp stays the system-less
  sandbox; the extension now also offers real-system tools it alone can
  provide (configured systems, stored credentials, auth proxy):
  `list_systems`, `search_apps` (ADT quick search) and `run_app` — the app
  rendered on the system, returned as a screenshot. Hosted in-extension
  over HTTP on 127.0.0.1, disabled with `abap2ui5.mcp.system: false`.

## 0.20.0

- **The client API is known before the fact.** `client->` completion offers
  every `z2ui5_if_client` method, and hovering a call shows its full ABAP
  signature and documentation - parsed from the interface source and bundled,
  so `popover_display( xml = … by_id = … )` is offered correctly instead of
  corrected afterwards. Triggered by the `>` of the arrow.
- **Format Document repairs a builder chain.** The chain IS the view
  hierarchy, so its indentation is structure, not taste: a child one step
  under its parent, an attribute one step under its element, a `shut( )` on
  the level of the `open( )` it closes. Only lines beginning with a builder
  verb inside a chain are touched - comments, multi-line values and
  everything else keep their bytes. Verified as a no-op against the
  canonical corpus style.
- **Baseline support - adopt the linter without fixing everything first.**
  When `abap2ui5lint.jsonc` names a `baseline` file, the editor drops
  exactly the findings CI drops and logs how many. A new quick fix "add to
  baseline" appends the finding under the cursor to that file (same
  line-free keys as the CLI's `--update-baseline`), and the squiggle
  disappears immediately.
- **Render errors land on their line.** The render gate reports message
  strings, which used to squiggle line 0 of every file. The token the
  message quotes (a value, a control name) is located in the source and the
  error is placed there; only a message quoting nothing keeps line 0.
- **More rules run in the editor.** The in-process gate now hands the class's
  own control ids and root fields to the linter, enabling the
  `CONTROL_BY_ID` wire checks and `relative-binding-without-context` - and
  attaches the `undeclared-namespace` quick fix for conventional prefixes
  (`xmlns:l`, `xmlns:core`, …), exactly like the CLI.
- **Method navigation for the ABAP file.** F12 on a method call jumps to its
  `METHOD` implementation in the class, and the workspace symbol search
  (`Ctrl+T`) finds method implementations across every `*.abap` file.
- **`abap2ui5lint.jsonc` validates while you edit it.** The linter's own
  config schema ships with the extension (`contributes.jsonValidation`), so
  an unknown key or a misspelled rule id squiggles in the config file,
  offline.
- **New snippets.** `z2ui5main` (lifecycle dispatch), `z2ui5popup`,
  `z2ui5popover`, `z2ui5toast`, `z2ui5msgbox`, `z2ui5navto`, `z2ui5navback`,
  `z2ui5modelupdate`, `z2ui5eventarg` - and every shipped snippet (plus the
  app template) now has to pass the bundled linter in the test suite, so a
  snippet can no longer teach what the linter reports.
- **Obsolete client methods are marked.** The `client->` completion strikes
  through what the interface's own abapdoc declares obsolete (`_bind_edit`,
  `nest_view_model_update`, `nest2_view_model_update`), sorts it last, and
  the hover leads with the warning - the deprecation reaches you while
  typing, not from the linter afterwards.
- **Warned when the system outruns the metadata.** When the detected system
  UI5 is newer than the bundled snapshot, the output channel says so - a
  genuinely new control would be reported as unknown, and now the caveat is
  on record instead of a mystery.
- **Activation covers view files.** The extension also activates for XML
  files and workspaces containing `*.view.xml` / `*.fragment.xml`, so raw
  view checking works without opening an ABAP file first.
- **Fix-on-save, documented.** Opt in with
  `"editor.codeActionsOnSave": { "source.fixAll.abap2ui5": "explicit" }` -
  every mechanical fix is applied on save, same as the CLI's `--fix`.

## 0.19.0

- **Inspect: click the app, land in the code.** The 🎯 button in the preview
  toolbar starts a one-shot inspect mode: the hovered control is outlined,
  a click jumps to the `open( )` / `leaf( )` call that wrote it (Esc
  cancels). The clicked control's type and parent chain are matched against
  the reconstructed view, so a row inside a bound list lands on its
  template - and an `id` written in the class settles the match outright.
- **The app's model, one click away.** The `{ }` button asks the running app
  for its JSON model and shows it as a document beside the code - the live
  values next to the statically derived shape completion and hover already
  know. Every click refreshes the same document. "Why is that field empty?"
  is now: look.
- **The XML preview follows the editor.** One preview, like the Markdown
  preview: switch to another view-building class and the XML swaps to that
  class, edit and it re-renders after each pause. A class that builds no
  views leaves the last reconstruction standing instead of blanking the tab.
- **A binding path jumps to its declaration.** Go to Definition on
  `{/MT_TRAVELS/STATUS}` lands on the `status` line of the `TYPES BEGIN OF`
  block (or the `DATA` line for a root path) - the fourth corner of the
  square: completion offers it, hover judges it, the gate reports it, and
  now F12 goes there.
- **`WHEN` branches count their raises.** A CodeLens over every `WHEN '…'`
  the view actually raises says "raised n× in the view" and peeks the
  `_event( )` calls. A `WHEN` nothing raises stays unannotated - the CASE
  may switch over something else entirely.
- **Rename an event everywhere at once.** F2 on an event name - in
  `_event( 'GO' )` or on the `WHEN 'GO'` - renames every raise and the
  handler together, so the view and the dispatch cannot drift apart.
- **The detected UI5 version stays visible.** After the first launch the
  status bar shows `UI5 1.xxx` for the active system; clicking it opens the
  view-check settings.
- **CI proves the web build.** `npm run test:web` activates the web bundle
  in a real headless browser extension host (`@vscode/test-web`) and fails
  the build when a module drags a node builtin into the web graph or the
  activation throws - the gap the node-based suite could not cover.

## 0.18.0

- **The reconstructed XML is navigable and honest about problems.** The
  reconstruction records which builder call wrote every node and attribute,
  so the XML preview now uses it: **Go to Definition** on any line jumps to
  its `open( )` / `leaf( )` / `a( )` in the class, and the view check's
  findings are mirrored onto the XML lines they concern - the structure and
  what is wrong with it, in one place.
- **Event navigation.** Go to Definition on the event name in
  `client->_event( 'GO' )` jumps to the `WHEN 'GO'` that handles it - and on
  the `WHEN` literal it jumps back to every place the view raises the event.
  Until now that round trip was a text search by hand.
- **The view hierarchy in the Outline.** A class building views gets its
  `open( )` / `leaf( )` nesting as a labelled tree in the Outline pane
  (`abap2UI5 view`), with the `id` a chain sets shown alongside - a long
  view method reads as a tree again, and the Outline clicks straight to the
  builder call.
- **Hover on binding paths.** Hovering a `{…}` path says what the derived
  model resolves it to - a field, a structure, a table (and that an
  aggregation binds it), a path under an undeclared DDIC type (accepted
  unchecked), or **missing** - the same verdict the gate's
  `unknown-binding-path` rule reaches, before it has to.
- **Runtime errors point back at the source.** When a forwarded runtime
  error names a binding path or a quoted identifier that appears in the
  running class, the output channel adds the file and line right under the
  error - for local files as a clickable `path:line`.
- **The system says which UI5 it runs.** After the first launch against a
  system the extension reads its `sap-ui-version.json` (with the credentials
  the proxy already holds) and, when version or distribution disagree with
  the view-check settings, offers once per system to adopt the answer. No
  more guessing `minUi5`.
- **"Run an App from the System."** A picker backed by the system's ADT
  quick search: type part of a class name, pick, launch - no need to have
  the class open or to have run it before. (A name search - whether the
  class is an app, the launch shows.)
- **Runs in the browser.** The extension now ships a web bundle for
  vscode.dev, github.dev and the browser-based SAP Business Application
  Studio: completion, hover, binding paths, the in-process property gate,
  quick-fix-free diagnostics, the reconstructed XML view, outline and event
  navigation all work there - everything that needs no process and no
  socket. The embedded preview, ADT integration, render gate and MCP server
  stay desktop-only, and their commands hide from the palette on the web.
  One knowing gap: the web check reads the VS Code settings only, not a
  repository's `abap2ui5lint.jsonc`.
- **Getting-started walkthrough.** VS Code's Welcome page now carries the
  whole loop - launch URL, F9, Ctrl+F3, view check, reconstructed XML, MCP -
  as a six-step walkthrough. The Marketplace listing gains the categories
  Programming Languages and Linters.
- **The linter pin moves by itself.** A weekly workflow re-resolves the
  pinned `@abap2ui5/linter` commit, runs the full gate over the result and
  opens a PR - new rules and metadata reach the editor without anyone
  remembering the bump (AGENTS.md calls it the release lever; now it pulls
  itself).

## 0.17.0

- **Runtime errors of the running app reach VS Code.** The embedded preview
  used to swallow them: a thrown error, a failed UI5 assertion, a rejected
  promise were visible only in the browser devtools — exactly the context
  switch the preview exists to avoid. The auth proxy now plants a small hook
  into the app's HTML that forwards `window.onerror`, unhandled rejections
  and `console.error` to the extension: the full text lands in the
  **abap2UI5** output channel, and the preview toolbar counts them in a red
  badge that clicking opens the log. The count resets with every (re)load.
  Applies to `tab` and `panel` mode — `external` opens a real browser, which
  has its own devtools.
- **"Show Reconstructed XML View."** abap2UI5 views are strings assembled by
  builder calls, so what actually reaches `XMLView.create` was never visible.
  The linter reconstructs exactly that for its checks; the new command
  *"abap2UI5: Show Reconstructed XML View"* opens the same reconstruction as
  a read-only, syntax-highlighted XML document next to the class — and keeps
  it following the edits, refreshing shortly after each pause. Debugging a
  nesting or binding problem stops being "stare at the builder chain".
- **Completion for binding paths.** The gate has always *reported* a path the
  derived model does not have (`unknown-binding-path`); now the paths it
  *does* have are offered while the binding is written. Typing `{` in an
  `a( v = … )` literal lists the model's paths — the fields of the enclosing
  aggregation's row first (`{STATUS}` inside a list bound to `{/TRAVELS}`,
  through nested aggregations too), absolute paths after (`/TRAVELS/STATUS`
  walks through the table's row, the way the gate resolves it). Structures
  the class does not declare (DDIC types) are offered as themselves and never
  guessed into, named models and expression bindings are left alone — the
  same lines the gate draws. What is offered is exactly what will not
  squiggle afterwards.

## 0.16.0

- **The abap2UI5 panel is no longer a dead end.** With the default open mode
  (`tab`) F9 opens the app in an editor tab, while the **abap2UI5** view in the
  bottom panel kept showing "press F9, the app opens here" — an instruction
  that was never going to come true there. The empty state now says where the
  app actually opens, and names the app once one is running: *ZCL_MY_APP is
  running in an editor tab*, with **Show it here** and **Go to the tab**.
- **Move the preview without going through the settings.** *"abap2UI5: Show
  the Preview in the Panel"* and *"abap2UI5: Show the Preview in an Editor
  Tab"* switch `abap2ui5.openMode` and take the running app along, so it
  changes place instead of having to be launched again. The panel's title bar
  carries the way back, next to the reload button.
- *"abap2UI5: Go to the Running App"* focuses the preview wherever it is.

## 0.15.0

- **On the VS Code Marketplace.** The extension is published as
  [`abap2ui5.abap2ui5`](https://marketplace.visualstudio.com/items?itemName=abap2ui5.abap2ui5)
  — install and update it from the Extensions panel like any other extension.
  The `.vsix` attached to every GitHub release stays available for offline
  installs.
- **The extension ID changed** from `abap2ui5-local.abap2ui5` to
  `abap2ui5.abap2ui5`: the placeholder publisher gave way to the real
  Marketplace publisher. A previous `.vsix` install keeps working but is a
  different extension to VS Code and will not update — uninstall it once
  (`code --uninstall-extension abap2ui5-local.abap2ui5`) and install from the
  Marketplace. Settings are kept (they live in `settings.json`); the stored
  SAP credentials are scoped to the extension ID, so they are asked for once
  again.

## 0.14.0

- **Completion and hover for every UI5 control and property.** The extension
  already ships the UI5 metadata its view check validates against - a complete
  API reference sitting next to the bundle. It is now offered while the view
  is written: control names inside `open( )` / `leaf( )`, the properties,
  aggregations, associations and events of exactly that control inside the
  `a( )` chained to it, and the accepted values of an enum or boolean
  property. Hover shows the type, the UI5 version a member appeared in, its
  deprecation and a link to the UI5 API reference. Raw `*.view.xml` and
  `*.fragment.xml` files get the same. No system, no network, no setup - the
  knowledge that reported the typo afterwards now prevents it.
- **Quick fixes.** The findings whose correction is mechanical carry the
  correction with them, and the lightbulb now offers it: the obsolete
  `client->_bind_edit( )`, a missing `$` in an event argument, an ABAP boolean
  written straight into the view. "Fix all in this file" comes with it, also
  as `source.fixAll.abap2ui5` for `editor.codeActionsOnSave`.
- **Waive one line, the way CI understands it.** Every finding now offers
  "suppress on this line", which writes the linter's own
  `" abap2ui5lint-disable-next-line <rule>` directive above it. The other half
  of that was a real defect: the editor **ignored** those directives, so a
  line deliberately waived for the CLI and the GitHub Action kept squiggling
  here. It no longer does.
- **The editor reads `abap2ui5lint.jsonc`.** A repository that pins its UI5
  floor, its distribution, its `allow` list or its per-rule severities was
  checked against those in CI and against the VS Code settings here - the same
  file could be clean in the editor and red in CI. The repo config now wins
  wherever it says something, the settings fill in the rest, and the `allow`
  lists merge. The output channel names the file the values came from.
- **Checking while you type.** The property gate runs in-process, so it no
  longer waits for a save: findings appear shortly after each pause. The
  render gate stays on save and on demand. Switch it off with
  `abap2ui5.viewCheck.live`.
- **"Check All Views in the Workspace"** runs the same gate over every ABAP
  class and view file in the workspace and fills the Problems panel - the
  answer to "will the linter gate pass before I push?", which until now only
  covered whatever happened to be open.
- **Every finding links to its rule.** The diagnostic's code is the rule id
  and points at the published rule reference, so a Ctrl+click explains what
  the rule means and what the fix looks like. Deprecations are marked as such,
  so VS Code strikes the member through.
- **More than one system.** `abap2ui5.systems` holds named launch profiles;
  *"abap2UI5: Select System"* switches between them and remembers the choice
  per window, so two windows can work against two systems at once.
  Credentials are stored per host, so switching does not ask again - and an
  existing single-system install keeps working untouched.
- **Theme and language in the preview toolbar.** Both are ordinary URL
  parameters of the app, so checking an app in Horizon Dark or in a second
  logon language is now two clicks instead of a hand-edited URL in the
  browser.
- **A rejected logon says so.** Inside the iframe a 401 was an unhelpful page,
  and the only cure was finding "Clear Stored SAP Credentials" in the palette.
  The proxy sees the answer, so the extension now offers to retype the
  credentials and reloads with them.
- **Run an app without its class open.** *"abap2UI5: Run a Recently Launched
  App"* lists what this window has launched.
- **Run, Activate & reload and Check views above the class definition.** The
  dev loop was discoverable only through the palette; a CodeLens says it out
  loud. Switch it off with `abap2ui5.codeLens`.
- **Fixed: the view check did nothing in a fresh window.** The extension
  declared no activation event, so it only woke up once F9 was pressed or the
  preview panel was opened - until then, saving an ABAP class produced no
  diagnostics at all. It now activates for ABAP files.
- **Fixed: F9 did nothing for `INTERFACES: z2ui5_if_app.`** The chained form
  is just as common as the plain one and was not recognised, so F9 silently
  toggled a breakpoint instead of launching the app.
- **Fixed: two quick saves lost one check.** The checker allowed one run at a
  time globally and dropped anything arriving while it was busy - with the
  render gate on, which takes seconds, that was easy to hit. Runs are now
  tracked per file, and only a newer run for the *same* file supersedes an
  older one.
- **The app template and the snippets use `z2ui5_cl_ai_xml`.** They still
  taught `z2ui5_cl_xml_view`, which is on its way out of abap2UI5 and which
  the view check deliberately does not reconstruct - so "Insert App Template"
  handed out a class the extension's own checker then ignored. Five more
  snippets come with the change (container, input, table, event dispatch, lint
  waiver).
- Internal: the settings that name a program to start (`viewCheck.command`,
  `mcp.command`, `mcp.reposRoot`) are machine-scoped, so a cloned repository
  cannot point them somewhere else; the CSP nonce comes from the crypto RNG;
  the pure helpers moved into `vscode`-free modules with a `node --test` suite
  behind them, which CI now runs; CI and the release build on Node 22, the
  version the bundled linter asks for.
- **The repository moved** from `abap2UI5-addons/vscode-extension` to
  [`abap2UI5/vscode-extension`](https://github.com/abap2UI5/vscode-extension),
  and the linter's from `abap2UI5/abap2UI5-linter` to
  [`abap2UI5/linter`](https://github.com/abap2UI5/linter). GitHub redirects the
  old addresses, so nothing breaks - but the links, the `npx` fallback and the
  render-gate download now name the repositories directly.
- **A linter checkout named `linter` is found again.** Both the MCP
  registration and the view checker probe `#abap2ui5.mcp.reposRoot#` for a
  checkout by directory name, and the list only held the two *pre-rename*
  names. Cloning the linter under its current name therefore produced a
  checkout the extension ignored: the render gate silently fell back to `npx`
  and the MCP server started without `AI_VIEW_CHECK_HOME`. `linter` is now
  probed first, the old names still work.
- Internal: the bundled `@abap2ui5/linter` moved up 19 commits, from the
  extraction commit to the current linter release. Six new rules come with it
  (CSS brace escaping in both its forms, frontend-action wire tokens,
  unresolved and out-of-range event args, dead PUBLIC attributes).

## 0.13.0

- **Findings land on the right line.** Diagnostics used to be placed by
  searching the file for the first occurrence of a name - in a class with
  ten buttons, the squiggle sat under the first one no matter which button
  was broken. The linter now records where every finding came from, so the
  diagnostic goes exactly there: the second duplicate `id`, the `a( )` call
  that sets a property twice, the attribute that carries the typo'd value.
- **Three severities instead of two.** Findings are now classified by the
  linter itself: `error` (the app breaks), `warning` (it works here, but
  not necessarily on the UI5 version your system runs) and - new -
  informational hints for things that are worth knowing but never wrong by
  themselves, such as an event nothing handles or an icon-only button
  without a tooltip. They no longer look like defects in the Problems panel.
- **The binding-path checks now run in the editor at all.** The property
  gate was called without the model derived from the class, and the rules
  that need it stayed silent: a `{/TYPO}` the model has no path for, and a
  table or structure bound to a scalar property. Both now show up on save,
  and inside a bound aggregation a relative `{TYPO}` is resolved against the
  **row** - so a misspelled field in a column template, which otherwise just
  leaves that column empty forever, is caught while you type it.
- **Two new checks, both of which dump before the app reaches the browser:**
  the same attribute written twice on one control, and `a( )` on the bare
  `z2ui5_cl_ai_xml=>factory( )` root with no element to attach it to.
  `z2ui5_cl_ai_xml` asserts on both.

## 0.11.0

- **abap2UI5-specific checks - the defects that stay silent at runtime.**
  A hand-written binding path the model does not have (the field just
  stays empty), `_bind( )` on an event or `_event( )` on a property, a
  value bound to a local variable (lost after the roundtrip, because
  the instance is serialized and the method stack is not), an event
  nothing handles, and the obsolete `client->_bind_edit( )`. No UI5
  tooling can see these - they live in the relationship between the
  ABAP class and the view it builds. Also caught: an ABAP boolean
  written straight into the view - it arrives as `'X'`/`' '`, and since
  UI5 reads any non-empty string as true, `visible = abap_false` makes
  the control *visible*. Wrap it in `z2ui5_cl_ai_xml=>as_bool( )`.
- **Deprecated properties and duplicate aggregations.** Deprecation was
  only checked on control level; it now applies per property too, with
  the same target-version rule. And opening the same aggregation twice
  under one control - where the second tag silently replaces the first -
  is reported as an error.
- **Three more silent failures caught:** a view built but never
  displayed (an empty page, no error), a `Table` bound to rows but
  given no `columns`, and a table or structure bound to a scalar
  property.
- **More view checks:** a duplicate `id` (a runtime error), a namespace
  prefix used but never declared, unbalanced braces in `{= … }`
  expression bindings, and two unambiguous accessibility defects
  (icon-only button without a tooltip, image without `alt`).
- **SAPUI5 or OpenUI5** (`abap2ui5.viewCheck.distribution`). SAPUI5 ships
  libraries OpenUI5 does not - `sap.ui.comp` (Smart controls),
  `sap.suite.*`, `sap.ushell`, `sap.fe`, `sap.viz` - so a SmartTable is
  perfectly fine on SAPUI5 and a guaranteed runtime error on OpenUI5.
  Set it to what your system serves; with `openui5` those controls are
  reported as errors instead of being skipped silently.
- **The target UI5 version now governs deprecations too**
  (`abap2ui5.viewCheck.minUi5`). A control deprecated as of 1.149 is no
  longer flagged for a 1.71 target - only from the version its
  deprecation takes effect. The output channel logs the target version
  and the version the bundled metadata came from.
- **Self-installing render gate.** *"abap2UI5: Install Render Gate"*
  downloads the self-contained checker bundle (published by
  abap2UI5-linter's CI) and Chromium into the extension's storage and runs
  both with VS Code's own runtime - the render gate no longer needs
  node, npm or any PATH setup on the machine. The command is also
  offered directly from the warning when the gate is enabled but
  missing, and installing enables `abap2ui5.viewCheck.render`.
- **Fix: no more "view check passed" on files that only quote builder
  code** (e.g. a log file embedding class source). Checkability now
  requires an ABAP source actually calling `z2ui5_cl_ai_xml=>factory`
  (or a `*.view.xml`), and when nothing can be reconstructed the check
  says so instead of claiming a pass.

## 0.10.0

- **Static view checks in the editor.** Saving an ABAP class that builds
  views with `z2ui5_cl_ai_xml` (or a raw `*.view.xml` / `*.fragment.xml`)
  now runs the [abap2UI5-linter](https://github.com/abap2UI5/abap2UI5-linter)
  gates and shows the findings in the Problems panel: controls that do
  not exist in UI5 at all (`sap.m.Shell2` - a typo, shown as an error),
  controls or properties newer than your UI5 floor (default 1.71), and
  deprecated controls. The property gate and its UI5 metadata snapshot
  are **bundled with the extension** - zero setup, instant, works
  offline, on documents from the ABAP remote filesystem (`adt` scheme)
  and on unsaved buffers. Optionally (`abap2ui5.viewCheck.render`) the
  external abap2UI5-linter (formerly ai-view-check) CLI adds real render errors from a headless
  `XMLView.create`. On demand: *"abap2UI5: Check Views (Static)"*.
  Configure the floor, accepted deviations and the render-gate command
  under `abap2ui5.viewCheck.*`.
- **The abap2UI5 MCP server, offered to every MCP client in the window.**
  The extension registers the
  [ai-mcp](https://github.com/abap2UI5/ai-mcp) server as an MCP server
  definition provider, so Copilot agent mode (and any other MCP client in
  VS Code) can use the abap2UI5 dev loop without an SAP system:
  capability queries, static view validation, deploy into the sandbox,
  transpiled build, headless run returning page errors and a screenshot.
  Point `abap2ui5.mcp.reposRoot` at the folder holding the `abap2UI5`,
  `ai-demokit` (and optionally `abap2UI5-linter`, `ai-mcp`) checkouts;
  disable with `abap2ui5.mcp.enabled`.
- The minimum VS Code version moved from 1.85 to **1.101** (June 2025) -
  the first release with the stable MCP server definition API.

## 0.9.3

- **Fix: every button press in the embedded preview could fail** with
  *"CSRF validation failed - cross-origin POST rejected"*. The embedded app
  talks to the local auth proxy on `127.0.0.1`, so the browser sent that as
  `Origin`/`Referer` while the forwarded request carried the SAP host — a
  mismatch that origin-validating CSRF checks reject on every POST. The proxy
  now rewrites both headers to the system's own origin, so the roundtrips look
  same-origin to the server again.
- **Fix: the activation watch only ever started for `adt:` documents.** Any
  other way of editing a server-backed source never got the automatic reload
  after activation. The watch now starts on every save of the shown class —
  the server knows whether an inactive version exists, whatever the file's
  URI scheme is. (Sources that never reach a server simply never show up as
  inactive, so nothing reloads there either.)
- **Fix: an activation right after the save was missed.** The watch used to
  wait for the class to show up as *inactive* before an *active* answer would
  count as the activation. Activating directly — where the save is part of the
  activation — can be finished on a fast system before the watch ever looks,
  so there was nothing inactive to see and the watch waited for a flip it had
  already missed; only a slow save-then-activate cycle ever reloaded. The
  watch now also remembers the **change timestamp** of the class the preview
  shows: *active with a newer change timestamp* is a finished activation, no
  matter how fast it went. (Sources that never reach the server keep their
  timestamp, so purely local saves still reload nothing.) The first look at
  the server also moved from 2.5 seconds after the save to a quarter of a
  second, with checks every 1.5 seconds after that.
- **New output channel `abap2UI5`** (View → Output): the activation watch says
  what it is doing there — started, class inactive, active again → reload, or
  the reason it stops (ADT unreachable, timeout). When an automatic reload
  does not happen, this is the place that says why.

## 0.9.1

Reloading after activation now actually happens — however you activate
([#5](https://github.com/abap2UI5-addons/vscode-extension/issues/5)).

- **Activations are detected on the server.** 0.9.0 only reloaded on its own
  Ctrl+F3; activating with the ABAP remote filesystem's own button or shortcut
  went unnoticed, because VS Code has no event for it. Now, while the preview
  shows the *not activated* badge, the extension watches the class on the
  server (its ADT metadata, fetched with the credentials it already holds for
  the preview) and reloads as soon as the inactive version is gone — no matter
  whether the activation came from Ctrl+F3, the ABAP extension's own UI or
  even Eclipse. Needs the source to be opened from a system (scheme `adt`) and
  the ADT services answering on the launch-URL host; where they do not, the
  watch stops silently and the badge stays until you reload.
- **Fix: Ctrl+F3 (and the ⚡ button) could stay dead for a whole session.**
  They were gated on a "an ABAP extension with an activate command is
  installed" flag computed once at startup — when this extension happened to
  activate before the ABAP extension had registered its commands, the flag
  stayed false and the key silently did nothing. The gate is now simply "the
  file was opened from an ABAP system" (scheme `adt`), which implies working
  ABAP tooling and cannot go stale.
- **The *not activated* badge is now clickable** — it reloads the preview
  right there (showing the still-active version, as the tooltip says).
- Ctrl+F3 now hands the exact document to `abapfs.activate` instead of relying
  on its active-editor fallback.

## 0.9.0

The preview now reloads when you **activate**, not when you save
([#5](https://github.com/abap2UI5-addons/vscode-extension/issues/5)).

- **No more pointless reload on save.** Saving an ABAP class does not change
  what the server runs — the activation does. A save of the shown class no
  longer reloads the preview; it marks it with a small *not activated* badge in
  the toolbar instead, so it is clear why the app still shows the old version.
- **New command `abap2UI5: Activate and Reload Preview`** on **Ctrl+F3**
  (`Cmd+F3` on macOS, the activation key from SAP GUI) and as a ⚡ button in the
  editor toolbar: it saves the class, hands the activation to the ABAP
  extension you already use (ABAP remote filesystem) and reloads the preview
  afterwards. The key is only taken over for objects opened from a system while
  such an extension is installed — everywhere else Ctrl+F3 keeps its usual
  VS Code meaning.
- **New setting `abap2ui5.reloadOn`** with `activation` (default), `save` and
  `never`. It replaces `abap2ui5.reloadOnSave`, which is deprecated but still
  honoured while the new setting is unset — `false` behaves like `never`,
  `true` like `save`.

## 0.8.0

A visual pass over everything the extension shows.

- **New preview toolbar** with the class name, the system URL, a status dot
  (loading / ready) and buttons for reload and "open externally". It follows
  your colour theme instead of bringing its own colours.
- **Device widths:** switch the preview between desktop, tablet (834px) and
  phone (414px) to check a responsive app without leaving the editor. The
  choice is remembered per preview.
- **Loading state:** a spinner and "Starting ZCL_…" instead of a white area.
  If the app takes longer than 12 seconds, the preview offers *Reload* and
  *Open externally* right there.
- **Welcome screen** in the preview panel: the three steps to a running app,
  plus buttons for the launch URL, the app template and the project page.
- **Status bar entry** while an app is running — shows the class, click
  reloads.
- **Run button in the editor toolbar** for ABAP files, next to the usual
  actions.
- **New commands:** `abap2UI5: Reload Preview` (also in the preview panel's
  title bar) and `abap2UI5: Set Launch URL`, which validates the URL and the
  `{class}` placeholder before saving it.
- **Save toast:** reloading after a save says so in the preview, so a slow
  round trip is not mistaken for nothing happening.
- Extension icon, tab icon and panel icon reworked.
- **The `.vsix` is now a download.** Every release attaches the packaged
  extension to its
  [GitHub release](https://github.com/abap2UI5-addons/vscode-extension/releases/latest),
  so installing no longer means cloning and building. Every push and pull
  request also builds one as a CI artifact.
- Internal: the webview HTML moved to `src/webview.ts` and the inline scripts
  now run under a CSP nonce instead of `unsafe-inline`.

## 0.7.0

- **The project is now English-only.** README, changelog, code comments and
  every user-facing string (command titles, settings descriptions, input
  prompts, error messages, the webview placeholder) were translated from
  German to English. The convention is written down in
  [AGENTS.md](AGENTS.md) so it stays that way.
- Command titles changed accordingly, e.g. "abap2UI5: App starten (F9)" →
  `abap2UI5: Run App (F9)`. Command IDs, setting keys and behaviour are
  unchanged, so your `settings.json` and any custom keybindings keep working.

## 0.6.0

- **Renamed**: the extension is now simply **abap2UI5** instead of "abap2UI5
  Demokit Helper". It was never tied to the demokit — the name only came from
  the repository it originally lived in. It now has its own repository:
  <https://github.com/abap2UI5-addons/vscode-extension>.
- README reworked: describes the extension as a general tool for abap2UI5
  development, with tables for settings and commands.
- Command IDs unified under the `abap2ui5.` prefix:
  `abap2ui5-demokit.newApp` → `abap2ui5.newApp`,
  `abap2ui5-demokit.openDemokit` → `abap2ui5.openHomepage`. The latter has
  always opened the abap2UI5 repository, and its title now says so.

> **When updating:** the rename changes the extension ID from
> `abap2ui5-local.abap2ui5-demokit` to `abap2ui5-local.abap2ui5`. VS Code
> therefore treats the new `.vsix` as a separate extension — uninstall the old
> one once: `code --uninstall-extension abap2ui5-local.abap2ui5-demokit`.
> Your settings (`abap2ui5.*`) survive, they live in `settings.json` and not on
> the extension ID. The SAP credentials in the SecretStorage do hang off the
> ID, so they are asked for once more on the first F9 after the update.

## 0.5.0

- **Auto-reload on activation:** saving/activating the app class shown in the
  tab reloads the embedded browser automatically — no F9 needed. Can be turned
  off with `abap2ui5.reloadOnSave` (default: on).

## 0.4.2

- Fix: after F9 the cursor really does stay in the source. The loading UI5 app
  pulls focus asynchronously — the extension now catches that for a short time
  window (`onDidChangeViewState`) and hands focus back to the code.

## 0.4.1

- After a launch or reload, F9 returns focus to the source — the cursor stays
  where it was and you can keep typing right away.

## 0.4.0

- **F9 now reliably refreshes** the existing tab/panel (reloading the app)
  instead of opening a new one. For a different class the existing tab switches
  to the new app. The reload runs as a message to the iframe.

## 0.3.1

- Fix: blank/white app in the tab — the proxy now strips `X-Frame-Options` and
  the CSP directive `frame-ancestors` from the SAP responses, so the browser
  allows embedding in the iframe.

## 0.3.0

- **Embedded app with login** through a local auth proxy: F9 shows the app in
  an editor tab (or panel) and the proxy injects the SAP credentials — no more
  401.
- `abap2ui5.openMode` extended: `tab` (the new default), `panel`, `external`
- Credentials are asked for once and kept in the SecretStorage
- New command: "abap2UI5: Clear Stored SAP Credentials"
- The proxy forwards UI5 resources, cookies, CSRF and redirects transparently;
  self-signed HTTPS certificates are accepted

## 0.2.0

- New setting `abap2ui5.openMode` (`external` | `panel`), default `external`
  - `external`: F9 opens the app in the normal browser (uses the SAP
    session/SSO)
  - `panel`: embedded in the panel (only without interactive login, otherwise
    401)
- URL normalization: duplicate slashes in the path are removed

## 0.1.0

- **F9** launches a `z2ui5_if_app` class in the embedded browser panel at the
  bottom
- New setting `abap2ui5.launchUrlTemplate` (placeholder `{class}`)
- Panel view "abap2UI5 / App Preview" with an "Open externally" fallback
- F9 on non-app ABAP files keeps the normal breakpoint behaviour

## 0.0.1

- First version
- Command: "abap2UI5: Insert New App Template"
- Command: "abap2UI5: Open Demokit in Browser" (renamed in 0.6.0)
- Snippets: `z2ui5app`, `z2ui5button`
