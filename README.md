# abap2UI5 for VS Code

VS Code extension for developing **abap2UI5** apps: launch an app with **F9**,
see it right next to the source, and have it reload automatically when you
activate the class — without the context switch to the browser.

Works with any system running abap2UI5 (on-premise or cloud). The only thing
tying the extension to a system is the launch URL you configure once.

## Features

- **F9 runs the app** – With the cursor in an ABAP class that implements
  `z2ui5_if_app`, **F9** opens the app in an embedded browser next to the
  source. If the class is *not* a z2ui5 app, F9 behaves as usual (toggle
  breakpoint), so you don't lose the key.
- **Focus stays in the code** – After launching, the cursor returns to the same
  spot in the source, even when the loading app tries to grab focus.
- **Reload on activation, not on save** – **Ctrl+F3** (`Cmd+F3` on macOS)
  saves the class, activates it through your ABAP tooling and then reloads the
  preview. Activations done any other way are noticed on the server and reload
  the preview too. A plain save leaves the server on the active version, so it
  does not reload — the preview shows a *not activated* badge instead. See
  [Reloading](#reloading-abap2ui5reloadon).
- **Preview toolbar** – Class name, system URL, status dot and buttons for
  reload and "open externally". Themed with your VS Code colour theme.
- **Device widths, theme and language** – Switch the preview between desktop,
  tablet (834px) and phone (414px), and between UI5 themes and logon
  languages, to check a responsive app without leaving the editor.
- **Runtime errors land in the editor** – A thrown error, a failed UI5
  assertion or a rejected promise in the running app is forwarded out of the
  embedded preview: the full text goes to the **abap2UI5** output channel and
  the toolbar counts the errors in a badge — no browser devtools needed. See
  [Runtime errors](#runtime-errors-in-the-preview).
- **Inspect: click the app, land in the code** – The 🎯 toolbar button
  outlines the hovered control; a click jumps to the builder call that wrote
  it. The `{ }` button next to it shows the running app's **JSON model** as
  a document — live values next to the statically known shape. See
  [Inspect and the live model](#inspect-and-the-live-model).
- **Traffic log with roundtrip timings** – Every request of the embedded app
  passes through the auth proxy, so it is logged with method, status, size
  and the full roundtrip duration; the toolbar shows the last backend POST's
  timing as a badge. See [Traffic log](#traffic-log-and-roundtrip-timings).
- **Take App Screenshot** – The running app as a PNG, rendered by the render
  gate's headless Chromium through the same auth proxy — for bug reports and
  docs, without a browser. See [Screenshots](#screenshots).
- **Keep the model across reloads** – The 📌 toolbar toggle captures the
  app's JSON model right before a reload and restores the class's own paths
  into the fresh page — a popup-deep test state survives the activation
  loop. See [Stateful reload](#stateful-reload-the-pin).
- **Control Properties panel** – The control under the cursor as an editable
  form: written attributes with enum dropdowns, every further member the
  UI5 metadata offers, each change an ordinary text edit of the `a( )`
  calls. See [Control properties](#control-properties).
- **Colour swatches** – A colour written into a colour-typed property
  (`sap.ui.core.CSSColor` and friends) gets VS Code's inline swatch and
  picker, in builder chains and raw view XML alike.
- **Convert XML to a builder chain** – Paste a UI5 demo kit sample (or any
  view XML) and get the `z2ui5_cl_ui5_view_builder` chain in the corpus style —
  the reverse of the reconstructed XML view. See
  [XML to builder chain](#xml-to-builder-chain).
- **App navigation map** – Every `z2ui5_if_app` class in the workspace and
  each `nav_app_call( )` between them as a clickable graph. See
  [Navigation map](#app-navigation-map).
- **Status bar** – While an app is running the status bar shows the class and
  the system; clicking it reloads the preview.
- **Several systems** – Name your systems in `abap2ui5.systems` and switch
  with *"abap2UI5: Select System"*. The choice is remembered per window and
  credentials are stored per host. See [Systems](#systems-abap2ui5systems).
- **Login without a 401** – For the embedded view the extension ships a local
  auth proxy (see below).
- **Static view checks** – A class that builds views with `z2ui5_cl_ui5_view_builder`
  (or a raw `*.view.xml`) is validated against the UI5 metadata *while you
  type*: too-new or deprecated controls and properties land in the Problems
  panel before the app ever reaches a system. See
  [Static view checks](#static-view-checks-abap2ui5viewcheck).
- **Quick fixes** – The findings whose correction is mechanical carry it with
  them, and the lightbulb offers it. Plus "suppress on this line", which
  writes the linter directive CI honours too.
- **Completion and hover for the whole UI5 API** – Control names, the members
  of exactly that control, and the values an enum property accepts — from the
  metadata snapshot the extension already ships. Plus the **binding paths the
  class's model actually has**, offered inside `{…}`, and the
  **`client->` API** with signature and documentation on hover. See
  [Completion and hover](#completion-and-hover).
- **Format Document repairs a builder chain** – The indentation follows the
  view hierarchy the chain builds; only builder-verb lines are touched. See
  [Format Document](#format-document).
- **Show Reconstructed XML View** – The XML the builder calls actually
  produce, as a live, syntax-highlighted document next to the class — with
  the findings mirrored in and **Go to Definition** back to the builder
  call. See [Reconstructed XML](#reconstructed-xml).
- **Navigate the view** – The `ele( )`/`tag( )` hierarchy as a tree in the
  Outline pane, and Go to Definition between `_event( 'GO' )` and the
  `WHEN 'GO'` that handles it — in both directions.
- **Run without the class open** – *"Run a Recently Launched App"* lists
  what this window has run; *"Run an App from the System"* searches all
  class names on the system (ADT quick search) while you type.
- **The system configures the check** – After the first launch the extension
  reads the system's `sap-ui-version.json` and offers to align
  `viewCheck.minUi5` / `.distribution` with what the system actually runs.
- **Works in the browser** – vscode.dev, github.dev and browser-based SAP
  Business Application Studio get the language half of the extension. See
  [In the browser](#in-the-browser).
- **The abap2UI5 MCP server for AI agents** – Copilot agent mode (and every
  other MCP client in the window) gets the abap2UI5 dev loop without an SAP
  system. See [MCP server](#mcp-server-abap2ui5mcp).
- **Snippets** for ABAP files: `z2ui5app`, `z2ui5main`, `z2ui5ele`,
  `z2ui5tag`, `z2ui5button`, `z2ui5input`, `z2ui5table`, `z2ui5event`,
  `z2ui5popup`, `z2ui5popover`, `z2ui5toast`, `z2ui5msgbox`, `z2ui5navto`,
  `z2ui5navback`, `z2ui5eventarg`, `z2ui5disable`.
- **New App from Template** – A template gallery instead of one skeleton:
  empty view, list, form, master & detail, popup — pick one, name the
  class, done. Every template ships linter-clean (the test suite enforces
  it).

All commands are available from the Command Palette (`Ctrl/Cmd + Shift + P`).

## Setting the launch URL

On the first F9 the extension asks for the launch URL — the command
*"abap2UI5: Set Launch URL"* asks again at any time. `{class}` is the
placeholder for the class name:

```
https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100
```

The URL is stored and can be changed at any time under
Settings → `abap2ui5.launchUrlTemplate` (or directly in `settings.json`).

## Systems (`abap2ui5.systems`)

One launch URL covers one system, which is rarely how anybody works. Name them
instead:

```jsonc
"abap2ui5.systems": [
  { "name": "DEV",     "url": "https://dev:44300/sap/bc/z2ui5?app_start={class}&sap-client=100" },
  { "name": "Sandbox", "url": "https://box:44300/sap/bc/z2ui5?app_start={class}" }
]
```

*"abap2UI5: Select System"* switches between them — and adds one, so you never
have to find the JSON. The active system is remembered **per window**, so two
windows can work against two systems at once, and it is shown in the status
bar next to the running class.

Credentials follow the system: they are stored per host in the SecretStorage,
so switching back and forth does not ask again. `abap2ui5.launchUrlTemplate`
keeps working as the single-system shorthand and becomes the first entry of
the list as soon as you add a second one.

## Open mode (`abap2ui5.openMode`)

| Mode | Behaviour |
| --- | --- |
| `tab` (default) | App embedded in an editor tab next to the code, through the local auth proxy |
| `panel` | The same, but in the bottom panel area next to Terminal/Output |
| `external` | In the normal browser (reuses your existing SAP session/SSO, no proxy needed) |

The choice does not have to be made in the settings: **abap2UI5: Show the
Preview in the Panel** and **abap2UI5: Show the Preview in an Editor Tab**
switch the mode and take a running app along — it changes place, it does not
restart. The panel's title bar carries the way back, and the panel's empty
state says which mode is in force, so it never asks you to press F9 for an app
that opens somewhere else.

### How the login works in tab/panel mode (auth proxy)

An embedded iframe has **no** SAP session — a direct call would end in a
**401 Not authorized**. That is why in `tab` and `panel` mode the extension
starts a local auth proxy on `127.0.0.1`:

1. On the first launch it asks **once** for your SAP user and password (the
   same ones you use in ADT). They are kept in the VS Code **SecretStorage**.
2. The proxy attaches `Authorization: Basic …` to **every** request and
   forwards it to your system — including UI5 resources, cookies, CSRF tokens
   and redirects. `Origin` and `Referer` are rewritten to the system's own
   origin, so origin-validating CSRF checks accept the app's POSTs.
3. The iframe loads `http://127.0.0.1:<port>/…`, so the app runs embedded
   without a 401.

To make embedding possible at all, the proxy strips `X-Frame-Options` and the
CSP directive `frame-ancestors` from the responses. Self-signed HTTPS
certificates are accepted.

> **Requirement:** the system must accept **basic auth**. Pure SSO/SAML login
> without a basic-auth fallback is not supported — use `external` in that case.
> When the system rejects the logon, the extension says so and offers to
> retype the credentials, instead of leaving an unhelpful page in the iframe.
>
> **Change or delete credentials:** run the command *"abap2UI5: Clear Stored
> SAP Credentials"*. The next F9 asks again.

### Runtime errors in the preview

An embedded iframe swallows what the running app says: a thrown error, a
failed assertion, an unhandled promise rejection are visible only in the
browser devtools — exactly the context switch the preview exists to avoid.
In `tab` and `panel` mode the auth proxy therefore plants a small hook into
the app's HTML that forwards `window.onerror`, unhandled rejections and
`console.error` to the extension:

- the **abap2UI5** output channel (View → Output) carries the full text, and
- the preview toolbar counts the errors in a red badge; clicking it opens
  the output channel. The count resets with every (re)load.

The hook is capped at 50 messages per page load, so a render loop cannot
flood the log. In `external` mode the app runs in a real browser, which has
its own devtools — nothing is forwarded there.

When the error text names a binding path or a quoted identifier that appears
in the running class, the log adds the file and line right under the error —
for local files as a clickable `path:line`.

### Inspect and the live model

Two more toolbar buttons talk to the running app through the same hook:

- **Inspect (🎯)** starts a one-shot pick, like the element picker in
  browser devtools: the hovered control is outlined, a click jumps to the
  `ele( )` / `tag( )` call in the class that wrote it, Esc cancels. The
  clicked control's type and parent chain are matched against the
  reconstructed view — a row inside a bound list lands on its template, two
  same-typed controls are told apart by their surroundings, and an `id`
  written in the class settles the match outright. The class has to be open
  in the window (it is where the jump goes).
- **Model (`{ }`)** asks the app for its JSON model and shows it as a
  read-only document beside the code — the live values next to the shape
  that completion and hover derive statically. Every click refreshes the
  same document, so it can stay open while you work.

Both need the embedded preview (`tab` or `panel` mode) — in `external` mode
the app runs in a real browser, which has its own devtools.

### Traffic log and roundtrip timings

The auth proxy sees every request the embedded app makes, which makes it a
free network tab: the **abap2UI5 Traffic** output channel logs each one with
method, status, the full roundtrip duration (first byte out to last byte in)
and the response size. The POSTs are the app's backend roundtrips — every
abap2UI5 event is one — so the preview toolbar shows the last POST's duration
as a badge, turning warning-coloured from one second up. Clicking the badge
(or *"abap2UI5: Show Traffic Log"*) opens the log. "Is the backend slow or
the UI?" stops being a devtools trip.

### Screenshots

*"abap2UI5: Take App Screenshot"* (also the 📷 toolbar button) renders the
running app headless and opens the PNG beside the code, with **Save As…** one
click away. A webview cannot rasterise its iframe, so the shot is taken the
honest way: the render gate's Chromium loads the same proxied URL the preview
shows — credentials injected, no login page — and `--screenshot` writes the
file. Needs the render gate installed once (*"abap2UI5: Install Render
Gate"*); the command offers it when missing.

### Stateful reload (the pin)

A reload is a fresh start: the model reverts to `main`'s init state, and the
three clicks that reproduced the bug have to be clicked again — on every
activation. With the 📌 toolbar toggle on, the preview captures the app's
JSON model right before a reload and restores it into the fresh page once the
app is up — only the paths the class itself declares (the same derived model
completion and hover use), so the framework's internal state stays with the
fresh load. Best effort by design: server-side state is not carried over, and
switching to another app never restores anything.

### Control properties

The **Control Properties** view (next to the App Preview in the abap2UI5
panel) shows the builder control under the cursor as a form: the attributes
the chain writes — enum properties as dropdowns with the values the UI5
metadata knows, expression values like `client->_bind( … )` read-only — and
an add-row offering every member the control accepts but the chain does not
set. Every change is an ordinary text edit of the `a( )` calls: undo works,
the view check re-checks, nothing but the class holds the truth. Combined
with Inspect, "click the control in the app, adjust its property in the
form" is two clicks.

### XML to builder chain

*"abap2UI5: Convert XML View to Builder Chain"* is the reverse direction of
the reconstructed XML view: UI5 view XML in — the selection, the active
document, or the clipboard — and the `z2ui5_cl_ui5_view_builder` chain comes out as a
new ABAP document, in the corpus style (Format Document is a no-op on the
result). Text content and other things the builder cannot express are listed
as `TODO` comments instead of dropped silently. Porting a demo kit sample
starts with paste instead of transcription.

### App navigation map

*"abap2UI5: Show App Navigation Map"* scans the workspace for classes
implementing `z2ui5_if_app` and draws them as a graph, one arrow per
`client->nav_app_call( )` — apps nothing navigates to on the left, targets
to the right, nav targets whose source is not in the workspace dashed.
Clicking a node opens its class.

## Reloading (`abap2ui5.reloadOn`)

Saving an ABAP class does not change what the server runs — only **activation**
does. That is why the preview reloads on activation and not on every save:

| Value | Behaviour |
| --- | --- |
| `activation` (default) | **Ctrl+F3** saves the class, activates it and reloads the preview; activations done any other way are detected on the server. A plain save only marks the preview *not activated* |
| `save` | Reload on every save of the shown class — for setups in which saving already publishes the change |
| `never` | Only F9, the reload button in the preview or the status bar reload |

**Ctrl+F3** (`Cmd+F3` on macOS, the activation key from SAP GUI) runs
*abap2UI5: Activate and Reload Preview*: it saves the class, hands the
activation to the ABAP extension you already use — the
[ABAP remote filesystem](https://marketplace.visualstudio.com/items?itemName=murbani.vscode-abap-remote-fs)
extension and its `abapfs.activate` — and reloads the preview afterwards. The
same command sits behind the ⚡ button in the editor toolbar.

The key is only taken over for ABAP objects opened from a system (scheme
`adt`). Everywhere else Ctrl+F3 keeps its usual VS Code meaning.

> **Activating any other way works too.** VS Code gives no notification when
> another extension activates an object, so while the preview shows the *not
> activated* badge, the extension watches the class on the server instead (its
> ADT metadata, fetched with the same credentials the preview already uses)
> and reloads as soon as the class is active again — whether you activated
> with Ctrl+F3, the ABAP remote filesystem's own button, or even from Eclipse.
> The watch requires the ADT services (`/sap/bc/adt`) to answer on the
> launch-URL host; where they don't, the badge simply stays until you reload
> (click the badge, the toolbar button, the status bar or F9). The **abap2UI5**
> output channel (View → Output) shows what the watch sees — the place to look
> when the automatic reload does not happen.

> The predecessor `abap2ui5.reloadOnSave` still works while `abap2ui5.reloadOn`
> is unset: `false` behaves like `never`, `true` like `save`.

## Static view checks (`abap2ui5.viewCheck.*`)

abap2UI5 views are built as strings — a typo'd property or a control newer
than your system's UI5 version normally fails at runtime in the browser. The
extension runs the [abap2UI5-linter](https://github.com/abap2UI5/linter)
gates instead, in the editor:

- **SAPUI5 or OpenUI5** (`abap2ui5.viewCheck.distribution`) — SAPUI5 ships
  libraries OpenUI5 does not (`sap.ui.comp`, `sap.suite.*`, `sap.ushell`,
  `sap.fe`, …), so a SmartTable is fine on SAPUI5 and a guaranteed runtime
  error on OpenUI5. Set it to what your system serves; with `openui5` those
  controls become errors.
- **The system can answer both** — after the first F9 against a system the
  extension reads its `sap-ui-version.json` (with the credentials the proxy
  already holds) and, when version or distribution disagree with these
  settings, offers once per system to adopt the answer. The detected version
  stays visible in the status bar (`UI5 1.xxx`); clicking it opens these
  settings.
- **Property gate** — bundled with the extension, zero setup, instant:
  every control and property written in the view is resolved against a UI5
  metadata snapshot. A control that does not exist at all (`sap.m.Shell2` —
  a typo) is an error; anything newer than the configured UI5 floor
  (default **1.71**) or deprecated is a warning.
- **abap2UI5-specific rules** — the defects that stay *silent* at runtime:
  a hand-written binding path the model does not have, `_bind( )` on an
  event or `_event( )` on a property, a value bound to a local variable
  (lost after the roundtrip), an event nothing handles, and the obsolete
  `client->_bind_edit( )`. Plus duplicate `id`s, undeclared namespace
  prefixes and basic accessibility defects.
- **Render gate** (optional, `abap2ui5.viewCheck.render`) — the view is
  loaded with a real `XMLView.create` in headless Chromium, so broken
  expression bindings and property-type violations fail too. Install it
  once with *"abap2UI5: Install Render Gate"*: the command downloads the
  self-contained checker bundle (~30 MB, published by abap2UI5-linter's CI)
  and Chromium into the extension's storage and runs everything with VS
  Code's own runtime — no node, npm or PATH setup on the machine.
  Alternatively point `abap2ui5.mcp.reposRoot` at a folder containing your
  own `linter` checkout (`npm ci` +
  `npx playwright install chromium` done), or set
  `abap2ui5.viewCheck.command`.

Checked are ABAP classes building views with the generic `z2ui5_cl_ui5_view_builder`
builder and raw `*.view.xml` / `*.fragment.xml` files. Documents from the ABAP
remote filesystem (`adt` scheme) and unsaved buffers work too.

**When it runs.** The property gate runs **while you type**, shortly after
each pause (`abap2ui5.viewCheck.live`) — it works in-process and needs no
I/O. The render gate is the expensive one and stays on save
(`abap2ui5.viewCheck.onSave`) and on demand, with *"abap2UI5: Check Views
(Static)"*. *"abap2UI5: Check All Views in the Workspace"* runs the gate over
every ABAP class and view file at once, the way CI does.

### Quick fixes and waivers

Every finding whose correction is mechanical carries the correction with it,
and the lightbulb offers it: the obsolete `client->_bind_edit( )`, a missing
`$` in an event argument, an ABAP boolean written straight into the view. A
rule whose correction would have to guess deliberately carries none. There is
also *"fix all in this file"* — as a command and as
`source.fixAll.abap2ui5`, so it can go into `editor.codeActionsOnSave`:

```jsonc
"editor.codeActionsOnSave": { "source.fixAll.abap2ui5": "explicit" }
```

The other quick fix on any finding is **suppress on this line**, which writes
the linter's own directive above it:

```abap
" abap2ui5lint-disable-next-line unknown-binding-path -- filled in a LOOP
```

The CLI and the GitHub Action honour the same directive, so waiving something
here waives it in CI as well — and a line waived in CI no longer squiggles
here.

When the repo config names a **baseline** (see below), a third quick fix
appears: **add to baseline** appends the finding under the cursor to that
file — the same line-free key the CLI's `--update-baseline` writes — and the
squiggle disappears immediately.

### `abap2ui5lint.jsonc`

A repository can pin its UI5 floor, its distribution, its `allow` list and its
per-rule severities in an
[`abap2ui5lint.jsonc`](https://github.com/abap2UI5/linter). That file is what
the CLI and the GitHub Action check against, so it **wins over the VS Code
settings** wherever it says something; the settings fill in the rest, and the
two `allow` lists merge. The **abap2UI5** output channel names the file the
current values came from — the first place to look when the editor and CI
disagree.

Editing the config file itself is guarded too: the linter's schema ships with
the extension, so an unknown key or a misspelled rule id squiggles right in
`abap2ui5lint.jsonc`, offline. And a repository adopting the linter over
existing findings can name a `baseline` file in the config: the editor then
drops exactly the findings CI drops (the output channel says how many), so
the Problems panel shows only what is *new*.

### Completion and hover

The UI5 metadata snapshot the property gate validates against is a complete
API reference, and it ships with the extension. So it is also offered while
the view is being written:

- **Control names** in the `n` argument of ``ele( )`` / ``tag( )``, resolved
  through the namespace in play — an ``ns`` of ``f`` offers `sap.f`, a name
  written as `core:Icon` offers `sap.ui.core`.
- **Members of exactly that control** in the `n` argument of the ``a( )``
  chained to it — properties first, then aggregations, associations and
  events, own members before inherited ones.
- **The values an enum or boolean property accepts** in the `v` argument.

Hover adds the type, the UI5 version a member appeared in, its deprecation and
a link to the UI5 API reference. Raw `*.view.xml` and `*.fragment.xml` files
get the same, on the tag name, the attribute name and the attribute value.

**Binding paths** complete too: typing `{` in a value offers the paths the
model derived from the class actually has — the same model the
`unknown-binding-path` rule checks against, so what is offered is exactly
what will not squiggle afterwards. Inside an aggregation template the fields
of the bound row come first (`{STATUS}` in a list bound to `{/TRAVELS}`,
through nested aggregations too), absolute paths after. Structures the class
does not declare (DDIC types) are offered as themselves and never guessed
into; named models and expression bindings are left alone.

**The client API completes and explains itself**: `client->` offers every
`z2ui5_if_client` method (triggered by the `>` of the arrow), and hovering a
call shows the full ABAP signature and documentation — parsed from the
interface source and bundled, so `popover_display( xml = … by_id = … )` is
offered correctly instead of corrected afterwards.

No SAP system, no network and no setup is involved — it is the same data the
check already uses.

### Format Document

The builder chain IS the view hierarchy, so its indentation is structure,
not taste. **Format Document** (Shift+Alt+F) repairs it: a child one step
under its parent, an attribute one step under its element, an `end( )` on
the level of the `ele( )` it closes — the canonical corpus style.
Deliberately conservative: only lines beginning with a builder verb inside a
chain are touched; comments, multi-line values and everything outside a
chain keep their bytes.

### Reconstructed XML

abap2UI5 views are strings assembled by builder calls, so what actually
reaches `XMLView.create` is never visible in the source. *"abap2UI5: Show
Reconstructed XML View"* opens exactly that — the reconstruction the view
check validates — as a read-only, syntax-highlighted XML document beside the
class.

The preview **follows the editor**, the way the Markdown preview does:
switch to another view-building class and the XML swaps to that class; edit
the class and the XML re-renders shortly after each pause. A class that
builds no views leaves the last reconstruction standing. A class assembling
more than one view (a popup next to its main view) shows them all, labelled.

The reconstruction remembers which builder call wrote each node and
attribute, and the preview uses that both ways: the view check's findings
are **mirrored onto the XML lines** they concern, and **Go to Definition**
(F12, or Ctrl+click) on any line jumps to the `ele( )` / `tag( )` /
`a( )` in the class that produced it.

### Outline and event navigation

The Outline pane (and the breadcrumb bar) shows the `ele( )`/`tag( )`
hierarchy of a view-building class as a tree — labelled `abap2UI5 view`,
next to whatever outline your ABAP extension contributes — with the `id` a
chain sets shown alongside. Clicking a node jumps to its builder call.

Go to Definition on the event name in `client->_event( 'GO' )` jumps to the
`WHEN 'GO'` branch that handles it; on the `WHEN` literal it goes the other
way, to every place the view raises the event. A CodeLens over each `WHEN`
the view raises says *raised n× in the view* and peeks the calls — and
**F2** renames an event everywhere at once, raises and handler together.

Go to Definition works on binding paths too: `{/MT_TRAVELS/STATUS}` lands on
the `TYPES` field (or the `DATA` line for a root path) that declares it. And
on a plain **method call** it jumps to the `METHOD` implementation in the
class — with the workspace symbol search (`Ctrl+T`) finding method
implementations across every `*.abap` file, capped at 500 files.

### Hover on binding paths

Hovering a `{…}` path says what the derived model resolves it to: a field,
a structure, a table (and that an aggregation binds it), a path under a
structure the class does not declare (accepted unchecked), or **missing** —
the same verdict the `unknown-binding-path` rule reaches, before it has to.
Inside an aggregation template the hover also names the row the relative
path resolves against.

## MCP server (`abap2ui5.mcp.*`)

The extension offers the [abap2UI5 MCP server](https://github.com/abap2UI5/ai-mcp)
to every MCP client in the VS Code window — GitHub Copilot agent mode, Claude
Code, or any other extension speaking MCP (VS Code 1.101+). The server gives
an AI agent the full abap2UI5 development loop **without an SAP system**:

| MCP tool | What the agent gets |
| --- | --- |
| `capabilities` | What abap2UI5 can express — the verified capability map |
| `validate_view` | The static gates above, in seconds |
| `deploy_app` | Write an app class into the local sandbox, abaplint it |
| `build_backend` | Transpile framework + apps to the Node backend |
| `run_app` | Boot the app headless, return errors **and a screenshot** |

The server orchestrates local checkouts of `abap2UI5` and
[`samples-controls`](https://github.com/abap2UI5/samples-controls) (plus
optionally `linter` and `ai-mcp` itself). Clone them into one folder and
point `abap2ui5.mcp.reposRoot` at it — the extension passes the matching
`A2UI5_HOME` / `SAMPLES_CONTROLS_HOME` / `AI_VIEW_CHECK_HOME` variables to
the server and prefers the local `ai-mcp` checkout over downloading via npx.
The server appears in the MCP view (`MCP: List Servers`) as **abap2UI5**;
`abap2ui5.mcp.enabled: false` removes it.

### The system MCP server

ai-mcp is deliberately system-less. The extension additionally offers
**abap2UI5 System** — a second, in-extension MCP server holding what only
the extension has: the configured systems, the stored credentials and the
auth proxy. An agent gets the real-system half of the loop:

| MCP tool | What the agent gets |
| --- | --- |
| `list_systems` | The configured launch systems and which one is active |
| `search_apps` | Class names on the system, via the ADT quick search |
| `run_app` | The app rendered on the system, headless — as a screenshot |

`run_app` loads the class through the auth proxy in the render gate's
Chromium, so it needs the render gate installed once. Every prompt (system
pick, credentials) stays a normal VS Code dialog — the agent never sees a
password. `abap2ui5.mcp.system: false` removes the server.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `abap2ui5.launchUrlTemplate` | – | URL template used to launch an app, `{class}` as the placeholder |
| `abap2ui5.systems` | `[]` | Named launch profiles, for more than one system |
| `abap2ui5.openMode` | `tab` | `tab`, `panel` or `external` |
| `abap2ui5.reloadOn` | `activation` | When the preview reloads on its own: `activation`, `save` or `never` |
| `abap2ui5.codeLens` | `true` | Show Run / Activate & reload / Check views above the class definition |
| `abap2ui5.viewCheck.onSave` | `true` | Run the static view check when a checkable file is saved |
| `abap2ui5.viewCheck.live` | `true` | Also run the property gate while typing |
| `abap2ui5.viewCheck.command` | – | Command running the abap2UI5-linter CLI for the render gate (empty = local checkout or npx) |
| `abap2ui5.viewCheck.minUi5` | `1.71` | The UI5 version your system runs — checked against in both directions |
| `abap2ui5.viewCheck.distribution` | `sapui5` | Which distribution the system serves: `sapui5` or `openui5` |
| `abap2ui5.viewCheck.render` | `false` | Also run the headless render gate |
| `abap2ui5.viewCheck.allow` | `[]` | Accepted deviations, e.g. `sap.m.GenericTile.systemInfo` |
| `abap2ui5.mcp.enabled` | `true` | Offer the abap2UI5 MCP server to MCP clients |
| `abap2ui5.mcp.system` | `true` | Also offer the abap2UI5 System MCP server (real-system tools) |
| `abap2ui5.mcp.command` | – | Command starting the MCP server (empty = local checkout or npx) |
| `abap2ui5.mcp.reposRoot` | – | Folder with the `abap2UI5` / `samples-controls` / `linter` / `ai-mcp` checkouts |

## Commands

| Command | Description |
| --- | --- |
| `abap2UI5: Run App (F9)` | Launches the app of the current class |
| `abap2UI5: Activate and Reload Preview (Ctrl+F3)` | Activates the class through your ABAP tooling, then reloads the preview |
| `abap2UI5: Reload Preview` | Reloads the app currently shown |
| `abap2UI5: Run a Recently Launched App` | Launches an app this window has run before, without opening its class |
| `abap2UI5: Run an App from the System` | Searches class names on the system (ADT quick search) and launches the pick |
| `abap2UI5: Select System` | Switches the system F9 launches against, or adds one |
| `abap2UI5: Show the Preview in the Panel` | Moves the preview (and the running app) into the bottom panel |
| `abap2UI5: Show the Preview in an Editor Tab` | Moves it back into an editor tab |
| `abap2UI5: Go to the Running App` | Focuses the preview, wherever it currently is |
| `abap2UI5: Check Views (Static)` | Runs the static view check on the current file |
| `abap2UI5: Check All Views in the Workspace` | Runs the same check over every ABAP class and view file |
| `abap2UI5: Show Reconstructed XML View` | Opens the XML the builder calls produce, live beside the class |
| `abap2UI5: Fix All View Findings in This File` | Applies every mechanical fix at once |
| `abap2UI5: Install Render Gate` | Downloads the render-gate checker and Chromium into the extension's storage |
| `abap2UI5: Take App Screenshot` | Renders the running app headless and opens the PNG |
| `abap2UI5: Show Traffic Log` | Opens the proxy's request log with roundtrip timings |
| `abap2UI5: Convert XML View to Builder Chain` | Turns view XML (selection, document or clipboard) into a `z2ui5_cl_ui5_view_builder` chain |
| `abap2UI5: Show App Navigation Map` | Draws the workspace's apps and their `nav_app_call( )`s as a clickable graph |
| `abap2UI5: Set Launch URL` | Sets (or changes) the launch URL template |
| `abap2UI5: New App from Template` | Template gallery: pick a skeleton, name the class |
| `abap2UI5: Clear Stored SAP Credentials` | Removes user and password from the SecretStorage |
| `abap2UI5: Open Project on GitHub` | Opens the abap2UI5 repository in the browser |

## In the browser

The extension ships a web bundle, so it also runs in the browser-based
editors — [vscode.dev](https://vscode.dev), github.dev, and SAP Business
Application Studio in the browser. Everything that needs no process and no
socket works there:

- completion and hover for the UI5 API and for binding paths,
- the in-process property gate with its diagnostics, live while typing,
- the reconstructed XML view with findings and Go to Definition,
- the view outline and event navigation,
- colour swatches on colour-typed property values,
- "Convert XML View to Builder Chain",
- snippets and the template gallery ("New App from Template").

Desktop-only (their commands hide from the palette on the web): the embedded
preview with its auth proxy (and its traffic log, screenshot and stateful
reload), Ctrl+F3 activation and the ADT integration, the render gate, the
workspace-wide check, quick fixes, the navigation map, the Control
Properties view, and the MCP servers.
One knowing limit: the web check reads the VS Code settings only — a
repository's `abap2ui5lint.jsonc` is not discovered there.

## Installation

Install **abap2UI5** from the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=abap2ui5.abap2ui5):
Extensions panel (`Ctrl/Cmd + Shift + X`) → search for *abap2UI5* →
**Install**. Updates arrive automatically like for any other extension.
Through the terminal:

```bash
code --install-extension abap2ui5.abap2ui5
```

On [Open VSX](https://open-vsx.org/extension/abap2ui5/abap2ui5) for
VSCodium, Eclipse Theia, SAP Business Application Studio and friends.

**Without Marketplace access:** every
[release](https://github.com/abap2UI5/vscode-extension/releases/latest)
carries the `.vsix` — Extensions panel → `…` menu → **Install from
VSIX…** — or build it yourself, see *Packaging* below.

**Coming from a pre-Marketplace `.vsix` install?** Those builds used the
placeholder publisher `abap2ui5-local`, which makes them a different
extension to VS Code — they keep working but never update. Uninstall once
(Extensions panel → **Uninstall**, or the command below), then install from
the Marketplace. Settings are kept; the stored SAP credentials are asked
for once again.

```bash
code --uninstall-extension abap2ui5-local.abap2ui5
```

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
