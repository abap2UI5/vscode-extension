import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { installRenderGate, renderGateBrowsers, renderGateCli } from "./rendergate";
import { VIEW_CHECK_DIRS } from "./repolayout";
import { snapshotError, snapshotUi5Version } from "./snapshot";
import { usesBuilder } from "./abap";
import { runGate, VIEW_XML_RE } from "./gate";
import {
  augmentedPath,
  CheckerCommand,
  isCheckableSource,
  parseRenderReport,
  RenderResult,
  plannedFixes,
  resolveCheckerCommand,
  scratchFileName,
} from "./checkcore";
import { toDiagnostics } from "./diagnostics";
import { rebuildBaseline } from "./baselinefile";
import {
  applyBaselineTo,
  CheckOptions,
  clearConfigCache,
  describeOptions,
  resolveOptions,
} from "./lintconfig";

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
 */

const CONFIG_SECTION = "abap2ui5";

/** How long to wait after the last keystroke before checking. Long enough
 *  that typing a control name does not flash three different errors, short
 *  enough to feel immediate. */
const LIVE_DEBOUNCE_MS = 400;

/** Set when spawning the external render checker failed once - avoids a
 *  warning on every save. */
let spawnFailed = false;

/** The target/metadata versions are logged once per session, and again
 *  whenever they change (a different config file governs the document). */
let lastVersionLine = "";

/** Set by registerViewCheck - checkerCommand needs the extension's global
 *  storage to find a self-installed render gate. */
let extContext: vscode.ExtensionContext | undefined;

function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/** See `isCheckableSource` - this is only the document unwrapping. */
export function isCheckable(doc: vscode.TextDocument): boolean {
  return isCheckableSource(doc.fileName, doc.languageId, doc.getText());
}

/** The document to check on demand: the active editor when it is checkable,
 *  otherwise the first checkable visible editor - the command should work
 *  even when the focus sits in the preview or another non-text tab. */
export function pickDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active && isCheckable(active)) {
    return active;
  }
  for (const editor of vscode.window.visibleTextEditors) {
    if (isCheckable(editor.document)) {
      return editor.document;
    }
  }
  return active;
}

/** The directory the repo config is discovered from: the document's own
 *  folder, so a multi-root workspace resolves per file, exactly like the CLI
 *  invoked in that directory would. */
function discoveryDir(doc: vscode.TextDocument): string | undefined {
  if (doc.uri.scheme === "file") {
    return path.dirname(doc.uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The baseline file governing this document, if its repo config names one -
 *  what the "add to baseline" quick fix appends to. */
export function baselineFileFor(doc: vscode.TextDocument): string | undefined {
  return doc.uri.scheme === "file" ? optionsFor(doc).baseline : undefined;
}

function optionsFor(doc: vscode.TextDocument): CheckOptions {
  const cfg = config();
  return resolveOptions(discoveryDir(doc), {
    minUi5: cfg.get<string>("viewCheck.minUi5", "1.71"),
    distribution: cfg.get<string>("viewCheck.distribution", "sapui5"),
    allow: cfg.get<string[]>("viewCheck.allow", []),
  });
}

// ---------------------------------------------------------------------------
// External render gate (optional)
// ---------------------------------------------------------------------------

/** The render gate's command, resolved from the settings and what is
 *  installed - the decision itself lives in `checkcore.ts`. The systemless
 *  preview spawns the same binary, so this is the one place that knows how to
 *  find it. */
export function checkerCommand(): CheckerCommand {
  const gateCli = extContext ? renderGateCli(extContext) : undefined;
  return resolveCheckerCommand({
    explicit: config().get<string>("viewCheck.command", ""),
    installedGate:
      gateCli && extContext
        ? { cli: gateCli, browsersPath: renderGateBrowsers(extContext) }
        : undefined,
    reposRoot: config().get<string>("mcp.reposRoot", ""),
    checkoutDirs: VIEW_CHECK_DIRS,
    exists: (file) => fs.existsSync(file),
  });
}

/** See `augmentedPath` - the environment to spawn npx with. */
export function spawnEnv(): NodeJS.ProcessEnv {
  const PATH = augmentedPath(process.platform, process.env.PATH);
  return PATH === process.env.PATH ? process.env : { ...process.env, PATH };
}

function runRenderGate(
  doc: vscode.TextDocument,
  log: (m: string) => void
): Promise<RenderResult | undefined> {
  const scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "abap2ui5-viewcheck-")
  );
  const scratch = path.join(scratchDir, scratchFileName(doc.fileName));
  fs.writeFileSync(scratch, doc.getText());

  const checker = checkerCommand();
  const args = [...checker.args, scratch, "--json", "--advisory", "--no-properties"];
  const cwd =
    vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? os.homedir();
  log(`view-check: render gate - ${checker.cmd} ${args.join(" ")}`);

  return new Promise((resolve) => {
    const done = (result: RenderResult | undefined) => {
      fs.rmSync(scratchDir, { recursive: true, force: true });
      resolve(result);
    };
    const child =
      checker.cmd === "node"
        ? // run with the Node.js inside VS Code itself - works without any
          // node installation on the PATH
          spawn(process.execPath, args, {
            cwd,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...checker.env },
          })
        : spawn(checker.cmd, args, {
            cwd,
            env: { ...spawnEnv(), ...checker.env },
            shell: process.platform === "win32",
          });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (err) => {
      log(`view-check: render gate failed to start - ${String(err)}`);
      if (!spawnFailed) {
        spawnFailed = true;
        void vscode.window
          .showWarningMessage(
            "abap2UI5: the render gate is enabled but its checker could not " +
              `be started (${checker.cmd} not found). Install it once - ` +
              "everything runs with VS Code's own runtime. The property " +
              "gate keeps working either way.",
            "Install render gate"
          )
          .then(async (pick) => {
            if (pick === "Install render gate" && extContext) {
              if (await installRenderGate(extContext, log)) {
                spawnFailed = false;
              }
            }
          });
      }
      done(undefined);
    });
    child.on("close", () => {
      const parsed = parseRenderReport(stdout);
      if (!parsed.ok) {
        log(
          parsed.reason === "no-json"
            ? `view-check: render gate produced no JSON` +
                (stderr ? ` - stderr: ${stderr.slice(0, 400)}` : "")
            : `view-check: render gate returned broken JSON - ${parsed.detail}`
        );
        done(undefined);
        return;
      }
      done(parsed.result);
    });
  });
}

/**
 * The findings of a document as it stands right now, memoised on its version.
 *
 * The quick-fix provider needs them, and it must not work off the findings
 * behind the diagnostics currently shown: a fix carries character offsets into
 * the source it was computed from, and between the last check and the moment
 * the lightbulb is opened the buffer may have moved. Recomputing is a few
 * milliseconds - applying a stale offset would corrupt the file.
 */
let memo: { key: string; version: number; findings: PropertyFinding[] } | undefined;

/** Set by registerViewCheck - lets the quick-fix module ask for a re-check
 *  after it changed something OUTSIDE the document (the baseline file), which
 *  no document version bump would ever notice. */
let recheckAll: () => void = () => {};

export function recheckOpenDocuments(): void {
  memo = undefined;
  recheckAll();
}

export function findingsNow(doc: vscode.TextDocument): PropertyFinding[] {
  const key = doc.uri.toString();
  if (memo && memo.key === key && memo.version === doc.version) {
    return memo.findings;
  }
  if (!isCheckable(doc)) {
    // Code actions are requested for every ABAP file the cursor moves in;
    // reconstructing a view from one that builds none is pure cost.
    return [];
  }
  const text = doc.getText();
  const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
  const options = optionsFor(doc);
  const gate = runGate(text, doc.uri.fsPath || doc.fileName, isXml, options);
  if (options.baseline && doc.uri.scheme === "file") {
    // the quick-fix provider must see what the diagnostics show - a fix
    // offered for a finding the baseline already swallowed makes no sense
    applyBaselineTo(gate.findings, options.baseline, doc.uri.fsPath);
  }
  memo = { key, version: doc.version, findings: gate.findings };
  return gate.findings;
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
      void checkDocument(doc, diagnostics, log, request);
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
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

async function checkDocument(
  doc: vscode.TextDocument,
  diagnostics: vscode.DiagnosticCollection,
  log: (m: string) => void,
  request: CheckRequest
): Promise<void> {
  const key = doc.uri.toString();
  const gen = (generations.get(key) ?? 0) + 1;
  generations.set(key, gen);
  const superseded = () => generations.get(key) !== gen;

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

  const text = doc.getText();
  const name = path.basename(doc.fileName);
  const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
  const gate = runGate(text, doc.uri.fsPath || name, isXml, options);
  let baselined = 0;
  if (options.baseline && doc.uri.scheme === "file") {
    baselined = applyBaselineTo(gate.findings, options.baseline, doc.uri.fsPath);
  }

  if (gate.nothingChecked) {
    diagnostics.delete(doc.uri);
    log(`view-check: ${name} - nothing checkable (${gate.nothingChecked})`);
    if (request.announce) {
      vscode.window.showInformationMessage(
        `abap2UI5: nothing to check in ${name} - ${gate.nothingChecked}.`
      );
    }
    return;
  }

  let helperNote = gate.helperNote;
  let renderErrors: string[] = [];
  if (
    request.render &&
    config().get<boolean>("viewCheck.render", false) &&
    gate.renderable &&
    !spawnFailed
  ) {
    const render = await runRenderGate(doc, log);
    if (superseded()) {
      return; // the document moved on while Chromium was busy
    }
    renderErrors = render?.renderErrors ?? [];
    if (render?.skippedRender) {
      helperNote = " (render gate skipped - view built in helper methods)";
    }
  }

  const diags = toDiagnostics(doc, gate.findings, renderErrors);
  diagnostics.set(doc.uri, diags);
  log(
    `view-check: ${name} - ${gate.findings.length} finding(s), ` +
      `${renderErrors.length} render error(s)${helperNote}` +
      (baselined ? ` (${baselined} baselined)` : "")
  );
  if (request.announce) {
    if (diags.length === 0) {
      vscode.window.showInformationMessage(
        `abap2UI5: view check passed for ${name}${helperNote}.`
      );
    } else {
      vscode.window.showWarningMessage(
        `abap2UI5: view check found ${diags.length} problem(s) in ` +
          `${name} - see the Problems panel.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Whole workspace
// ---------------------------------------------------------------------------

/** File patterns the workspace sweep looks at - the same shapes the CLI
 *  collects. */
const WORKSPACE_GLOB = "**/*.{abap,view.xml,fragment.xml}";

/** One checkable file of the workspace, with what the gate says about it. */
export interface SweptFile {
  uri: vscode.Uri;
  findings: PropertyFinding[];
}

/**
 * Every checkable file in the workspace, gated once. Three commands are made
 * of this - check, fix and baseline - and they must agree on what "the
 * workspace says" means, down to which files are looked at and which config
 * governs each one.
 *
 * `baseline` decides whether the repo's baseline is applied: the check and
 * the fix want what the repo still considers a problem, while REBUILDING the
 * baseline needs the unfiltered truth - filtering it first would write a file
 * that waives nothing and calls every waived finding new on the next run.
 */
async function sweepWorkspace(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  options: { baseline: boolean }
): Promise<SweptFile[]> {
  const files = await vscode.workspace.findFiles(
    WORKSPACE_GLOB,
    "**/{node_modules,.git,dist,out}/**"
  );
  const swept: SweptFile[] = [];
  for (const [index, uri] of files.entries()) {
    if (token.isCancellationRequested) {
      break;
    }
    progress.report({
      message: `${index + 1}/${files.length} - ${path.basename(uri.fsPath)}`,
      increment: 100 / files.length,
    });
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      continue;
    }
    const isXml = VIEW_XML_RE.test(uri.fsPath);
    if (!isXml && !usesBuilder(text)) {
      continue;
    }
    const opts = resolveOptions(path.dirname(uri.fsPath), {
      minUi5: config().get<string>("viewCheck.minUi5", "1.71"),
      distribution: config().get<string>("viewCheck.distribution", "sapui5"),
      allow: config().get<string[]>("viewCheck.allow", []),
    });
    const gate = runGate(text, uri.fsPath, isXml, opts);
    if (gate.nothingChecked) {
      continue;
    }
    if (options.baseline && opts.baseline) {
      applyBaselineTo(gate.findings, opts.baseline, uri.fsPath);
    }
    swept.push({ uri, findings: gate.findings });
  }
  return swept;
}

/**
 * Checks every checkable file in the workspace, the way CI does, and fills
 * the Problems panel with the result. The on-save check only ever sees what
 * someone happened to open; this is the answer to "will the linter gate pass
 * before I push?".
 */
async function checkWorkspace(
  diagnostics: vscode.DiagnosticCollection,
  log: (m: string) => void
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "abap2UI5: checking views",
      cancellable: true,
    },
    async (progress, token) => {
      const swept = await sweepWorkspace(progress, token, { baseline: true });
      let problems = 0;
      for (const file of swept) {
        // The file is opened as a text document so the finding ranges are
        // computed against real lines, exactly like the on-save check does.
        const doc = await vscode.workspace.openTextDocument(file.uri);
        const diags = toDiagnostics(doc, file.findings, []);
        diagnostics.set(file.uri, diags);
        problems += diags.length;
      }
      log(`view-check: workspace sweep - ${swept.length} file(s), ${problems} problem(s)`);
      vscode.window.showInformationMessage(
        !swept.length
          ? "abap2UI5: no checkable ABAP or view files found in this workspace."
          : problems
            ? `abap2UI5: ${problems} problem(s) in ${swept.length} file(s) - see the Problems panel.`
            : `abap2UI5: ${swept.length} file(s) checked, nothing found.`
      );
    }
  );
}

/**
 * Every mechanical fix in the workspace, in one edit.
 *
 * The per-file "fix all" is the right size while you are writing one class,
 * and the wrong one for the two cases that actually hurt: adopting the linter
 * on a repository that never ran it, and a rule whose autofix arrived after
 * the code did. Both are workspace-shaped, and doing them file by file means
 * opening every file to find out that most need nothing.
 *
 * It goes through a WorkspaceEdit rather than writing files: one undo step,
 * the editor's own refactor preview, and unsaved buffers are respected
 * instead of overwritten.
 */
async function fixWorkspace(log: (m: string) => void): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "abap2UI5: fixing views",
      cancellable: true,
    },
    async (progress, token) => {
      const swept = await sweepWorkspace(progress, token, { baseline: true });
      const edit = new vscode.WorkspaceEdit();
      let fixes = 0;
      let files = 0;
      for (const file of swept) {
        const planned = plannedFixes(file.findings);
        if (!planned.length) {
          continue;
        }
        const doc = await vscode.workspace.openTextDocument(file.uri);
        edit.set(
          file.uri,
          planned.map(
            (fix) =>
              new vscode.TextEdit(
                new vscode.Range(doc.positionAt(fix.start), doc.positionAt(fix.end)),
                fix.text
              )
          )
        );
        fixes += planned.length;
        files++;
      }
      if (!fixes) {
        vscode.window.showInformationMessage(
          `abap2UI5: nothing in ${swept.length} file(s) can be corrected mechanically.`
        );
        return;
      }
      await vscode.workspace.applyEdit(edit);
      log(`view-check: workspace fix - ${fixes} fix(es) in ${files} file(s)`);
      /* Overlapping fixes are left for the next run, here as everywhere -
       * so the count is what was applied, not what remains, and saying so is
       * what tells someone to run it again. */
      vscode.window.showInformationMessage(
        `abap2UI5: applied ${fixes} fix(es) in ${files} file(s). ` +
          "Run it again if fixes overlapped; the files are edited, not saved."
      );
    }
  );
}

/**
 * Rebuild the repo's baseline from what the workspace reports now - the
 * editor's `--update-baseline`.
 *
 * Adopting the linter on a repository with history is the case this exists
 * for: the lightbulb can waive findings one at a time, which is right when
 * three are left and hopeless when four hundred are. The baseline file the
 * CLI honours is the supported way to say "everything as of today is known",
 * and until now writing it meant leaving the editor for the command line.
 */
async function updateBaseline(log: (m: string) => void): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showInformationMessage(
      "abap2UI5: no folder is open - a baseline belongs to a repository."
    );
    return;
  }
  const baselineFile = resolveOptions(folder.uri.fsPath, {
    minUi5: config().get<string>("viewCheck.minUi5", "1.71"),
    distribution: config().get<string>("viewCheck.distribution", "sapui5"),
    allow: config().get<string[]>("viewCheck.allow", []),
  }).baseline;
  if (!baselineFile) {
    vscode.window.showWarningMessage(
      'abap2UI5: this repository names no baseline. Add "baseline": ' +
        '"abap2ui5lint-baseline.json" to abap2ui5lint.jsonc first - the file ' +
        "is only honoured by the CLI when the config points at it."
    );
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `abap2UI5: rewrite ${path.basename(baselineFile)} from what the workspace ` +
      "reports right now? Every finding that exists today becomes waived; " +
      "the previous content is replaced.",
    { modal: true },
    "Rebuild baseline"
  );
  if (confirmed !== "Rebuild baseline") {
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "abap2UI5: rebuilding the baseline",
      cancellable: true,
    },
    async (progress, token) => {
      // unfiltered on purpose: the baseline is what is being written, so it
      // must not be applied to the findings that write it
      const swept = await sweepWorkspace(progress, token, { baseline: false });
      if (token.isCancellationRequested) {
        vscode.window.showInformationMessage(
          "abap2UI5: cancelled - the baseline is unchanged."
        );
        return;
      }
      try {
        const written = rebuildBaseline(
          baselineFile,
          swept.map((file) => ({ file: file.uri.fsPath, findings: file.findings }))
        );
        recheckOpenDocuments();
        log(
          `view-check: baseline rebuilt - ${written.findings} finding(s) in ` +
            `${written.entries} entries -> ${baselineFile}`
        );
        vscode.window.showInformationMessage(
          `abap2UI5: ${path.basename(baselineFile)} now waives ` +
            `${written.findings} finding(s) from ${swept.length} file(s).`
        );
      } catch (err) {
        vscode.window.showWarningMessage(
          `abap2UI5: could not write ${baselineFile} - ${String(err)}`
        );
      }
    }
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerViewCheck(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  extContext = context;
  const diagnostics =
    vscode.languages.createDiagnosticCollection("abap2ui5-view-check");

  const check = (doc: vscode.TextDocument, delay: number, request: CheckRequest) =>
    schedule(doc, delay, request, diagnostics, log);

  /** Re-checks everything currently open - after a setting, a config file or
   *  the linter's own opinion changed. */
  const recheckOpen = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      if (isCheckable(editor.document)) {
        check(editor.document, 0, { render: false, announce: false });
      }
    }
  };
  recheckAll = recheckOpen;

  // A config file is part of the answer for every file it governs, so a
  // change to one invalidates the cache and re-checks what is open.
  const configWatcher = vscode.workspace.createFileSystemWatcher(
    "**/abap2ui5lint.{json,jsonc}"
  );
  const configChanged = () => {
    clearConfigCache();
    lastVersionLine = "";
    recheckOpen();
  };

  context.subscriptions.push(
    diagnostics,
    configWatcher,
    configWatcher.onDidChange(configChanged),
    configWatcher.onDidCreate(configChanged),
    configWatcher.onDidDelete(configChanged),
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },

    vscode.commands.registerCommand("abap2ui5.checkViews", async () => {
      const doc = pickDocument();
      if (!doc || !isCheckable(doc)) {
        log(
          doc
            ? `view-check: ${path.basename(doc.fileName)} is not checkable - ` +
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

    vscode.commands.registerCommand("abap2ui5.updateBaseline", () => updateBaseline(log)),

    // Saving is the moment the expensive gate is allowed to run.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!config().get<boolean>("viewCheck.onSave", true) || !isCheckable(doc)) {
        return;
      }
      check(doc, 0, { render: true, announce: false });
    }),

    // Typing: the property gate only, debounced. It is in-process and needs
    // no I/O, so the cost is a few milliseconds per pause.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!config().get<boolean>("viewCheck.live", true)) {
        return;
      }
      if (!e.contentChanges.length || !isCheckable(e.document)) {
        return;
      }
      check(e.document, LIVE_DEBOUNCE_MS, { render: false, announce: false });
    }),

    // Opening a file should show what is wrong with it, without a save first.
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isCheckable(doc)) {
        check(doc, 0, { render: false, announce: false });
      }
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      cancelScheduled(doc.uri);
      diagnostics.delete(doc.uri);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.viewCheck`)) {
        lastVersionLine = "";
        recheckOpen();
      }
    })
  );

  // Whatever is already open when the extension activates.
  recheckOpen();
}
