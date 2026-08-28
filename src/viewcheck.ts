import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { run } from "./childproc";
import { installRenderGate, renderGateBrowsers, renderGateCli } from "./rendergate";
import { VIEW_CHECK_DIRS } from "./repolayout";
import { snapshotError, snapshotUi5Version } from "./snapshot";
import { usesBuilder } from "./abap";
import { GateResult, runGate, VIEW_XML_RE } from "./gate";
import { labelOf, noWorkspaceFolders } from "./abapsources";
import {
  augmentedPath,
  CheckerCommand,
  isCheckableSource,
  parseRenderReport,
  checkerCwd,
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
  clearBaselineCache,
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


/** How long to wait after the last keystroke before checking. Long enough
 *  that typing a control name does not flash three different errors, short
 *  enough to feel immediate. */
const LIVE_DEBOUNCE_MS = 400;

/** Set when spawning the external render checker failed once - avoids a
 *  warning on every save. */
let spawnFailed = false;

/** True while a workspace sweep runs. The sweep opens every file it reports
 *  on (finding ranges are computed against real lines), and each open fires
 *  onDidOpenTextDocument - which scheduled a second full check of the same
 *  file, doubling the sweep's work and racing its own diagnostics.set. */
let sweeping = false;

/** The target/metadata versions are logged once per session, and again
 *  whenever they change (a different config file governs the document). */
let lastVersionLine = "";

/** Set by registerViewCheck - checkerCommand needs the extension's global
 *  storage to find a self-installed render gate. */
let extContext: vscode.ExtensionContext | undefined;

function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/**
 * The `viewCheck.rules` setting, in the shape `abap2ui5lint.jsonc` uses for
 * the same thing: rule id -> `false`, a severity, or `{ severity, exclude }`.
 *
 * Read fresh each time rather than cached - the check already runs per
 * keystroke, an object of a handful of entries costs nothing to fetch, and a
 * cache would be one more thing to invalidate when the setting changes.
 */
function ruleSettings(): Record<string, unknown> | undefined {
  const rules = config().get<Record<string, unknown>>("viewCheck.rules");
  return rules && Object.keys(rules).length > 0 ? rules : undefined;
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
  return discoveryDirOf(doc.uri);
}

/** Same question for a uri: its own folder when it is a file, otherwise the
 *  workspace's - a class opened through ADT is governed by the config of the
 *  repository you have open, or by the settings when there is none. */
function discoveryDirOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme === "file") {
    return path.dirname(uri.fsPath);
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
    rules: ruleSettings(),
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

/**
 * How long the render gate may take before it is killed. Launching Chromium
 * and rendering a view is seconds; the npx fallback resolving a GitHub
 * dependency on a slow line is tens of them. Beyond this something is stuck -
 * and without a limit every save added another stuck child that nothing ever
 * reaped, with `checkDocument` waiting on the first one forever.
 */
const RENDER_TIMEOUT_MS = 180_000;

async function runRenderGate(
  doc: vscode.TextDocument,
  log: (m: string) => void,
  superseded: () => boolean
): Promise<RenderResult | undefined> {
  const scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "abap2ui5-viewcheck-")
  );
  const scratch = path.join(scratchDir, scratchFileName(doc.fileName));
  fs.writeFileSync(scratch, doc.getText());

  const checker = checkerCommand();
  const useShell = checker.cmd !== "node" && process.platform === "win32";
  const args = [...checker.args, scratch, "--json", "--advisory", "--no-properties"];
  const cwd = checkerCwd(
    vscode.workspace.getWorkspaceFolder(doc.uri)?.uri,
    os.homedir(),
    (dir) => fs.existsSync(dir)
  );
  log(`view-check: render gate - ${checker.cmd} ${args.join(" ")}`);

  try {
    // `run` quotes the PROGRAM as well as its arguments under a shell, which
    // this call site did not: an explicit `viewCheck.command` naming
    // `C:\Program Files\nodejs\node.exe` was split at the space by cmd.exe
    // and reported as "not recognized", with an offer to install a gate that
    // could not have fixed it.
    const outcome = await run(
      checker.cmd === "node" ? process.execPath : checker.cmd,
      args,
      checker.cmd === "node"
        ? {
            // run with the Node.js inside VS Code itself - works without any
            // node installation on the PATH
            cwd,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...checker.env },
            timeoutMs: RENDER_TIMEOUT_MS,
            abandoned: superseded,
          }
        : {
            cwd,
            env: { ...spawnEnv(), ...checker.env },
            shell: useShell,
            timeoutMs: RENDER_TIMEOUT_MS,
            abandoned: superseded,
          }
    );

    if (outcome.kind === "abandoned") {
      // the buffer moved on, or the document was closed - nothing will be
      // done with this answer, so it was not paid for to the end
      log("view-check: render gate no longer needed - killed");
      return undefined;
    }
    if (outcome.kind === "timeout") {
      log(
        `view-check: render gate exceeded ${RENDER_TIMEOUT_MS} ms - killed, ` +
          "the property gate's findings still stand"
      );
      return undefined;
    }
    if (outcome.kind === "spawn-failed") {
      log(`view-check: render gate failed to start - ${String(outcome.error)}`);
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
      return undefined;
    }

    const parsed = parseRenderReport(outcome.stdout);
    if (!parsed.ok) {
      log(
        parsed.reason === "no-json"
          ? `view-check: render gate produced no JSON` +
              (outcome.stderr ? ` - stderr: ${outcome.stderr.slice(0, 400)}` : "")
          : `view-check: render gate returned broken JSON - ${parsed.detail}`
      );
      return undefined;
    }
    return parsed.result;
  } finally {
    /* On every path, including a throw: the scratch directory is this run's
     * alone. It used to be removed inside a timer callback, where a Windows
     * EBUSY (the killed child had not let go yet) threw with nothing to catch
     * it - the promise then never settled and its caller waited forever. */
    try {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    } catch (err) {
      log(`view-check: scratch directory left behind - ${String(err)}`);
    }
  }
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

  const text = doc.getText();
  const name = path.basename(doc.fileName);
  const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
  // An unparsable buffer mid-edit throws out of the gate - on the live path
  // that was one unhandled rejection per keystroke, and in a workspace sweep
  // a single such file ended the whole run.
  let gate: GateResult;
  try {
    gate = runGate(text, doc.uri.fsPath || name, isXml, options);
  } catch (err) {
    log(`view-check: ${name} [${doc.uri.scheme}] - could not be checked (${String(err)})`);
    if (request.announce) {
      vscode.window.showWarningMessage(
        `abap2UI5: ${name} could not be checked - ${String(err)}`
      );
    }
    return;
  }
  let baselined = 0;
  if (options.baseline && doc.uri.scheme === "file") {
    baselined = applyBaselineTo(gate.findings, options.baseline, doc.uri.fsPath);
  }

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
  if (
    request.render &&
    config().get<boolean>("viewCheck.render", false) &&
    gate.renderable &&
    !spawnFailed
  ) {
    const render = await runRenderGate(doc, log, superseded);
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
/** What a sweep found, and whether it got to the end. A cancelled sweep has
 *  looked at part of the workspace, which is not the same answer - reporting
 *  "nothing found" for it, or applying its fixes as if they were the
 *  workspace's, says more than was actually checked. */
export interface SweepResult {
  files: SweptFile[];
  cancelled: boolean;
}

export interface SweptFile {
  uri: vscode.Uri;
  findings: PropertyFinding[];
  /** The version of the open document the findings were gated against, if it
   *  was open. `fixWorkspace` refuses to apply offsets to a buffer that has
   *  been typed in since - the sweep is `await`ed per file, so the window is
   *  real. Absent when the text came from disk. */
  version?: number;
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
  options: { baseline: boolean },
  log: (m: string) => void
): Promise<SweepResult> {
  /*
   * The workspace's files, plus the checkable documents this window has open
   * that are not among them. Without the second half a sweep run against a
   * system through ADT reported "no checkable files found" while the classes
   * were sitting open in the editor - and the on-save check had been
   * checking them all along.
   */
  const found = await vscode.workspace.findFiles(
    WORKSPACE_GLOB,
    "**/{node_modules,.git,dist,out}/**"
  );
  /*
   * An open document WINS over the file of the same name, always - it is what
   * the user is looking at, and `fixWorkspace` turns these findings into
   * offsets that are then applied to exactly that document.
   *
   * Reading the file instead was a silent corruption: a class that is open
   * with unsaved changes AND on disk was gated against the disk text, and the
   * resulting character offsets were mapped through the dirty buffer. Every
   * fix after the first divergence landed a few characters off - mid-token,
   * in one WorkspaceEdit. The same mismatch put the workspace check's
   * squiggles on the wrong lines.
   */
  const open = new Map<string, vscode.TextDocument>();
  for (const doc of vscode.workspace.textDocuments) {
    open.set(doc.uri.toString(), doc);
  }
  const targets: Array<{ uri: vscode.Uri; open?: vscode.TextDocument }> = found.map(
    (uri) => ({ uri, open: open.get(uri.toString()) })
  );
  const known = new Set(found.map((uri) => uri.toString()));
  for (const doc of vscode.workspace.textDocuments) {
    if (!known.has(doc.uri.toString()) && isCheckable(doc)) {
      targets.push({ uri: doc.uri, open: doc });
    }
  }

  const swept: SweptFile[] = [];
  for (const [index, target] of targets.entries()) {
    if (token.isCancellationRequested) {
      break;
    }
    const uri = target.uri;
    progress.report({
      message: `${index + 1}/${targets.length} - ${labelOf(uri)}`,
      increment: 100 / targets.length,
    });
    let text: string;
    if (target.open) {
      text = target.open.getText();
    } else {
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        continue;
      }
    }
    const isXml = VIEW_XML_RE.test(uri.path);
    if (!isXml && !usesBuilder(text)) {
      continue;
    }
    // a document with no path on disk has no directory to discover a config
    // from - the workspace's own config governs it, as it does on the live path
    const opts = resolveOptions(discoveryDirOf(uri), {
      minUi5: config().get<string>("viewCheck.minUi5", "1.71"),
      distribution: config().get<string>("viewCheck.distribution", "sapui5"),
      allow: config().get<string[]>("viewCheck.allow", []),
    rules: ruleSettings(),
    });
    let gate: GateResult;
    try {
      gate = runGate(text, uri.scheme === "file" ? uri.fsPath : uri.path, isXml, opts);
    } catch (err) {
      // one file that cannot be parsed is not a reason to abandon the sweep
      log(`view-check: ${labelOf(uri)} skipped - ${String(err)}`);
      continue;
    }
    if (gate.nothingChecked) {
      continue;
    }
    if (options.baseline && opts.baseline && uri.scheme === "file") {
      applyBaselineTo(gate.findings, opts.baseline, uri.fsPath);
    }
    swept.push({ uri, findings: gate.findings, version: target.open?.version });
  }
  return { files: swept, cancelled: token.isCancellationRequested };
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
      sweeping = true;
      let swept: SweepResult;
      try {
        swept = await sweepWorkspace(progress, token, { baseline: true }, log);
        // What the sweep did not find is no longer a problem: a file that was
        // fixed, reverted or deleted since the last run kept its diagnostics
        // forever, because only the files it DID report were written.
        if (!swept.cancelled) {
          diagnostics.clear();
        }
        let problems = 0;
        for (const file of swept.files) {
          // The file is opened as a text document so the finding ranges are
          // computed against real lines, exactly like the on-save check does.
          const doc = await vscode.workspace.openTextDocument(file.uri);
          const diags = toDiagnostics(doc, file.findings, []);
          diagnostics.set(file.uri, diags);
          problems += diags.length;
        }
        log(
          `view-check: workspace sweep - ${swept.files.length} file(s), ` +
            `${problems} problem(s)${swept.cancelled ? " (cancelled)" : ""}`
        );
        vscode.window.showInformationMessage(
          swept.cancelled
            ? `abap2UI5: cancelled after ${swept.files.length} file(s) - ` +
                `${problems} problem(s) so far.`
            : !swept.files.length
              ? noWorkspaceFolders()
                ? "abap2UI5: nothing checkable is open. Without a folder in " +
                  "the workspace there is nothing to search, so the check " +
                  "covers the classes you have open - open one and run it again."
                : "abap2UI5: no checkable ABAP or view files found in this workspace."
              : problems
                ? `abap2UI5: ${problems} problem(s) in ${swept.files.length} file(s) - see the Problems panel.`
                : `abap2UI5: ${swept.files.length} file(s) checked, nothing found.`
        );
      } finally {
        sweeping = false;
      }
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
      sweeping = true;
      let swept: SweepResult;
      try {
        swept = await sweepWorkspace(progress, token, { baseline: true }, log);
      } finally {
        sweeping = false;
      }
      if (swept.cancelled) {
        // half a workspace's fixes applied as if they were the workspace's
        vscode.window.showInformationMessage(
          "abap2UI5: cancelled - nothing was changed."
        );
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      let fixes = 0;
      let files = 0;
      let moved = 0;
      for (const file of swept.files) {
        const planned = plannedFixes(file.findings);
        if (!planned.length) {
          continue;
        }
        const doc = await vscode.workspace.openTextDocument(file.uri);
        /* A fix is a pair of character offsets into the text that was gated.
         * If that text has changed since - the sweep awaits each file, and a
         * fast typist is faster than a workspace scan - the offsets address
         * different characters now, and applying them rewrites the wrong
         * span. Skipping is the only safe answer; the next run picks it up. */
        if (file.version !== undefined && doc.version !== file.version) {
          moved++;
          continue;
        }
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
      if (moved) {
        log(
          `view-check: workspace fix - ${moved} file(s) skipped, edited while the sweep ran`
        );
      }
      const skipped = moved
        ? ` ${moved} file(s) were edited while the sweep ran and were left alone.`
        : "";
      if (!fixes) {
        vscode.window.showInformationMessage(
          `abap2UI5: nothing in ${swept.files.length} file(s) can be corrected mechanically.` +
            skipped
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
          "Run it again if fixes overlapped; the files are edited, not saved." +
          skipped
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
    rules: ruleSettings(),
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
      sweeping = true;
      let swept: SweepResult;
      try {
        swept = await sweepWorkspace(progress, token, { baseline: false }, log);
      } finally {
        sweeping = false;
      }
      if (swept.cancelled) {
        vscode.window.showInformationMessage(
          "abap2UI5: cancelled - the baseline is unchanged."
        );
        return;
      }
      /*
       * Only real files under the baseline's own repository go in.
       *
       * The sweep deliberately also gates documents that have no file behind
       * them (a class opened through ADT) and, in a multi-root window, files
       * of the other folders. Neither can ever produce a matching entry when
       * the CLI runs over this repository - and a baseline entry that matches
       * nothing is not inert: it is STALE, which the linter reports and CI
       * fails on. So writing them would hand somebody a baseline that breaks
       * the build it was written to unblock.
       */
      const root = path.dirname(baselineFile);
      const inRepo = (uri: vscode.Uri): boolean => {
        if (uri.scheme !== "file") {
          return false;
        }
        const rel = path.relative(root, uri.fsPath);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      const mine = swept.files.filter((file) => inRepo(file.uri));
      const foreign = swept.files.length - mine.length;
      if (foreign) {
        log(
          `view-check: baseline - ${foreign} file(s) outside ${root} ` +
            "(or with no file on disk) were not written into it"
        );
      }
      try {
        const written = rebuildBaseline(
          baselineFile,
          mine.map((file) => ({
            file: file.uri.fsPath,
            findings: file.findings,
          }))
        );
        // the file just changed; its memo is keyed on an mtime that may not
        // have moved yet
        clearBaselineCache(baselineFile);
        recheckOpenDocuments();
        log(
          `view-check: baseline rebuilt - ${written.findings} finding(s) in ` +
            `${written.entries} entries -> ${baselineFile}`
        );
        vscode.window.showInformationMessage(
          `abap2UI5: ${path.basename(baselineFile)} now waives ` +
            `${written.findings} finding(s) from ${mine.length} file(s).` +
            (foreign
              ? ` ${foreign} file(s) outside the repository were not included.`
              : "")
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
    // the memoised findings behind the lightbulb and the "fix all" lens were
    // computed under the old config - the version they are keyed on does not
    // move when a config file does
    recheckOpenDocuments();
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
      if (isCheckable(doc) && !sweeping) {
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
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.viewCheck`)) {
        lastVersionLine = "";
        // the checker that could not be started may be exactly what was just
        // changed - without this the gate stayed off until the window reloaded
        spawnFailed = false;
        recheckOpenDocuments();
        recheckOpen();
      }
    })
  );

  // Whatever is already open when the extension activates.
  recheckOpen();
}
