import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { run } from "./childproc";
import {
  clearRenderGateFailure,
  installRenderGate,
  noteRenderGateFailure,
  renderGateBrowsers,
  renderGateCli,
  renderGateState,
} from "./rendergate";
import { VIEW_CHECK_DIRS } from "./repolayout";
import { snapshotError, snapshotUi5Version } from "./snapshot";
import { usesBuilder } from "./abap";
import { frozenBuilderOf, GateOptions, GateResult, runGate, VIEW_XML_RE } from "./gate";
import { preparedAbapOf } from "./language";
import { labelOf, noWorkspaceFolders } from "./abapsources";
import {
  augmentedPath,
  CheckerCommand,
  isCheckableSource,
  parseRenderReport,
  checkerCwd,
  RenderGateOutcome,
  renderGateNote,
  RenderResult,
  plannedFixes,
  resolveCheckerCommand,
  scratchFileName,
} from "./checkcore";
import { showProblemsMessage, textSource, toDiagnostics } from "./diagnostics";
import { plural } from "./text";
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

/** True while a workspace sweep runs. `fixWorkspace` opens every file it
 *  edits, and each open fires onDidOpenTextDocument - which scheduled a
 *  second full check of the same file, doubling the sweep's work and racing
 *  its own diagnostics.set. */
let sweeping = false;

/** The target/metadata versions are logged once per session, and again
 *  whenever they change (a different config file governs the document). */
let lastVersionLine = "";

/** Set by registerViewCheck - checkerCommand needs the extension's global
 *  storage to find a self-installed render gate. */
let extContext: vscode.ExtensionContext | undefined;

/** Set by registerViewCheck - what a failed install's "Show Log" button
 *  reveals, the same channel extension.ts hands to installRenderGate. */
let showLogFn: (() => void) | undefined;

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

/** The options plus the language features' memoised reconstruction of this
 *  document - one `prepareAbap` per version instead of one per consumer
 *  (see `GateOptions.prep`). XML never has one. */
function gateOptionsFor(
  doc: vscode.TextDocument,
  options: CheckOptions,
  isXml: boolean
): GateOptions {
  return isXml ? options : { ...options, prep: preparedAbapOf(doc) };
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

/** What one render-gate run produced: the report when there is one, and in
 *  every other case WHY there is none - a timeout, a checker that could not be
 *  started and an unreadable report are all "the render half did not run", and
 *  the check has to be able to say so instead of showing an empty result. */
interface RenderRun {
  outcome: RenderGateOutcome;
  result?: RenderResult;
}

async function runRenderGate(
  doc: vscode.TextDocument,
  log: (m: string) => void,
  superseded: () => boolean
): Promise<RenderRun> {
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
      return { outcome: "abandoned" };
    }
    if (outcome.kind === "timeout") {
      log(
        `view-check: render gate exceeded ${RENDER_TIMEOUT_MS} ms - killed, ` +
          "the property gate's findings still stand"
      );
      return { outcome: "timeout" };
    }
    if (outcome.kind === "spawn-failed") {
      log(`view-check: render gate failed to start - ${String(outcome.error)}`);
      const known = renderGateState(checker.installed).kind === "failed";
      noteRenderGateFailure(`${checker.cmd} could not be started`);
      if (!known) {
        void vscode.window
          .showWarningMessage(
            "abap2UI5: the render gate is enabled but its checker could not " +
              `be started (${checker.cmd} not found). Install it once - ` +
              "everything runs with VS Code's own runtime. The property " +
              "gate keeps working either way.",
            "Install Render Gate"
          )
          .then(async (pick) => {
            if (pick === "Install Render Gate" && extContext) {
              // a successful install clears the recorded failure itself -
              // installRenderGate owns that state
              await installRenderGate(extContext, log, showLogFn);
            }
          });
      }
      return { outcome: "spawn-failed" };
    }

    const parsed = parseRenderReport(outcome.stdout);
    if (!parsed.ok) {
      log(
        parsed.reason === "no-json"
          ? `view-check: render gate produced no JSON` +
              (outcome.stderr ? ` - stderr: ${outcome.stderr.slice(0, 400)}` : "")
          : `view-check: render gate returned broken JSON - ${parsed.detail}`
      );
      return { outcome: "no-report" };
    }
    return { outcome: "ok", result: parsed.result };
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
 * The findings of a document as it stands right now, memoised per document on
 * its version - one slot per URI, so two checkable editors side by side do
 * not evict each other, and `checkDocument` seeds it so the status bar and
 * the code lens read the check's own result instead of gating a second time.
 *
 * The quick-fix provider needs them, and it must not work off the findings
 * behind the diagnostics currently shown: a fix carries character offsets into
 * the source it was computed from, and between the last check and the moment
 * the lightbulb is opened the buffer may have moved. Recomputing is a few
 * milliseconds - applying a stale offset would corrupt the file.
 */
const memos = new Map<string, { version: number; findings: PropertyFinding[] }>();

/** Set by registerViewCheck - lets the quick-fix module ask for a re-check
 *  after it changed something OUTSIDE the document (the baseline file), which
 *  no document version bump would ever notice. */
let recheckAll: () => void = () => {};

export function recheckOpenDocuments(): void {
  memos.clear();
  recheckAll();
}

export function findingsNow(doc: vscode.TextDocument): PropertyFinding[] {
  const key = doc.uri.toString();
  const memo = memos.get(key);
  if (memo && memo.version === doc.version) {
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
  const gate = runGate(
    text,
    doc.uri.fsPath || doc.fileName,
    isXml,
    gateOptionsFor(doc, options, isXml)
  );
  if (options.baseline && doc.uri.scheme === "file") {
    // the quick-fix provider must see what the diagnostics show - a fix
    // offered for a finding the baseline already swallowed makes no sense
    applyBaselineTo(gate.findings, options.baseline, doc.uri.fsPath);
  }
  memos.set(key, { version: doc.version, findings: gate.findings });
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
  // labelOf, not path.basename: an ADT document's last path segment is often
  // the generic "main" or "source", which names nothing in a message
  const name = labelOf(doc.uri);
  const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
  // An unparsable buffer mid-edit throws out of the gate - on the live path
  // that was one unhandled rejection per keystroke, and in a workspace sweep
  // a single such file ended the whole run.
  let gate: GateResult;
  try {
    gate = runGate(
      text,
      doc.uri.fsPath || name,
      isXml,
      gateOptionsFor(doc, options, isXml)
    );
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
  // the same pipeline `findingsNow` runs - seeding it here spares the status
  // bar and the code lens a second gate run over the identical text
  memos.set(key, { version: startVersion, findings: gate.findings });

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
    gate.renderable
  ) {
    /* One state, one note. The render half can be missing, busy installing,
     * dead on a timeout or unreadable, and every one of those used to end in
     * an empty `renderErrors` array indistinguishable from a clean render -
     * so the on-demand command announced "view check passed" for a check
     * whose second half never ran. */
    const state = renderGateState(checkerCommand().installed);
    if (state.kind === "failed") {
      log(`view-check: render gate not run - ${state.reason}`);
      helperNote = renderGateNote("skipped-not-started");
    } else if (state.kind === "busy") {
      helperNote = renderGateNote("skipped-busy");
    } else {
      const render = await runRenderGate(doc, log, superseded);
      if (superseded()) {
        return; // the document moved on while Chromium was busy
      }
      renderErrors = render.result?.renderErrors ?? [];
      const note = renderGateNote(
        render.result?.skippedRender ? "skipped-helpers" : render.outcome
      );
      if (note) {
        helperNote = note;
      }
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
      showProblemsMessage(
        `abap2UI5: view check found ${plural(diags.length, "problem")} in ` +
          `${name} - see the Problems panel.`,
        true
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
  /** The gated text, when it came from disk and produced findings - what
   *  `checkWorkspace` computes the ranges from without opening the file. */
  text?: string;
  /** The config file governing it, or undefined when the settings do - what
   *  `updateBaseline` filters on, so a nested config's files do not land in
   *  the root baseline as entries the CLI would call stale. */
  configFile?: string;
}

/** Gate results per file, keyed on what the text was when it was gated - the
 *  open document's version, or the file's mtime. Pre-baseline, so one cache
 *  serves the check, the fix and the baseline rebuild alike; dropped whenever
 *  a config or a setting changes the answer. */
const sweepCache = new Map<
  string,
  { stamp: string; findings: PropertyFinding[]; text?: string; skip?: boolean }
>();

function clearSweepCache(): void {
  sweepCache.clear();
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

  /* The settings half of the options, read once for the whole sweep: it is
   * the same four values for every file, and only the config DISCOVERED per
   * directory differs. Rebuilding it per file re-read four settings and
   * allocated an object per file for no answer that could change. */
  const sweepSettings = {
    minUi5: config().get<string>("viewCheck.minUi5", "1.71"),
    distribution: config().get<string>("viewCheck.distribution", "sapui5"),
    allow: config().get<string[]>("viewCheck.allow", []),
    rules: ruleSettings(),
  };

  /* The I/O half runs AHEAD of the CPU-bound gate, in small concurrent
   * batches: the old loop awaited one stat, then one read, then gated, file
   * by file, so a sweep over a network share or a large repository spent most
   * of its wall time waiting on the disk one file at a time. A batch is
   * staged with `Promise.all` (bounded, so a 5000-file workspace does not
   * open 5000 reads at once) and then gated strictly IN ORDER - the finding
   * set and the order the callers see are exactly the serial loop's.
   *
   * Progress is reported every `PROGRESS_EVERY` files plus once at the end:
   * per file it was one host roundtrip per entry, which on a fast gate cost
   * more than the check it reported on. */
  const IO_BATCH = 8;
  const PROGRESS_EVERY = 25;
  let reported = 0;
  const report = (index: number) => {
    progress.report({
      message: `${index + 1}/${targets.length} - ${labelOf(targets[index].uri)}`,
      increment: ((index + 1 - reported) * 100) / targets.length,
    });
    reported = index + 1;
  };

  /** One target's I/O, done concurrently within a batch: the cache stamp
   *  (version or mtime), and the text when the cache misses. `undefined`
   *  means the file vanished between the glob and the stat/read - skipped,
   *  as before. An open document is captured synchronously, so its text
   *  still matches the version in its stamp. */
  const stage = async (target: {
    uri: vscode.Uri;
    open?: vscode.TextDocument;
  }): Promise<
    | { stamp: string; text?: string }
    | undefined
  > => {
    if (target.open) {
      // always with the text - it is already in memory, and carrying it even
      // on a cache hit means a cache cleared mid-sweep (a config change) can
      // still be gated instead of skipped
      return { stamp: `v${target.open.version}`, text: target.open.getText() };
    }
    let stamp: string;
    try {
      stamp = `m${(await vscode.workspace.fs.stat(target.uri)).mtime}`;
    } catch {
      return undefined;
    }
    const cached = sweepCache.get(target.uri.toString());
    if (cached && cached.stamp === stamp) {
      return { stamp };
    }
    try {
      return {
        stamp,
        text: Buffer.from(
          await vscode.workspace.fs.readFile(target.uri)
        ).toString("utf8"),
      };
    } catch {
      return undefined;
    }
  };

  const swept: SweptFile[] = [];
  for (
    let base = 0;
    base < targets.length && !token.isCancellationRequested;
    base += IO_BATCH
  ) {
    const batch = targets.slice(base, base + IO_BATCH);
    const staged = await Promise.all(batch.map(stage));
    for (const [offset, io] of staged.entries()) {
      if (token.isCancellationRequested) {
        break;
      }
      const index = base + offset;
      if ((index + 1) % PROGRESS_EVERY === 0 || index === targets.length - 1) {
        report(index);
      }
      if (!io) {
        continue;
      }
      const target = batch[offset];
      const uri = target.uri;
      const key = uri.toString();
      // a document with no path on disk has no directory to discover a config
      // from - the workspace's own config governs it, as it does on the live path
      const opts = resolveOptions(discoveryDirOf(uri), sweepSettings);
      /* Gated once per text: the cache key is the open document's version or
       * the file's mtime, so a re-run only pays for what changed since. The
       * cached findings are PRE-baseline - the baseline is applied per run
       * below, because the rebuild needs the unfiltered truth. */
      const cached = sweepCache.get(key);
      let entry = cached && cached.stamp === io.stamp ? cached : undefined;
      if (!entry) {
        let text = io.text;
        if (text === undefined) {
          // staged as a cache hit, but the entry was dropped between staging
          // and gating (a config change clears the cache mid-sweep) - re-read
          // rather than silently skip the file
          try {
            text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
          } catch {
            continue;
          }
        }
        const isXml = VIEW_XML_RE.test(uri.path);
        if (!isXml && !usesBuilder(text) && !frozenBuilderOf(text)) {
          sweepCache.set(key, { stamp: io.stamp, findings: [], skip: true });
          continue;
        }
        let gate: GateResult;
        try {
          gate = runGate(text, uri.scheme === "file" ? uri.fsPath : uri.path, isXml, opts);
        } catch (err) {
          // one file that cannot be parsed is not a reason to abandon the sweep
          log(`view-check: ${labelOf(uri)} skipped - ${String(err)}`);
          continue;
        }
        entry = gate.nothingChecked
          ? { stamp: io.stamp, findings: [], skip: true }
          : {
              stamp: io.stamp,
              findings: gate.findings,
              text: !target.open && gate.findings.length ? text : undefined,
            };
        sweepCache.set(key, entry);
      }
      if (entry.skip) {
        continue;
      }
      const findings = entry.findings.slice();
      if (options.baseline && opts.baseline && uri.scheme === "file") {
        applyBaselineTo(findings, opts.baseline, uri.fsPath);
      }
      swept.push({
        uri,
        findings,
        version: target.open?.version,
        text: entry.text,
        configFile: opts.configFile,
      });
    }
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
        let problems = 0;
        let moved = 0;
        /* What the sweep published, and what it deliberately did not touch -
         * the reconciliation below removes everything else.
         *
         * Clearing the collection first was simpler and wrong: a file that
         * was edited WHILE the sweep ran is skipped as `moved`, so the clear
         * threw away the diagnostics the live check had just published for
         * the current text and put nothing back. The file then looked clean
         * until the next keystroke. */
        const published = new Set<string>();
        const untouched = new Set<string>();
        for (const file of swept.files) {
          /* Ranges come from the text that was gated: the open document when
           * it still is what was gated, the swept text otherwise - never a
           * buffer that was typed in while the sweep ran, whose lines the
           * findings no longer describe. Opening every clean file as a
           * document just to place nothing was the old cost here. */
          let source;
          if (file.version !== undefined) {
            const doc = vscode.workspace.textDocuments.find(
              (d) => d.uri.toString() === file.uri.toString()
            );
            if (!doc || doc.version !== file.version) {
              moved++;
              untouched.add(file.uri.toString());
              continue;
            }
            source = doc;
          } else if (file.findings.length) {
            source = textSource(file.text ?? "");
          }
          const diags = source ? toDiagnostics(source, file.findings, []) : [];
          diagnostics.set(file.uri, diags);
          published.add(file.uri.toString());
          problems += diags.length;
        }
        // What the sweep did not find is no longer a problem: a file that was
        // fixed, reverted or deleted since the last run kept its diagnostics
        // forever, because only the files it DID report were written.
        if (!swept.cancelled) {
          const stale: vscode.Uri[] = [];
          diagnostics.forEach((uri) => {
            const key = uri.toString();
            if (!published.has(key) && !untouched.has(key)) {
              stale.push(uri);
            }
          });
          for (const uri of stale) {
            diagnostics.delete(uri);
          }
        }
        if (moved) {
          log(
            `view-check: workspace check - ${moved} file(s) not reported, ` +
              "edited while the sweep ran"
          );
        }
        log(
          `view-check: workspace sweep - ${swept.files.length} file(s), ` +
            `${problems} problem(s)${swept.cancelled ? " (cancelled)" : ""}`
        );
        const summary = swept.cancelled
          ? `abap2UI5: cancelled after ${plural(swept.files.length, "file")} - ` +
            `${plural(problems, "problem")} so far.`
          : !swept.files.length
            ? noWorkspaceFolders()
              ? "abap2UI5: nothing checkable is open. Without a folder in " +
                "the workspace there is nothing to search, so the check " +
                "covers the classes you have open - open one and run it again."
              : "abap2UI5: no checkable ABAP or view files found in this workspace."
            : problems
              ? `abap2UI5: ${plural(problems, "problem")} in ${plural(swept.files.length, "file")} - see the Problems panel.`
              : `abap2UI5: ${plural(swept.files.length, "file")} checked, nothing found.`;
        if (problems) {
          showProblemsMessage(summary, false);
        } else {
          vscode.window.showInformationMessage(summary);
        }
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
      // held through the open loop below too: every openTextDocument fires
      // onDidOpenTextDocument, which would schedule a full check per file
      sweeping = true;
      try {
        const swept = await sweepWorkspace(progress, token, { baseline: true }, log);
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
          for (const fix of planned) {
            edit.replace(
              file.uri,
              new vscode.Range(doc.positionAt(fix.start), doc.positionAt(fix.end)),
              fix.text,
              // through the refactor preview: a workspace's worth of edits
              // is reviewed, not sprung
              { needsConfirmation: true, label: "abap2UI5 mechanical fix" }
            );
          }
          fixes += planned.length;
          files++;
        }
        if (moved) {
          log(
            `view-check: workspace fix - ${moved} file(s) skipped, edited while the sweep ran`
          );
        }
        const skipped = moved
          ? ` ${plural(moved, "file")} edited while the sweep ran ` +
            `${moved === 1 ? "was" : "were"} left alone.`
          : "";
        if (!fixes) {
          vscode.window.showInformationMessage(
            `abap2UI5: nothing in ${plural(swept.files.length, "file")} can be corrected mechanically.` +
              skipped
          );
          return;
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
          vscode.window.showInformationMessage(
            "abap2UI5: no fixes were applied." + skipped
          );
          return;
        }
        log(`view-check: workspace fix - ${fixes} fix(es) in ${files} file(s)`);
        /* Overlapping fixes are left for the next run, here as everywhere -
         * so the count is what was applied, not what remains, and saying so is
         * what tells someone to run it again. */
        vscode.window.showInformationMessage(
          `abap2UI5: applied ${plural(fixes, "fix")} in ${plural(files, "file")}. ` +
            "Run it again if fixes overlapped; the files are edited, not saved." +
            skipped
        );
      } finally {
        sweeping = false;
      }
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
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showInformationMessage(
      "abap2UI5: no folder is open - a baseline belongs to a repository."
    );
    return;
  }
  // in a multi-root window the baseline of the INTENDED repository is
  // rebuilt, not silently the first folder's
  const folder =
    folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick({
          placeHolder: "Which repository's baseline should be rebuilt?",
        });
  if (!folder) {
    return;
  }
  const rootOptions = resolveOptions(folder.uri.fsPath, {
    minUi5: config().get<string>("viewCheck.minUi5", "1.71"),
    distribution: config().get<string>("viewCheck.distribution", "sapui5"),
    allow: config().get<string[]>("viewCheck.allow", []),
    rules: ruleSettings(),
  });
  const baselineFile = rootOptions.baseline;
  if (!baselineFile) {
    // the config path is known here, so the message can open the file the
    // line has to be added to
    const openConfig = rootOptions.configFile ? "Open abap2ui5lint.jsonc" : undefined;
    void vscode.window
      .showWarningMessage(
        'abap2UI5: this repository names no baseline. Add "baseline": ' +
          '"abap2ui5lint-baseline.json" to abap2ui5lint.jsonc first - the file ' +
          "is only honoured by the CLI when the config points at it.",
        ...(openConfig ? [openConfig] : [])
      )
      .then((pick) => {
        if (pick && rootOptions.configFile) {
          void vscode.window.showTextDocument(
            vscode.Uri.file(rootOptions.configFile)
          );
        }
      });
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
       * Only real files this baseline's own config governs go in.
       *
       * The sweep deliberately also gates documents that have no file behind
       * them (a class opened through ADT), files of the other folders in a
       * multi-root window, and files a NESTED config governs - whose findings
       * the CLI applies against that config's own baseline, never this one.
       * None of them can ever produce a matching entry when the CLI runs over
       * this repository - and a baseline entry that matches nothing is not
       * inert: it is STALE, which the linter reports and CI fails on. So
       * writing them would hand somebody a baseline that breaks the build it
       * was written to unblock.
       */
      const root = path.dirname(baselineFile);
      const inRepo = (uri: vscode.Uri): boolean => {
        if (uri.scheme !== "file") {
          return false;
        }
        const rel = path.relative(root, uri.fsPath);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      const mine = swept.files.filter(
        (file) => inRepo(file.uri) && file.configFile === rootOptions.configFile
      );
      const foreign = swept.files.length - mine.length;
      if (foreign) {
        log(
          `view-check: baseline - ${foreign} file(s) outside ${root}, with no ` +
            "file on disk, or governed by another config were not written into it"
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
        // the natural next step after a rewrite is looking at what was written
        const openBaseline = "Open Baseline";
        void vscode.window
          .showInformationMessage(
            `abap2UI5: ${path.basename(baselineFile)} now waives ` +
              `${plural(written.findings, "finding")} from ${plural(mine.length, "file")}.` +
              (foreign
                ? ` ${plural(foreign, "file")} outside the repository or governed by ` +
                  `another config ${foreign === 1 ? "was" : "were"} not included.`
                : ""),
            openBaseline
          )
          .then((pick) => {
            if (pick === openBaseline) {
              void vscode.window.showTextDocument(vscode.Uri.file(baselineFile));
            }
          });
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
  log: (m: string) => void,
  showLog?: () => void
): void {
  extContext = context;
  showLogFn = showLog;
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
   *  costs milliseconds per file. */
  const recheckOpen = () => {
    for (const doc of vscode.workspace.textDocuments) {
      if (isCheckable(doc)) {
        check(doc, 0, { render: false, announce: false });
      }
    }
  };
  recheckAll = recheckOpen;

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
    lastVersionLine = "";
    // the memoised findings behind the lightbulb and the "fix all" lens were
    // computed under the old config - the version they are keyed on does not
    // move when a config file does
    recheckOpenDocuments();
    recheckOpen();
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

    vscode.commands.registerCommand("abap2ui5.updateBaseline", () => updateBaseline(log)),

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
      memos.delete(doc.uri.toString());
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
        recheckOpenDocuments();
        recheckOpen();
      }
    })
  );

  // Whatever is already open when the extension activates.
  recheckOpen();
}
