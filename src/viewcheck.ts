import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import { onDidChangeCheckTarget } from "./checktarget";
import * as path from "path";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { clearRenderGateFailure, renderGateState } from "./rendergate";
import { snapshotError, snapshotUi5Version } from "./snapshot";
import { configRelative, GateResult, runGate, VIEW_XML_RE } from "./gate";
import { labelOf } from "./abapsources";
import { FindingSeverity, renderGateNote, settleRenderErrors } from "./checkcore";
import { showProblemsMessage, toDiagnostics } from "./diagnostics";
import { onDidChangeClassIndex, registerClassIndex } from "./classindexfeed";
import { plural } from "./text";
import { recheckSchedule } from "./checkschedule";
import {
  applyBaselineTo,
  CheckOptions,
  clearBaselineCache,
  clearConfigCache,
  describeOptions,
} from "./lintconfig";
import {
  clearCheckable,
  config,
  forgetCheckable,
  gateOptionsFor,
  isCheckable,
  optionsFor,
  pickDocument,
} from "./viewcheckoptions";
import { checkerCommand, runRenderGate, setRenderGateHost } from "./viewcheckrender";
import {
  cachedUnderConfig,
  clearSweepCache,
  dropCachesIfConfigChanged,
  memos,
  sweepCache,
} from "./viewcheckcaches";
import {
  checkWorkspace,
  fixWorkspace,
  isSweeping,
  updateBaseline,
} from "./viewchecksweep";

/* viewcheck.ts stays the module everyone imports from: what moved into the
 * `viewcheck*` modules beside it is re-exported here. */
export {
  baselineFileFor,
  baselineRootFor,
  hasOwnView,
  isCheckable,
  pickDocument,
} from "./viewcheckoptions";
export { checkerCommand, spawnEnv } from "./viewcheckrender";
export type { SweepResult, SweptFile } from "./viewchecksweep";

/*
 * Static view validation through abap2UI5-linter
 * (https://github.com/abap2UI5/linter).
 *
 * The property gate runs INSIDE the extension: the checker library and its
 * UI5 metadata snapshot are bundled, so unknown controls (typos), controls
 * or properties introduced after the configured target UI5 version and
 * deprecations already in effect there show up as diagnostics with zero
 * setup - no node, npx or network involved. Being in-process is also what
 * makes checking while typing affordable.
 *
 * Only the optional render gate (a real XMLView.create in headless
 * Chromium) needs the external linter CLI, because it serves the
 * OpenUI5 runtime from its own node_modules and drives a browser. It never
 * runs on a keystroke - only on save and on demand.
 *
 * This module holds the per-document check (`checkDocument`, its scheduling
 * and `findingsNow`) and the registration. Beside it: `viewcheckoptions.ts`
 * (checkability, config discovery, options), `viewcheckrender.ts` (the render
 * gate call), `viewcheckcaches.ts` (the gate memo and the sweep cache) and
 * `viewchecksweep.ts` (the workspace sweep and its three commands).
 */


/** How long to wait after the last keystroke before checking. Long enough
 *  that typing a control name does not flash three different errors, short
 *  enough to feel immediate. */
const LIVE_DEBOUNCE_MS = 400;

/** The target/metadata versions are logged once per session, and again
 *  whenever they change (a different config file governs the document). */
let lastVersionLine = "";

/** Set by registerViewCheck - lets the quick-fix module ask for a re-check
 *  after it changed something OUTSIDE the document (the baseline file), which
 *  no document version bump would ever notice. */
let recheckAll: () => void = () => {};

export function recheckOpenDocuments(): void {
  memos.clear();
  recheckAll();
}

/** The in-process gate over the document's text, the baseline applied -
 *  the one pipeline behind `findingsNow` and `checkDocument`. Throws what
 *  the gate throws (an unparsable buffer mid-edit). */
function gateDocument(
  doc: vscode.TextDocument,
  options: CheckOptions
): { gate: GateResult; baselined: number } {
  const text = doc.getText();
  const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
  const gate = runGate(
    text,
    doc.uri.fsPath || labelOf(doc.uri),
    isXml,
    gateOptionsFor(doc, options, isXml)
  );
  let baselined = 0;
  if (options.baseline && doc.uri.scheme === "file") {
    // the quick-fix provider must see what the diagnostics show - a fix
    // offered for a finding the baseline already swallowed makes no sense
    baselined = applyBaselineTo(gate.findings, options.baseline, doc.uri.fsPath);
  }
  return { gate, baselined };
}

export function findingsNow(doc: vscode.TextDocument): PropertyFinding[] {
  const key = doc.uri.toString();
  // a change some other check's option lookup noticed - cheap, unlike
  // resolving the options on every code-action request
  dropCachesIfConfigChanged();
  const memo = memos.get(key, doc.version, cachedUnderConfig);
  if (memo) {
    return memo.gate.findings;
  }
  if (!isCheckable(doc)) {
    // Code actions are requested for every ABAP file the cursor moves in;
    // reconstructing a view from one that builds none is pure cost.
    return [];
  }
  const options = optionsFor(doc);
  // the options may have noticed a changed config - under the generation
  // the gate actually runs
  dropCachesIfConfigChanged();
  return memos.once(key, doc.version, cachedUnderConfig, () => gateDocument(doc, options)).gate
    .findings;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

interface CheckRequest {
  /** Allow the external render gate (never on a keystroke). */
  render: boolean;
  /** Say the result out loud - only the on-demand command does. */
  announce: boolean;
}

/** Debounce timers and run generations, both per document. The old global
 *  "one check at a time" flag silently dropped the second of two quick saves;
 *  a generation per URI supersedes only the run it replaces. */
const timers = new Map<string, NodeJS.Timeout>();
const generations = new Map<string, number>();

/** Generations are drawn from one counter for the whole session, so a number
 *  is never handed out twice. That is what makes dropping a closed document's
 *  entry safe: a run still in flight for it compares against a number no
 *  later run can be given, instead of against one a reopened file might
 *  reach again. */
let nextGeneration = 0;

function schedule(
  doc: vscode.TextDocument,
  delay: number,
  request: CheckRequest,
  diagnostics: vscode.DiagnosticCollection,
  log: (m: string) => void
): void {
  const key = doc.uri.toString();
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      checkDocument(doc, diagnostics, log, request).catch((err) =>
        log(`view-check: ${String(err)}`)
      );
    }, delay)
  );
}

function cancelScheduled(uri: vscode.Uri): void {
  const key = uri.toString();
  const timer = timers.get(key);
  if (timer) {
    clearTimeout(timer);
    timers.delete(key);
  }
  // Any run still in flight for this document is now stale.
  generations.set(key, ++nextGeneration);
}

async function checkDocument(
  doc: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  log: (m: string) => void,
  request: CheckRequest
): Promise<void> {
  const key = doc.uri.toString();
  const gen = ++nextGeneration;
  generations.set(key, gen);
  // The buffer counts as much as a newer run does: findings carry offsets into
  // the text they were computed from, and a render takes seconds. Publishing
  // them onto a document that was edited meanwhile puts the squiggles on the
  // wrong lines, where they stay until the next check.
  const startVersion = doc.version;
  const superseded = () =>
    generations.get(key) !== gen || doc.version !== startVersion;

  const options = optionsFor(doc);
  const versionLine = describeOptions(options);
  if (versionLine !== lastVersionLine) {
    lastVersionLine = versionLine;
    log(
      `view-check: ${versionLine}, metadata from ${snapshotUi5Version() ?? "unknown"}`
    );
    const broken = snapshotError();
    if (broken) {
      log(
        `view-check: the bundled UI5 metadata could not be read (${broken}) - ` +
          "the property gate has nothing to check against"
      );
    }
  }
  if (options.error && request.announce) {
    vscode.window.showWarningMessage(
      `abap2UI5: ${path.basename(options.configFile ?? "abap2ui5lint.jsonc")} ` +
        `could not be read (${options.error}) - checking with the VS Code settings instead.`
    );
  }

  // labelOf, not path.basename: an ADT document's last path segment is often
  // the generic "main" or "source", which names nothing in a message
  const name = labelOf(doc.uri);
  // the options just resolved may have noticed a changed config: the memo
  // is read under the generation the gate would run under
  dropCachesIfConfigChanged();
  // The same pipeline `findingsNow` runs, through the same memo: the lens
  // and code-action refetch usually asked for this version before the live
  // check's debounce ended, and the gate then ran twice over the identical
  // text. Whichever asked first seeds it; the other reads it.
  let gated = memos.get(key, startVersion, cachedUnderConfig);
  if (!gated) {
    // An unparsable buffer mid-edit throws out of the gate - on the live path
    // that was one unhandled rejection per keystroke, and in a workspace sweep
    // a single such file ended the whole run.
    try {
      gated = gateDocument(doc, options);
    } catch (err) {
      log(`view-check: ${name} [${doc.uri.scheme}] - could not be checked (${String(err)})`);
      if (request.announce) {
        vscode.window.showWarningMessage(
          `abap2UI5: ${name} could not be checked - ${String(err)}`
        );
      }
      return;
    }
    memos.set(key, startVersion, cachedUnderConfig, gated);
  }
  const { gate, baselined } = gated;

  if (gate.nothingChecked) {
    diagnostics.delete(doc.uri);
    log(
      `view-check: ${name} [${doc.uri.scheme}] - nothing checkable ` +
        `(${gate.nothingChecked})`
    );
    if (request.announce) {
      vscode.window.showInformationMessage(
        `abap2UI5: nothing to check in ${name} - ${gate.nothingChecked}.`
      );
    }
    return;
  }

  let helperNote = gate.helperNote;
  let renderErrors: string[] = [];
  let renderSeverity: FindingSeverity | undefined;
  /** The repo config says `render: false` - the gate was not started. */
  let renderOff = false;
  if (
    request.render &&
    config().get<boolean>("viewCheck.render", false) &&
    gate.renderable
  ) {
    /* One state, one note. The render half can be missing, busy installing,
     * dead on a timeout or unreadable, and every one of those used to end in
     * an empty `renderErrors` array indistinguishable from a clean render -
     * so the on-demand command announced "view check passed" for a check
     * whose second half never ran. */
    const state = renderGateState(checkerCommand().installed);
    if (options.render === false) {
      /* The repo's `abap2ui5lint.jsonc` switches CI's render gate off. The
       * CLI discovers that config from its cwd and skips rendering - so it
       * used to be spawned anyway, over a scratch copy, and came back with an
       * empty report that announced itself as "view check passed". Not
       * started, and the message says which gate did not run. */
      renderOff = true;
      helperNote = renderGateNote("off-by-config");
    } else if (!vscode.workspace.isTrusted) {
      /* Restricted Mode: the render gate is an external process over the
       * repository's code - and its last-resort fallback fetches one - so it
       * waits for the workspace to be trusted. `viewCheck.render` itself is
       * a restricted setting too: a cloned repository cannot switch it on. */
      log("view-check: render gate not run - the workspace is not trusted");
      helperNote = renderGateNote("skipped-untrusted");
    } else if (state.kind === "failed") {
      log(`view-check: render gate not run - ${state.reason}`);
      helperNote = renderGateNote("skipped-not-started");
    } else if (state.kind === "busy") {
      helperNote = renderGateNote("skipped-busy");
    } else {
      const render = await runRenderGate(doc, log, superseded);
      if (superseded()) {
        return; // the document moved on while Chromium was busy
      }
      /* `rules['render-error']` over the REAL file. The CLI applies the entry
       * itself, but it ran on a scratch copy under os.tmpdir(), so an
       * `exclude` written for `src/02/zcl_app.clas.abap` matched the scratch
       * path never - the repository's waiver held in CI and not here. */
      const file = doc.uri.fsPath || name;
      const settledRender = settleRenderErrors(
        render.result?.renderErrors ?? [],
        options.rules,
        [file, configRelative(file, options.configFile)],
        render.outcome === "ok" && !render.result?.skippedRender
      );
      renderErrors = settledRender.renderErrors;
      renderSeverity = settledRender.severity;
      if (settledRender.waived) {
        log(
          `view-check: ${settledRender.waived} render error(s) in ${name} waived by ` +
            "rules['render-error']"
        );
      }
      if (settledRender.staleWaiver) {
        log(
          `view-check: stale render-error waiver for ${name} - the view renders ` +
            "clean, remove it from rules['render-error'].exclude"
        );
      }
      const note = renderGateNote(
        render.result?.skippedRender ? "skipped-helpers" : render.outcome
      );
      if (note) {
        helperNote = note;
      }
    }
  }

  const diags = toDiagnostics(doc, gate.findings, renderErrors, renderSeverity);
  diagnostics.set(doc.uri, diags);
  /* The scheme rides along on purpose. A window can hold a checked-out
   * repository and classes opened straight from a system at the same time,
   * and almost every difference in what the check can do comes down to which
   * of the two a document is - the config it finds, the baseline it can
   * apply, whether a mock file can exist next to it. Reading the log without
   * it meant guessing which kind of document each line was about. */
  log(
    `view-check: ${name} [${doc.uri.scheme}] - ${gate.findings.length} finding(s), ` +
      `${renderErrors.length} render error(s)${helperNote}` +
      (baselined ? ` (${baselined} baselined)` : "") +
      (options.configFile ? ` (config ${path.basename(options.configFile)})` : " (settings)")
  );
  if (request.announce) {
    if (diags.length === 0) {
      vscode.window.showInformationMessage(
        renderOff
          ? // not "passed": the half CI does not run was not run here either
            `abap2UI5: property gate passed for ${name} - render gate off by config ` +
              `(render: false in ${path.basename(options.configFile ?? "abap2ui5lint.jsonc")}).`
          : `abap2UI5: view check passed for ${name}${helperNote}.`
      );
    } else {
      showProblemsMessage(
        `abap2UI5: view check found ${plural(diags.length, "problem")} in ` +
          `${name} - see the Problems panel.`,
        true
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerViewCheck(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  showLog?: () => void
): void {
  setRenderGateHost(context, showLog);
  const diagnostics =
    vscode.languages.createDiagnosticCollection("abap2ui5-view-check");

  const check = (doc: vscode.TextDocument, delay: number, request: CheckRequest) =>
    schedule(doc, delay, request, diagnostics, log);

  /** Re-checks everything currently open - after a setting, a config file or
   *  the linter's own opinion changed.
   *
   *  Every open DOCUMENT, not only the visible editors: a checked file in a
   *  background tab kept the diagnostics it was given under the old config
   *  until it was edited, saved or closed - which is exactly the editor/CI
   *  drift this pipeline exists to prevent, and the gate is in-process and
   *  costs milliseconds per file. The visible ones at once, the rest
   *  staggered (`recheckSchedule`): at activation with many tabs open, every
   *  one of them was gated back to back before the host got a turn. */
  const recheckOpen = () => {
    const visible = new Set(
      vscode.window.visibleTextEditors.map((editor) => editor.document.uri.toString())
    );
    const checkable = vscode.workspace.textDocuments.filter(isCheckable);
    for (const { doc, delay } of recheckSchedule(checkable, (doc) =>
      visible.has(doc.uri.toString())
    )) {
      check(doc, delay, { render: false, announce: false });
    }
  };
  recheckAll = recheckOpen;

  // the other classes are part of every ABAP verdict: when the index's
  // content moves (a superclass saved with a cs_event, a caller reading an
  // attribute), what is open is judged again - memos first, they were
  // computed under the old index
  registerClassIndex(context);
  context.subscriptions.push(
    onDidChangeClassIndex(() => {
      memos.clear();
      recheckOpen();
    })
  );

  // A config file is part of the answer for every file it governs, so a
  // change to one invalidates the cache and re-checks what is open.
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    "**/abap2ui5lint.{json,jsonc}"
  );
  const configChanged = (uri: vscode.Uri) => {
    // same guard as the baseline watcher below: a dependency's config file
    // (an npm install touching node_modules) must not flush every cache and
    // re-check the window
    if (uri.path.includes("/node_modules/")) {
      return;
    }
    clearConfigCache();
    clearSweepCache();
    clearCheckable();
    lastVersionLine = "";
    // the memoised findings behind the lightbulb and the "fix all" lens were
    // computed under the old config - the version they are keyed on does not
    // move when a config file does; the re-check of every open document
    // rides along (recheckOpenDocuments calls recheckOpen)
    recheckOpenDocuments();
  };

  /* The baseline files the configs name are part of the answer too: a pull
   * that updated one left the editor waiving findings CI reports (or the
   * other way round) until the next edit - the mtime memo would have noticed,
   * but nothing asked it to. Custom names without "baseline" in them still
   * escape this net, like the web build's watcher. */
  const baselineWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*baseline*.json"
  );
  const baselineChanged = (uri: vscode.Uri) => {
    if (uri.path.includes("/node_modules/")) {
      return;
    }
    clearBaselineCache();
    recheckOpenDocuments();
  };

  context.subscriptions.push(
    diagnostics,
    configWatcher,
    configWatcher.onDidChange(configChanged),
    configWatcher.onDidCreate(configChanged),
    configWatcher.onDidDelete(configChanged),
    baselineWatcher,
    baselineWatcher.onDidChange(baselineChanged),
    baselineWatcher.onDidCreate(baselineChanged),
    baselineWatcher.onDidDelete(baselineChanged),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },

    vscode.commands.registerCommand("abap2ui5.checkViews", async () => {
      const doc = pickDocument();
      if (!doc || !isCheckable(doc)) {
        log(
          doc
            ? `view-check: ${labelOf(doc.uri)} is not checkable - ` +
                "not an ABAP source calling z2ui5_cl_ui5_view_builder=>factory and " +
                "not a *.view.xml"
            : "view-check: no text editor open"
        );
        vscode.window.showInformationMessage(
          "abap2UI5: open an ABAP class that builds views with " +
            "z2ui5_cl_ui5_view_builder (or a *.view.xml file) to check it."
        );
        return;
      }
      cancelScheduled(doc.uri);
      await checkDocument(doc, diagnostics, log, { render: true, announce: true });
    }),

    vscode.commands.registerCommand("abap2ui5.checkWorkspace", () =>
      checkWorkspace(diagnostics, log)
    ),

    vscode.commands.registerCommand("abap2ui5.fixWorkspace", () => fixWorkspace(log)),

    vscode.commands.registerCommand("abap2ui5.updateBaseline", () =>
      updateBaseline(log, recheckOpenDocuments)
    ),

    // A document that STOPPED being checkable - its builder call deleted -
    // must lose its findings too: no check runs for it any more, so the old
    // squiggles would sit on unrelated text until the file was closed.
    // Saving is the moment the expensive gate is allowed to run.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!config().get<boolean>("viewCheck.onSave", true)) {
        return;
      }
      if (!isCheckable(doc)) {
        if (diagnostics.has(doc.uri)) {
          cancelScheduled(doc.uri);
          diagnostics.delete(doc.uri);
        }
        return;
      }
      check(doc, 0, { render: true, announce: false });
    }),

    // Typing: the property gate only, debounced. It is in-process and needs
    // no I/O, so the cost is a few milliseconds per pause.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!config().get<boolean>("viewCheck.live", true) || !e.contentChanges.length) {
        return;
      }
      if (!isCheckable(e.document)) {
        if (diagnostics.has(e.document.uri)) {
          cancelScheduled(e.document.uri);
          diagnostics.delete(e.document.uri);
        }
        return;
      }
      check(e.document, LIVE_DEBOUNCE_MS, { render: false, announce: false });
    }),

    // Opening a file should show what is wrong with it, without a save first.
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isCheckable(doc) && !isSweeping()) {
        check(doc, 0, { render: false, announce: false });
      }
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      cancelScheduled(doc.uri);
      diagnostics.delete(doc.uri);
      // Nothing compares against this entry any more: cancelScheduled has
      // just made every in-flight run for the document stale, and the
      // generation it was given cannot be handed out again.
      generations.delete(doc.uri.toString());
      memos.delete(doc.uri.toString());
      forgetCheckable(doc.uri);
      /* The sweep's entry for an OPEN document is keyed on `v<version>`, and
       * versions restart at 1 when a document is reopened. Closing without
       * saving and typing back to the same version would otherwise hit a
       * cached entry computed from entirely different text. */
      sweepCache.delete(doc.uri.toString());
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      // mcp.reposRoot too: `checkerCommand` reads it to find a local linter
      // checkout, so it decides whether the render gate can start at all -
      // and pointing it at one was the documented remedy for a checker that
      // could not be started, which then appeared not to work
      if (
        e.affectsConfiguration(`${CONFIG_SECTION}.viewCheck`) ||
        e.affectsConfiguration(`${CONFIG_SECTION}.mcp.reposRoot`)
      ) {
        lastVersionLine = "";
        // the checker that could not be started may be exactly what was just
        // changed - without this the gate stayed off until the window reloaded
        clearRenderGateFailure();
        clearSweepCache();
        clearCheckable();
        // re-checks every open document too - a second recheckOpen() here
        // scheduled each of them twice
        recheckOpenDocuments();
      }
    })
  );

  // The active system is part of the answer too: its profile may name the
  // UI5 version and distribution the check compares against. A switch (or an
  // edit of the `systems` setting) re-checks what is open.
  context.subscriptions.push(
    onDidChangeCheckTarget(() => {
      lastVersionLine = "";
      clearSweepCache();
      recheckOpenDocuments();
    })
  );

  // Whatever is already open when the extension activates.
  recheckOpen();
}
