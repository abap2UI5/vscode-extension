# Roadmap — task list for coding agents

A work list of improvements to the abap2UI5 VS Code extension, written so that
a coding agent can pick up one task and finish it without further briefing.
Baseline: v0.31.0 plus the `Unreleased` section of `CHANGELOG.md`.

Nothing in here is decided policy. Tasks marked **DECISION** need a maintainer's
answer before any code is written; tasks marked **UPSTREAM** need a change in
another repository first. Statements marked *(verify)* are assumptions that were
not checked against a running system or the other repository — check them
before building on them.

## How to work a task

1. Read `AGENTS.md` first. It overrides anything written here.
2. One task (or one lettered sub-task) per pull request. Do not batch.
3. Put the logic into a `vscode`-free module and keep the VS Code module to
   plumbing — the test suite bundles the `vscode`-free modules for plain Node.
   A new `vscode`-free module is added to the boundary list in `AGENTS.md`.
4. Every new module gets a row in the *Project layout* table of `AGENTS.md`.
5. A new command needs both `registerCommand` and `contributes.commands`;
   then run `npm run commands`. A new setting needs a line in `SETTING_POLICY`
   (`src/test/manifest.test.ts`); then run `npm run settings`.
6. A setting that names a program to start, weakens a security check or lets
   something act as the user is `"scope": "machine"` and listed under
   `capabilities.untrustedWorkspaces.restrictedConfigurations`.
7. User-visible change: add an entry to `CHANGELOG.md`, written for users.
   HEAD collects entries under `## Unreleased`; follow that.
8. English only — code, comments, strings, commits, PR text.
9. Before pushing: `npm run check` (lint, `npm test`, `npm run vsix`). The
   `.vsix` must stay under the 5 MB gate in `ci.yml`.
10. Web build: anything registered in `src/web/extension.ts` must not import
    `fs`, `path`, `child_process` or `net` beyond what `scripts/web-shims/`
    provides. Desktop-only commands carry `"when": "!isWeb"`.
11. Never log or persist credentials outside `context.secrets`. A new local
    listener needs a random token in its path and a loopback `Host` check.
12. The linter owns rules, severities and fixes. Do not re-derive them here.
13. User documentation lives in `abap2UI5/docs` (`advanced/vscode`). Name the
    needed docs change in the PR description; it is a follow-up there.

A task is done when its acceptance criteria hold, `npm run check` is green and
the PR description lists what was verified by hand and what was not.

## Status

What is on this branch, and what a task still lacks. "Unit tests" means
`npm test`; "desktop smoke" means `npm run test:desktop` passed in a real
VS Code; `npm run test:web` passed too (with this environment's Chromium
mapped in). Nothing here was exercised against a real SAP system.

| Task | State | Still open |
| --- | --- | --- |
| T01 | Done | The Testing view itself was never looked at. The runner reports no line, so a failure sits on the test method's declaration; running one method runs its class. |
| T02 | Done | Shift+F12 not tried in an editor. |
| T03 | (a) done, (b) blocked upstream | *Install Report Converter* installs report2UI5 from a pinned commit, each file checked by SHA-256 and each package by its npm integrity. Not run here against codeload itself (403 in this environment) nor the converter afterwards. (b): report2UI5 does not write `#ns#` file names for `/ns/cl_x` (`tools/report2ui5/lib/convert.mjs` 1130-1138). |
| T04 | Done, three of four pictures | Quick fix, Control Properties, device matrix - real captures. The F9 picture needs a system. |
| T05 | Done | Default flipped to `false`. The trust prompt and a real self-signed system are untested. |
| T06 | Done | Four mechanisms: `basic`, `certificate`, `oauth`, `browser`. Certificate proven end to end against a local TLS server, OAuth against a fake UAA, browser logon with a real Chromium against a fake IdP. Unverified against real systems: XSUAA's acceptance of a random loopback redirect, SAML/SPNEGO cookie names, certificate user mapping - see `docs/auth.md`. |
| T07 | Done | Push and Activate (Ctrl+F3 on a class file on disk). The ADT requests follow abap-adt-api; the fixtures are written from it, not recorded from a system. |
| T08 | Done | `auth` is reserved (`"basic"` only). The inline `@since` floor follows profile > setting but not the repository config, as before. |
| T09 | Done | Activation messages on their line in the right abapGit file. Untested against a real activation answer. |
| T10 | Done as option (a) | Three read-only tools, no chat participant. Whether hosts honour `when` on a tool entry is unconfirmed. |
| T11 | Done | The modal was never shown for real. A timed-out modal stays open; a late answer is ignored. |
| T12 | No-go, decided | `docs/systemless-preview.md`: needs node builtins in a worker, and a transpiler in the browser would not fit the `.vsix` gate. T13 covers the systemless preview on the desktop. |
| T13 | Done | "Local (transpiled)" in *Select System*: one real round trip ran here. Drives mcp-server 1.0.0's internals at an exact pin until it ships a `serve` bin. `<class>.mock.json` is not applied (no seam). |
| T14 | Done | Whether a real backend accepts a replayed draft id and its stored session headers is unknown. |
| T15 | Done: floor kept, pinned by a test | `src/test/apifloor.test.ts` classifies every contribution point. Theia (API 1.144) and VSCodium are above the 1.101 floor. BAS's Code-OSS version could not be confirmed from a primary source - check Help > About in a dev space. The newer APIs are already feature-detected. |
| T16 | Done | Scheduling stayed in `viewcheck.ts` (shared state); `SapProxy` stayed whole. |
| T17 | Done | Nothing needed hiding; three manifest tests now pin that. |
| T18 | Done | The CI step has not run on GitHub yet. Follow-up done: no own module below 92 % (total 93.8 %). |

All maintainer decisions below were taken in favour of implementing: the
extension writes source to a system (T07), logon order browser > OAuth >
certificate with all three built (T06), LM tools as a complement to MCP
(T10), the floor stays at 1.101 (T15), T12 is no-go.

**Release blocker found on the way (not caused by this branch):** the bundled
linter 0.9.0 (already on `main`) records release commit `369f4afdd199`, and
`render-gate-bundle-369f4afdd199` does not exist on the linter's releases
(HTTP 404), so *Install Render Gate* fails for a build of this tree. The
linter has to publish that bundle (its `bundle.yml`), or the pin has to move
to a release that has one; the rolling bundle is deliberately no fallback.

Also fixed on the way: *Migrate Classic Report* after abap-cloud-gui's rename
of report2cloud to report2UI5, and removing an attribute of an upper-case
chain in Control Properties.

Follow-up in `abap2UI5/docs` (`advanced/vscode`) for everything marked done
and user-visible: T01, T02, T03a, T05, T06, T07, T08, T09, T10, T11, T13, T14,
and the report2UI5 rename.

## Order and dependencies

| Wave | Tasks | Why this order |
| --- | --- | --- |
| 1 | T02, T04, T17, T18 | Small, independent, no decision needed |
| 2 | T01, T05, T11, T16 | Self-contained; T01 may wait on UPSTREAM |
| 3 | T08, T10, T15, T03 | T08 is the base for T06/T07; T15 and T10 start with a decision |
| 4 | T06, T07, T09, T14 | System connection; T07 needs T08, T09 needs T07 |
| 5 | T13, T12 | Largest; both start with a spike |

```
T08 ──► T06 ──► (embedded preview on SSO systems)
  └───► T07 ──► T09
T05 ──► T08 (the per-system TLS decision moves into the profile)
T13 ──► T12 (the web variant reuses the local backend work)
```

---

## T01 — Unit tests in the Test Explorer

**Size:** M · **Needs:** UPSTREAM *(verify)*

**Why.** *Run Unit Tests (No System)* runs `abap2ui5-unit` in a terminal
(`src/unittests.ts`). The result is text only: no per-method state, no failure
at the line, no re-run of a single test.

**Where.** `src/unitrunner.ts` (`resolveUnitRunner`, `unitTestArgs`,
`testIncludeFor`, `classOfFile`), `src/unittests.ts`, `src/codelens.ts`,
`src/childproc.ts`, `src/abapscan.ts`.

**Steps.**

1. Check whether mcp-server's `scripts/ci-unit.mjs` can print a
   machine-readable result (JSON or JUnit) *(verify)*. If not, this is an
   upstream task in `abap2UI5/mcp-server`: add a reporter flag that prints one
   record per test method — class, method, status, message, source file and
   line. Stop here until it is released.
2. New `vscode`-free `src/unitdiscovery.ts`: from the text of a
   `*.clas.testclasses.abap`, list the test classes (`CLASS … FOR TESTING`)
   and their test methods (`METHODS … FOR TESTING`) with ranges. Run over the
   blanked source from `abapscan.ts`, never over the raw text.
3. New `vscode`-free `src/unitresults.ts`: parse the runner's report into
   `{ testClass, method, status, message?, file?, line? }[]`. A report that
   does not parse is one error result, never an exception.
4. New `src/testexplorer.ts`: `vscode.tests.createTestController`, items per
   include / test class / method, one *Run* profile. Run through
   `childproc.run` (not the terminal) with the arguments `unitTestArgs`
   already builds, plus the reporter flag. Reuse the existing test-include
   FileSystemWatcher; do not add a fifth watcher.
5. Refuse in Restricted Mode exactly as `unittests.ts` does.
6. Keep the terminal command and its CodeLens; the lens may call the
   controller instead.

**Acceptance.**

- A workspace from app-template shows its tests in the Testing view; running
  one method marks only that method.
- A failed assertion appears on its line in the test include.
- Nothing is discovered or spawned at activation; discovery starts when the
  Testing view asks or a test include is opened.
- `unitdiscovery.test.ts` and `unitresults.test.ts` cover: several test
  classes in one include, a keyword inside a comment or a literal, an empty
  report, a truncated report.

**Out of scope.** Tests on a real system (ABAP Unit through ADT). Coverage.
The web build.

---

## T02 — Find All References for events, control ids and bound attributes

**Size:** S

**Why.** F2 rename and Go to Definition already know every place an event, a
control id or a bound attribute is written. Shift+F12 answers nothing.

**Where.** `src/renamewires.ts` (`idAt`, `idSpans`, `attributeAt`,
`attributeSpans`, `RenameKind`), `src/language.ts` (`WireRename`,
`EventDefinition`, the registrations around line 1060).

**Steps.**

1. Find how `WireRename` resolves "what is under the cursor" and which spans
   it edits. If that decision sits in `language.ts`, move it into one
   `vscode`-free function in `renamewires.ts` that both providers call.
2. Add `WireReferences implements vscode.ReferenceProvider` in `language.ts`,
   registered for `ABAP_SELECTOR`. It returns the same spans the rename would
   edit; `context.includeDeclaration` decides whether the declaring span is
   in the list.
3. Scope is exactly the rename's scope. Do not widen it in this task.

**Acceptance.**

- On an event name in `_event( 'SAVE' )`, references list the `WHEN 'SAVE'`
  branch and every other `_event( 'SAVE' )`.
- On a control id and on a bound attribute, the list equals what F2 changes.
- On anything else the provider returns nothing, so another extension's
  provider is not shadowed.
- Works in the web build (`registerLanguageFeatures` is shared).
- Tests pin: references equal rename spans for all three kinds.

---

## T03 — report2cloud without a manual checkout

**Size:** M · **Needs:** UPSTREAM, DECISION

**Why.** *Migrate Classic Report* needs `git clone`, `npm ci` and a setting
before its first run, because report2cloud is not on npm.

**Where.** `src/report2cloud.ts` (`resolveReport2cloud`, `Resolution`,
`ConverterSource`, `targetClassError`, `outputFiles`),
`src/migratereport.ts`, `src/rendergate.ts` as the pattern.

### T03a — Self-installing converter

1. **DECISION / UPSTREAM:** `abap2UI5-addons/abap-cloud-gui` must publish
   the converter as an immutable artefact — an npm package, or a release
   bundle per commit the way the linter publishes the render gate. Without
   one there is nothing safe to download; do not download a branch tip.
2. Record the pinned version (and checksum) in `package.json`, stamped by
   `esbuild.js` the way `linterRelease` is. Add a weekly bump workflow that
   calls the shared `bump-snapshot.yml`.
3. New command *Install Report Converter*: download into global storage,
   verify, unpack — same shape as `installRenderGate`. Reuse the lazily
   loaded `dist/rendergate-tar.js`; do not bundle `tar` a second time.
4. Extend the resolution ladder: setting → environment → repos root →
   installed copy. An explicit answer that does not hold is still reported,
   never skipped.
5. The "not configured" message offers *Install* before *Configure…*.

**Acceptance.** On a machine with no checkout, the command works after one
click. An explicit `report2cloud.path` still wins. Restricted Mode does not
download or run it. The `.vsix` size is unchanged.

### T03b — Namespaced target classes

1. `targetClassError` refuses `/ns/cl_x` today. Accept it and write abapGit's
   `#ns#cl_x.clas.abap` file names in `outputFiles`.
2. Check that report2cloud's CLI accepts the name *(verify)*; if not, this is
   upstream first.

**Acceptance.** `/ns/cl_x` produces `#ns#cl_x.clas.abap` and its sidecars;
the existing tests for plain names are unchanged.

---

## T04 — Screenshots and short clips in the README

**Size:** S

**Why.** The Marketplace page is text only, although the preview, the
inspector and the device matrix are the selling points.

**Steps.**

1. Produce four images: F9 preview beside the source; a view-check squiggle
   with its quick fix; *Preview View (No System)* device matrix; the
   Control Properties view. PNG, light theme, at most 1600 px wide, no real
   host names, users or data.
2. Store them under `media/readme/` and reference them from `README.md` with
   relative paths (vsce rewrites them to absolute URLs from `repository`).
3. Exclude `media/readme/` in `.vscodeignore` — the Marketplace loads the
   images by URL, and the `.vsix` has a 5 MB gate.
4. No SVG in the README: vsce rejects it.
5. Every image gets alt text that says what it shows.

**Acceptance.** `npm run vsix` passes and `npx vsce ls` lists no file under
`media/readme/`. The generated command and settings tables are untouched
(`npm run commands:check`, `npm run settings:check`).

**Note.** The systemless preview picture can be produced without a system;
the F9 picture needs one. Say in the PR which images are real captures.

---

## T05 — Certificate trust per system instead of one global switch

**Size:** M · **Needs:** DECISION on the default

**Why.** `abap2ui5.allowUnauthorizedCerts` defaults to `true` and applies to
every system: the proxy that injects the credentials verifies no certificate
anywhere.

**Where.** `src/proxy.ts` (`SapProxy.allowUnauthorized`, the three
`rejectUnauthorized` sites near lines 1047, 1287 and 1573),
`src/connectcheck.ts` (`describeConnectFailure`), `src/launch.ts`,
`src/systems.ts`.

**Steps.**

1. New `vscode`-free `src/certtrust.ts`: given a peer certificate, answer
   `trusted` / `pinned-match` / `pinned-mismatch` / `unknown`. A pin is the
   SHA-256 fingerprint stored per origin.
2. Store pins in `globalState`, keyed by origin. They are machine-local and
   not secret. A workspace must not be able to add one.
3. On a verification failure with no pin: a modal that shows subject, issuer,
   validity and fingerprint, with *Trust This Certificate* and *Cancel*.
   Nothing is sent before the answer.
4. In the proxy, an origin with a pin connects with verification off **and**
   compares the peer fingerprint on every connection; a mismatch fails the
   request and says the certificate changed.
5. New command *Forget Trusted Certificates*.
6. **DECISION:** flip the default of `allowUnauthorizedCerts` to `false`.
   With pins in place, the setting stays as the blanket override. A user who
   has it explicitly `true` sees no change.
7. *Copy Diagnostics for a Bug Report* says how many origins are pinned and
   prints no host name beyond what it prints today.

**Acceptance.**

- A self-signed system is asked about once, then works without a prompt.
- A changed certificate on a pinned origin is refused with a clear message.
- A public-CA system never prompts.
- `SETTING_POLICY` still classifies every setting; no new workspace-settable
  switch can weaken verification.
- Tests cover all four answers of `certtrust.ts` and the mismatch path.

---

## T06 — Logon beyond basic authentication

**Size:** L · **Needs:** DECISION, T08

**Why.** The auth proxy can only inject basic auth. On a system that offers
SSO only, the user is sent to `openMode: external` and loses everything that
depends on the proxy: inspector, live model, traffic log, screenshots, the
system MCP tools.

**Where.** `src/proxy.ts`, `src/systems.ts` (`ensureCredentials`,
`Credentials`), `src/connectcheck.ts` (lines ~213 and ~258), `src/launch.ts`
(~529–567), `src/agentapps.ts` (`createSystemTransport`).

### T06a — Design note (no code)

Write `docs/auth.md` (new) and get it approved. It answers:

- Which mechanisms are in scope, in which order. Candidates *(verify each)*:
  a browser logon whose session cookie the proxy then replays; the ADT
  reentrance ticket used by cloud systems; OAuth with a service key for
  BTP ABAP Environment; an X.509 client certificate.
- For each: how the secret is obtained, where it is stored
  (`context.secrets` only), how expiry is detected and renewed, what the
  proxy sends per request.
- How the mechanism is chosen: per system profile (T08), never guessed
  silently after a failure.

### T06b — `AuthStrategy` in the proxy (refactor, no behaviour change)

1. Introduce an interface in `proxy.ts`: what to add to an outgoing request,
   and what to do when the system answers 401.
2. Basic auth becomes the first implementation. Every existing proxy test
   stays green unchanged.

### T06c — First additional mechanism

Implement the one T06a ranks first, behind the profile's `auth` field. The
proxy token, the loopback `Host` check and the HttpOnly cookie stay as they
are. The agent app tools and the activation watch go through the same
strategy — no second code path that still assumes basic auth.

### T06d — Messages

`connectcheck.ts` and `launch.ts` stop recommending `openMode: external` for
a system whose profile names a supported mechanism.

**Acceptance.** An SSO-only system runs in the embedded preview with the
inspector working. No credential, cookie or token appears in any log, in the
traffic channel or in *Copy Diagnostics* (`report.ts` redaction covers the new
header names; add tests). Basic-auth systems behave exactly as before.

**Note.** No agent can prove this against a real SSO system. The PR must list
the manual checks a maintainer still has to do.

---

## T07 — Push and activate a class that lives on disk

**Size:** L · **Needs:** T08, DECISION

**Why.** Ctrl+F3 is bound only for `adt:` documents and delegates to another
extension's command (`ABAP_ACTIVATE_COMMANDS` in `src/launch.ts`). A
`.clas.abap` in an abapGit checkout cannot reach the system from here, so the
F9 loop is open for exactly the project layout app-template creates.

**Where.** `src/launch.ts` (`activateAndReload`), `src/proxy.ts`
(`fetchClassState`, `AdtClassState`, `AdtStatusError`), `src/agentapps.ts`
(CSRF and session handling to reuse), `src/activationwatch.ts`.

### T07a — `vscode`-free ADT write client

New `src/adtwrite.ts` over an injected request function (the shape
`agentapps.ts` uses). Sequence *(verify every path and parameter against a
system; these are from memory)*:

1. Fetch a CSRF token; keep the session stateful for the sequence.
2. Read the class: it must exist. Creating a class needs a package and a
   transport decision and is out of scope — answer with a clear refusal.
3. Lock the class (`_action=LOCK`, `accessMode=MODIFY`).
4. PUT each changed source with the lock handle: main source, local
   definitions, local implementations, test classes — from `.clas.abap`,
   `.clas.locals_def.abap`, `.clas.locals_imp.abap`,
   `.clas.testclasses.abap`.
5. Unlock — also after any failure past step 3.
6. Activate; return the activation messages (T09 reads them).

Tests replay recorded request/response fixtures; no network.

### T07b — Command and safety

1. New command *Push and Activate*; Ctrl+F3 calls it for a `file:` document
   that is an app class (`isAppSource`). `adt:` documents keep today's path.
2. Before the first push of a class to a system: a modal naming class and
   system. Remember the answer per class and system for the window.
3. Conflict check: compare the server's `changedAt` with the value seen at the
   last push or F9. If the server is newer, show a diff and ask.
4. When the system asks for a transport request, prompt for it; never invent
   one.
5. Refuse on a system whose profile says `production` (T08).
6. Refuse in Restricted Mode.

**DECISION.** Whether this belongs in the extension at all, or stays with
ABAP tooling such as abapGit. It makes the extension write to a system for
the first time outside the agent app tools.

**Acceptance.** Editing a class on disk, Ctrl+F3 puts it on the system,
activates it and reloads the preview. A lock held by someone else, a syntax
error and a missing class each give one clear message and leave no lock
behind (fixture test for each).

---

## T08 — Richer system profiles

**Size:** M

**Why.** A system is `{ name, url }` (`SystemProfile` in `src/systems.ts`).
The UI5 version, the kind of logon and whether the system is productive are
per-system facts that live in global settings or nowhere.

**Where.** `src/systems.ts` (`SystemProfile`, `profilesFrom`), `package.json`
(`abap2ui5.systems` schema, `additionalProperties: false`),
`src/ui5detect.ts`, `src/lintconfig.ts`, `src/agentapps.ts` (`AgentSystem`).

**Steps.**

1. Add optional fields, all backwards compatible:
   `role` (`"development"` | `"production"`), `minUi5`, `distribution`,
   `auth` (reserved for T06; only `"basic"` accepted until then).
2. `profilesFrom` stays tolerant: a field of the wrong type is ignored, the
   entry survives.
3. While a system is active, its `minUi5` / `distribution` override
   `viewCheck.minUi5` / `viewCheck.distribution` for the check. A workspace
   `abap2ui5lint.jsonc` still wins over both — keep the precedence in
   `configcore.ts` in one place and test it.
4. `ui5detect.ts` offers to write the detected version into the profile
   instead of into the global setting.
5. `role: "production"`: the agent app tools refuse `app_start` and `app_act`
   with a sentence that names the profile field; the status bar item shows
   the role.
6. A field may only **tighten** behaviour when it comes from a workspace.
   `systems` is workspace-settable; nothing in a profile may switch a
   security check off.

**Acceptance.** Existing `systems` values load unchanged. Switching the
active system changes which `@since` warnings appear. The agent tools refuse
a production system without contacting it. `manifest.test.ts` and the
settings table are updated.

---

## T09 — Activation errors in Problems

**Size:** S · **Needs:** T07

**Why.** A failed activation is only visible in the other tool; here the
preview just stays stale.

**Steps.**

1. New `vscode`-free `src/adtmessages.ts`: parse the activation response into
   `{ file-part, line, column, severity, text }[]` *(verify the XML shape
   against a system)*.
2. Map the object part (main, local definitions, local implementations, test
   classes) to the file on disk.
3. Publish into a diagnostic collection of its own; clear it on the next
   successful activation of that class.

**Acceptance.** A syntax error introduced on disk shows as an error on its
line after Ctrl+F3 and disappears after the fixed class activates. A message
without a position lands on line 1 of the main source, never nowhere.

---

## T10 — Language model tools for the editor's chat

**Size:** M · **Needs:** DECISION

**Why.** The extension registers two MCP servers but contributes no
`languageModelTools`. What only the window knows — the active file's
findings, its reconstructed XML — is reachable for an agent only through MCP.

**Where.** `src/mcpsystem.ts` (`list_systems`, `search_apps`,
`run_app_on_system`, `check_view_source`, `get_traffic`), `src/mcprpc.ts`
(`McpTool`), `src/agentapps.ts`, `package.json`.

**DECISION first.** An agent that sees both the MCP server and the LM tools
gets every tool twice. Choose one:

- (a) LM tools only for what MCP does not offer (active-document findings,
  reconstructed XML, the running app's model), or
- (b) one adapter that registers every `McpTool` of the system server as an
  LM tool, plus a setting that picks one surface.

**Steps (for either).**

1. A `vscode`-free adapter from `McpTool` (name, description, input schema,
   handler) to the LM-tool shape, so a tool has one implementation.
2. `contributes.languageModelTools` in `package.json`; a manifest test pins
   that the manifest list and the registered list are equal, as it does for
   commands.
3. Tools that act on the system keep the `agent.enableAppTools` gate and add
   `prepareInvocation` with a confirmation message.
4. Desktop only unless a tool is pure (the view check is; it can be offered
   in the web build).
5. A chat participant (`@abap2ui5`) is a separate, later step — only if the
   tools alone prove insufficient.

**Acceptance.** In agent mode, "check the view of the open class" calls the
tool and returns the same findings the Problems panel shows. With
`mcp.system` off and the LM tools on, nothing is offered twice.

---

## T11 — Confirm each acting step of an agent

**Size:** S

**Why.** `abap2ui5.agent.enableAppTools` is all or nothing. Once on, an agent
may fire any event as the user without another question.

**Where.** `src/agentapps.ts` (`createAgentAppTools`, `AgentAppsDeps`,
`DISABLED_MESSAGE`), `src/mcpsystem.ts`.

**Steps.**

1. New setting `abap2ui5.agent.confirmActions`, default `true`,
   `"scope": "machine"`, restricted — a workspace cannot turn it off.
2. Add a `confirm` dependency to `AgentAppsDeps` (keeps the module
   `vscode`-free). `app_act` with an `event` calls it before anything is
   sent, with: system name, class, event, arguments, pending values.
3. The plumbing shows a modal: *Allow*, *Allow for This Session* (per
   system and class), *Deny*.
4. Deny, or no answer within a timeout, is a refusal in the tool result that
   says the user declined — not an error, and nothing is sent.
5. `app_start` also executes application code. Confirm the first start of a
   class per session the same way.

**Acceptance.** With defaults, no event reaches the system without a click.
*Allow for This Session* stops the prompts for that class only. Tests cover
allow, deny, timeout and the session memory, and pin the setting's scope in
`SETTING_POLICY`.

---

## T12 — Systemless preview in the browser

**Size:** XL · **Needs:** T13, DECISION

**Why.** vscode.dev, github.dev and browser-based BAS get the language half
only; preview, render gate and unit tests are `!isWeb`.

**Start with a spike, not with code.** Write up:

- Can the transpiled abap2UI5 backend run in a web worker? The ecosystem has
  a browser playground *(verify how it runs the backend)*.
- Bundle size and load time, against the 5 MB `.vsix` gate — the runtime
  would have to be fetched on demand, pinned and verified.
- What a webview in a web host may load (CSP, worker sources).

Only after the spike is approved: a `Preview View (No System)` for the web
entry that reuses the T13 preview surface.

**Acceptance for the spike.** A written answer with measured numbers and a
go / no-go recommendation.

---

## T13 — Interactive systemless preview

**Size:** L · **Needs:** UPSTREAM *(verify)*

**Why.** *Preview View (No System)* shows PNGs (`src/viewpreview.ts`, through
the linter's `--screenshot`). Events cannot be fired, so anything behind the
first screen needs a system.

**Idea.** Run the transpiled backend as a local HTTP endpoint and present it
as a built-in system profile, *Local (transpiled)*. F9, the inspector, the
live model and the traffic log then work without new preview code.

**Steps.**

1. Check whether mcp-server can serve the transpiled backend over HTTP for a
   project folder *(verify)*; its sandbox tools already run apps headless. If
   there is no serve entry point, that is the upstream task.
2. New `vscode`-free module that decides how the local backend is started
   (same ladder as `resolveUnitRunner`: checkout under `mcp.reposRoot`, else
   the published package) and how its readiness and port are read.
3. Start it on demand, on loopback, with a token in the path; stop it with
   the session. Not in Restricted Mode — it runs the repository's code.
4. Offer the profile in *Select System*; F9 against it deploys the current
   class into the local backend first.
5. Mock data: seed from `<class>.mock.json` where the app reads nothing but
   its own attributes; say clearly when the app calls something the local
   backend does not have.

**Acceptance.** In a fresh app-template project with no system configured,
F9 shows the starter app, a button press reaches the class's event handler,
and the model view shows the changed attribute.

---

## T14 — Replay a roundtrip

**Size:** M

**Why.** There is no debugger. The traffic log shows that a roundtrip
happened and how long it took, but not what changed.

**Where.** `src/proxy.ts` (`TrafficEntry`), `src/traffic.ts`,
`src/modelview.ts`, `src/previewcore.ts`.

**Steps.**

1. Keep the last N (start with 20) roundtrip request and response bodies in
   memory in the proxy. Size-capped per entry; never written to disk, never
   in *Copy Diagnostics*.
2. New command *Show Roundtrip*: pick one from the list; open the model
   before and after as a diff, and the event with its arguments.
3. New command *Replay Roundtrip*: send the stored request again through the
   proxy and show the new answer beside the old one. A replay re-runs the
   event for real — confirm every time, and refuse on a `production` profile
   (T08).
4. The diff and the "what counts as the model" decision go into a
   `vscode`-free module with tests.

**Acceptance.** After pressing a button in the preview, *Show Roundtrip*
shows exactly the attributes that changed. Bodies are gone after the session
ends. `report.ts` redaction tests prove no body can reach the bug report.

---

## T15 — Compatibility with BAS, Theia and VSCodium

**Size:** S (research) + S (change) · **Needs:** DECISION

**Why.** `engines.vscode` is `^1.101.0`. The extension is published to
Open VSX for hosts that often run an older API level; whether they can
install it at all is unknown.

**Steps.**

1. Research and write down: the API level current SAP Business Application
   Studio and Theia releases offer, and which APIs here actually need 1.101
   (the MCP server definition provider is the likely one).
2. **DECISION:** keep the floor, or lower it and feature-detect.
3. If lowered: guard the newer APIs at runtime, set `@types/vscode` to the
   floor so `tsc` catches anything above it, and say in the README what is
   missing on an older host.
4. Add a manifest test that fails when a `contributes` key above the floor is
   added without a guard.

**Acceptance.** A written compatibility table in the PR. If the floor moves,
`npm run test:web` and `npm run test:desktop` still pass in CI.

---

## T16 — Split the four largest modules

**Size:** M each · one module per PR

**Why.** `src/context.ts` (1944 lines), `src/viewcheck.ts` (1789),
`src/proxy.ts` (1723) and `src/webview.ts` (1516) each mix several concerns.

**Rules.** Pure moves: no behaviour change, no renamed exports without a
re-export, test files change only in their imports. No changelog entry — it
is not user-visible. Update the layout table and the boundary list in
`AGENTS.md` in the same PR.

**Suggested cuts** *(verify against the code before cutting)*:

- `proxy.ts`: ADT lookups (`fetchClassState`, `parseAdtClassRefs`) · HTML
  rewriting (`allowFraming`, `injectRuntimeHook`) · cookie and referer
  rewriting · the listener itself.
- `webview.ts`: preview page · welcome page · shared style and script
  fragments.
- `context.ts`: ABAP chain context · XML tag context.
- `viewcheck.ts`: scheduling · the workspace sweep · the render gate call.

**Acceptance.** `npm run check` is green; the bundle size reported by CI does
not grow by more than 1 %; no test was deleted or weakened.

---

## T17 — Tidy the Command Palette

**Size:** S

**Why.** 48 commands are contributed. Some exist only for a tree node, a
CodeLens or a status bar click and are noise in the palette.

**Steps.**

1. Audit `contributes.menus.commandPalette`: every command that needs an
   argument the palette cannot give (a tree node, a rule id, a finding) is
   hidden there with `"when": "false"`.
2. Check every title reads well after the `abap2UI5:` category and starts
   with a verb.
3. Do not add default key bindings: keys other ABAP extensions own are only
   taken over with a fallback (see `AGENTS.md`).
4. Regenerate the README table (`npm run commands`).

**Acceptance.** Every command still reachable from the palette works with no
argument. `manifest.test.ts` gains a check that a command taking a required
argument is hidden from the palette.

---

## T18 — Measure test coverage in CI

**Size:** S

**Why.** About 70 test files, but no number says which `vscode`-free modules
they leave untouched.

**Steps.**

1. Run the suite with Node's built-in coverage. The tests run from
   `dist-test/`, so the test build needs source maps for the report to name
   `src/` files — add them to the test build in `esbuild.js` only, not to the
   shipped bundles.
2. Print a per-module table into the job summary of `ci.yml`.
3. No threshold yet. List the five least-covered `vscode`-free modules in the
   PR as follow-up tasks.

**Acceptance.** The CI summary shows the table; `npm test` locally is not
slower by more than a few seconds; the `.vsix` contains no source map.

---

## Upstream prerequisites, in one place

| For | Repository | What is needed |
| --- | --- | --- |
| T01 | `abap2UI5/mcp-server` | A machine-readable reporter for `abap2ui5-unit` *(verify it is missing)* |
| T03a | `abap2UI5-addons/abap-cloud-gui` | report2cloud as an immutable, versioned artefact |
| T03b | `abap2UI5-addons/abap-cloud-gui` | CLI accepts a namespaced class name *(verify)* |
| T13 | Done | "Local (transpiled)" in *Select System*: one real round trip ran here. Drives mcp-server 1.0.0's internals at an exact pin until it ships a `serve` bin. `<class>.mock.json` is not applied (no seam). |
| all user-visible | `abap2UI5/docs` | The `advanced/vscode` page follows each feature |

## Decisions a maintainer has to make

| Task | Question |
| --- | --- |
| T03a | npm package or release bundle for report2cloud? |
| T05 | Flip `allowUnauthorizedCerts` to `false` by default? |
| T06 | Done | Four mechanisms: `basic`, `certificate`, `oauth`, `browser`. Certificate proven end to end against a local TLS server, OAuth against a fake UAA, browser logon with a real Chromium against a fake IdP. Unverified against real systems: XSUAA's acceptance of a random loopback redirect, SAML/SPNEGO cookie names, certificate user mapping - see `docs/auth.md`. |
| T07 | Done | Push and Activate (Ctrl+F3 on a class file on disk). The ADT requests follow abap-adt-api; the fixtures are written from it, not recorded from a system. |
| T10 | LM tools as a complement to MCP, or as a second surface for the same tools? |
| T12 | No-go, decided | `docs/systemless-preview.md`: needs node builtins in a worker, and a transpiler in the browser would not fit the `.vsix` gate. T13 covers the systemless preview on the desktop. |
| T15 | Keep the 1.101 floor or lower it? |
