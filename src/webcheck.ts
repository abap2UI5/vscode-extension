import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { frozenBuilderOf, runGate, VIEW_XML_RE } from "./gate";
import { textSource, toDiagnostics } from "./diagnostics";
import { usesBuilder } from "./abap";
import type { CheckOptions, SettingsOptions } from "./lintconfig";
import {
  applyBaselineMap,
  CONFIG_FILE_NAMES,
  dirOf,
  joinPath,
  nearestConfig,
  optionsFromConfig,
  parseBaseline,
  parseLintConfig,
} from "./configcore";

/*
 * The view check of the web build: exactly the in-process property gate,
 * scheduled the way `viewcheck.ts` schedules it on desktop - live while
 * typing, on save, on open, on demand.
 *
 * What the desktop wrapper adds is what a browser extension host cannot do:
 * the render gate (a child process) and the workspace sweep over arbitrary
 * globs.
 *
 * The repo's `abap2ui5lint.jsonc` is NOT in that category, and used to be
 * treated as if it were - it is discovered with `fs` on desktop, so the web
 * build checked against the VS Code settings alone and quietly disagreed with
 * CI about the UI5 floor, the distribution, the allow list and every rule
 * severity. It is read here through `vscode.workspace.fs` instead, and what
 * the file MEANS is the shared decision in `configcore.ts` - one precedence,
 * two ways of reading a file.
 */

const LIVE_DEBOUNCE_MS = 400;

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

function settings(): SettingsOptions {
  const cfg = config();
  return {
    minUi5: cfg.get<string>("viewCheck.minUi5", "1.71"),
    distribution: cfg.get<string>("viewCheck.distribution", "sapui5"),
    allow: cfg.get<string[]>("viewCheck.allow", []),
    rules: ruleSettings(),
  };
}

/* ---------------------------------------------------------------------------
 * The repo config, read the only way a browser host can
 *
 * `workspace.fs` is asynchronous and the gate is not - it runs on a keystroke
 * and has to answer now. So the configs are read ONCE into memory (there are
 * as many as a repository has apps, not as many as it has files) and re-read
 * when one changes. The same reason the desktop build memoises them on mtime.
 * ------------------------------------------------------------------------ */

/** path -> parsed config, or the error that says why it is not applied. */
const configs = new Map<string, { raw?: Record<string, unknown>; error?: string }>();
/** Baseline file path -> key/count map, loaded with the config that names it. */
const baselines = new Map<string, Map<string, number> | null>();

async function readWorkspaceConfigs(log: (m: string) => void): Promise<void> {
  configs.clear();
  baselines.clear();
  const found = await vscode.workspace.findFiles(
    `**/{${CONFIG_FILE_NAMES.join(",")}}`,
    "**/node_modules/**"
  );
  for (const uri of found) {
    let text: string;
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch (err) {
      configs.set(uri.path, { error: String(err) });
      continue;
    }
    try {
      const raw = parseLintConfig(text, uri.path);
      configs.set(uri.path, { raw });
      const baseline = raw.baseline as string | undefined;
      if (baseline) {
        const file = joinPath(dirOf(uri.path), baseline);
        try {
          const stored = new TextDecoder().decode(
            await vscode.workspace.fs.readFile(uri.with({ path: file }))
          );
          baselines.set(file, parseBaseline(stored));
        } catch {
          // a config naming a baseline that is not there is CI's to fail on
          baselines.set(file, null);
        }
      }
    } catch (err) {
      configs.set(uri.path, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  log(
    configs.size
      ? `web: ${configs.size} abap2ui5lint config(s) found - ${[...configs.keys()].join(", ")}`
      : "web: no abap2ui5lint.jsonc in this workspace - checking against the VS Code settings"
  );
}

/** The options one path is checked with - its nearest repo config over the
 *  settings, exactly as on desktop. Path-based so the workspace sweep can
 *  resolve a file it read without opening it as a document. */
function optionsForPath(path: string): CheckOptions {
  const base = settings();
  const file = nearestConfig(path, [...configs.keys()]);
  if (!file) {
    return base;
  }
  const entry = configs.get(file);
  if (!entry?.raw) {
    return { ...base, configFile: file, error: entry?.error };
  }
  return optionsFromConfig(entry.raw, file, base);
}

function options(doc: vscode.TextDocument): CheckOptions {
  return optionsForPath(doc.uri.path);
}

/** What the configured baseline waives for this path, if it has one. */
function applyBaselineForPath(
  options: CheckOptions,
  path: string,
  findings: PropertyFinding[]
): number {
  const map = options.baseline ? baselines.get(options.baseline) : undefined;
  return map && options.baseline
    ? applyBaselineMap(findings, map, options.baseline, path)
    : 0;
}

function applyBaselineFor(
  options: CheckOptions,
  doc: vscode.TextDocument,
  findings: PropertyFinding[]
): number {
  return applyBaselineForPath(options, doc.uri.path, findings);
}

/*
 * The web build's workspace sweep. Deliberately more modest than the desktop
 * one (viewcheck.ts): only the two file shapes that are checkable by name -
 * `*.clas.abap` classes and `*.view.xml` views - capped like the other web
 * scans, read through `workspace.fs`, no render gate and no fix/baseline
 * rebuild. It answers the same question though: "will the linter gate pass
 * before I push?", from a browser host that cannot run the CLI.
 */
const SWEEP_GLOB = "**/*.{clas.abap,view.xml}";
/** Same cap as the nav map's workspace scan - beyond this, a real index. */
const SWEEP_FILE_CAP = 500;

async function sweepWorkspaceWeb(
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
      const found = await vscode.workspace.findFiles(
        SWEEP_GLOB,
        "**/node_modules/**",
        SWEEP_FILE_CAP
      );
      // An open document wins over the file of the same name - it is what
      // the user is looking at, and it may hold unsaved changes.
      const open = new Map<string, vscode.TextDocument>();
      for (const doc of vscode.workspace.textDocuments) {
        open.set(doc.uri.toString(), doc);
      }
      const targets: Array<{ uri: vscode.Uri; open?: vscode.TextDocument }> =
        found.map((uri) => ({ uri, open: open.get(uri.toString()) }));
      const known = new Set(found.map((uri) => uri.toString()));
      for (const doc of vscode.workspace.textDocuments) {
        if (!known.has(doc.uri.toString()) && isCheckable(doc)) {
          targets.push({ uri: doc.uri, open: doc });
        }
      }

      const results: Array<[vscode.Uri, vscode.Diagnostic[]]> = [];
      let checked = 0;
      let problems = 0;
      for (const [index, target] of targets.entries()) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report({
          message: `${index + 1}/${targets.length}`,
          increment: 100 / targets.length,
        });
        const uri = target.uri;
        let text: string;
        if (target.open) {
          text = target.open.getText();
        } else {
          try {
            text = new TextDecoder().decode(
              await vscode.workspace.fs.readFile(uri)
            );
          } catch {
            continue;
          }
        }
        const isXml = VIEW_XML_RE.test(uri.path);
        if (!isXml && !usesBuilder(text) && !frozenBuilderOf(text)) {
          continue;
        }
        const opts = optionsForPath(uri.path);
        let gate;
        try {
          gate = runGate(text, uri.path, isXml, opts);
        } catch (err) {
          // one file that cannot be parsed is not a reason to stop the sweep
          log(`web: ${uri.path} skipped - ${String(err)}`);
          continue;
        }
        if (gate.nothingChecked) {
          continue;
        }
        applyBaselineForPath(opts, uri.path, gate.findings);
        const source = target.open ?? textSource(text);
        const diags = toDiagnostics(source, gate.findings, []);
        results.push([uri, diags]);
        checked++;
        problems += diags.length;
      }
      const cancelled = token.isCancellationRequested;
      if (!cancelled) {
        // what the sweep did not find is no longer a problem - a fixed or
        // deleted file must not keep its squiggles forever
        diagnostics.clear();
      }
      for (const [uri, diags] of results) {
        diagnostics.set(uri, diags);
      }
      log(
        `web: workspace sweep - ${checked} file(s) checked, ` +
          `${problems} problem(s)${cancelled ? " (cancelled)" : ""}`
      );
      vscode.window.showInformationMessage(
        cancelled
          ? `abap2UI5: cancelled after ${checked} file(s) - ${problems} problem(s) so far.`
          : !checked
            ? "abap2UI5: no checkable *.clas.abap or *.view.xml files found in this workspace."
            : problems
              ? `abap2UI5: ${problems} problem(s) in ${checked} file(s) - see the Problems panel.`
              : `abap2UI5: ${checked} file(s) checked, nothing found.`
      );
    }
  );
}

function isCheckable(doc: vscode.TextDocument): boolean {
  if (VIEW_XML_RE.test(doc.fileName)) {
    return true;
  }
  if (doc.languageId !== "abap" && !/\.abap$/i.test(doc.fileName)) {
    return false;
  }
  const text = doc.getText();
  return usesBuilder(text) || frozenBuilderOf(text) !== undefined;
}

/** Findings per document, memoised on its version - the same contract
 *  `viewcheck.ts` exposes on desktop (the XML preview mirrors it). One slot
 *  per URI, and `check` seeds it, so publishing diagnostics and reading them
 *  back is one gate run, not two. */
const memos = new Map<string, { version: number; findings: PropertyFinding[] }>();

export function webFindingsNow(doc: vscode.TextDocument): PropertyFinding[] {
  const key = doc.uri.toString();
  const memo = memos.get(key);
  if (memo && memo.version === doc.version) {
    return memo.findings;
  }
  if (!isCheckable(doc)) {
    return [];
  }
  const text = doc.getText();
  const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
  const opts = options(doc);
  let gate;
  try {
    gate = runGate(text, doc.fileName, isXml, opts);
  } catch {
    return []; // an unparsable buffer mid-edit is not worth reporting
  }
  applyBaselineFor(opts, doc, gate.findings);
  memos.set(key, { version: doc.version, findings: gate.findings });
  return gate.findings;
}

export function registerWebCheck(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  const diagnostics =
    vscode.languages.createDiagnosticCollection("abap2ui5-view-check");
  const timers = new Map<string, NodeJS.Timeout>();

  const check = (doc: vscode.TextDocument, announce: boolean) => {
    if (!isCheckable(doc)) {
      // it may have STOPPED being checkable - the old findings must not
      // outlive the builder call they were about
      diagnostics.delete(doc.uri);
      if (announce) {
        vscode.window.showInformationMessage(
          "abap2UI5: open an ABAP class that builds views with " +
            "z2ui5_cl_ui5_view_builder (or a *.view.xml file) to check it."
        );
      }
      return;
    }
    const text = doc.getText();
    const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
    const opts = options(doc);
    let gate;
    try {
      gate = runGate(text, doc.fileName, isXml, opts);
    } catch (err) {
      // one keystroke's worth of unparsable buffer, not a reason to throw
      // out of a listener on every character
      log(`web: ${doc.fileName} could not be checked (${String(err)})`);
      return;
    }
    const waived = applyBaselineFor(opts, doc, gate.findings);
    memos.set(doc.uri.toString(), { version: doc.version, findings: gate.findings });
    if (gate.nothingChecked) {
      diagnostics.delete(doc.uri);
      if (announce) {
        vscode.window.showInformationMessage(
          `abap2UI5: nothing to check - ${gate.nothingChecked}.`
        );
      }
      return;
    }
    const diags = toDiagnostics(doc, gate.findings, []);
    diagnostics.set(doc.uri, diags);
    if (announce) {
      if (opts.configFile) {
        log(
          `web: ${doc.fileName} checked against ${opts.configFile}` +
            (opts.error ? ` (NOT applied: ${opts.error})` : "") +
            (waived ? ` - ${waived} finding(s) waived by the baseline` : "")
        );
      }
      vscode.window.showInformationMessage(
        diags.length
          ? `abap2UI5: view check found ${diags.length} problem(s) - see the Problems panel.`
          : "abap2UI5: view check passed."
      );
    }
  };

  const schedule = (doc: vscode.TextDocument, delay: number) => {
    const key = doc.uri.toString();
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        check(doc, false);
      }, delay)
    );
  };

  context.subscriptions.push(
    diagnostics,
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.commands.registerCommand("abap2ui5.checkViews", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) {
        check(doc, true);
      }
    }),
    // The workspace sweep, sized for the browser host - see sweepWorkspaceWeb.
    vscode.commands.registerCommand("abap2ui5.checkWorkspace", () =>
      sweepWorkspaceWeb(diagnostics, log)
    ),
    // The same two settings the desktop check honours. Turning live checking
    // off and still being checked on every keystroke in the browser is the
    // kind of difference nobody expects from the same setting.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (config().get<boolean>("viewCheck.onSave", true)) {
        schedule(doc, 0);
      }
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!config().get<boolean>("viewCheck.live", true)) {
        return;
      }
      if (e.contentChanges.length) {
        schedule(e.document, LIVE_DEBOUNCE_MS);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => schedule(doc, 0)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      // clear, not just forget: a timer dropped from the map still fires, and
      // its check publishes diagnostics for the document that was just closed
      // - right after this handler deleted them. They then sit in the Problems
      // panel for a file nothing is showing any more.
      const key = doc.uri.toString();
      const pending = timers.get(key);
      if (pending) {
        clearTimeout(pending);
      }
      timers.delete(key);
      diagnostics.delete(doc.uri);
      memos.delete(key);
    }),

    // The same reaction the desktop check has: the settings are part of every
    // answer, so a change re-checks what is open and drops the memoised
    // findings computed under the old ones.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.viewCheck`)) {
        memos.clear();
        for (const editor of vscode.window.visibleTextEditors) {
          schedule(editor.document, 0);
        }
      }
    })
  );

  /* A config file is part of the answer for every file it governs, so a
   * change to one invalidates the cache and re-checks what is open - the same
   * watcher the desktop build keeps.
   *
   * The baseline files the configs name are watched with them: they are read
   * once into `baselines` and nothing else re-reads them, so a pull that
   * updated or emptied one left the editor waiving findings CI reports for
   * the rest of the session - the editor/CI drift this module exists to
   * prevent. Desktop re-reads per check and notices by itself. */
  const watcher = vscode.workspace.createFileSystemWatcher(
    `**/{${CONFIG_FILE_NAMES.join(",")},*baseline*.json}`
  );
  const reload = async () => {
    await readWorkspaceConfigs(log);
    memos.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      schedule(editor.document, 0);
    }
  };
  // the watcher glob cannot exclude, and a dependency's baseline-named file
  // must not re-read every config in the workspace
  const changed = (uri: vscode.Uri) => {
    if (!uri.path.includes("/node_modules/")) {
      void reload();
    }
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(changed),
    watcher.onDidCreate(changed),
    watcher.onDidDelete(changed)
  );

  log("web: property gate registered (repo config through workspace.fs)");
  void reload();
}
