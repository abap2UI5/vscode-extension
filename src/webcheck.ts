import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { runGate, VIEW_XML_RE } from "./gate";
import { toDiagnostics } from "./diagnostics";
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

/** The options one document is checked with - its nearest repo config over
 *  the settings, exactly as on desktop. */
function options(doc: vscode.TextDocument): CheckOptions {
  const base = settings();
  const file = nearestConfig(doc.uri.path, [...configs.keys()]);
  if (!file) {
    return base;
  }
  const entry = configs.get(file);
  if (!entry?.raw) {
    return { ...base, configFile: file, error: entry?.error };
  }
  return optionsFromConfig(entry.raw, file, base);
}

/** What the configured baseline waives for this document, if it has one. */
function applyBaselineFor(
  options: CheckOptions,
  doc: vscode.TextDocument,
  findings: PropertyFinding[]
): number {
  const map = options.baseline ? baselines.get(options.baseline) : undefined;
  return map && options.baseline
    ? applyBaselineMap(findings, map, options.baseline, doc.uri.path)
    : 0;
}

function isCheckable(doc: vscode.TextDocument): boolean {
  if (VIEW_XML_RE.test(doc.fileName)) {
    return true;
  }
  if (doc.languageId !== "abap" && !/\.abap$/i.test(doc.fileName)) {
    return false;
  }
  return usesBuilder(doc.getText());
}

/** Findings of a document as it stands - memoised on its version, the same
 *  contract `viewcheck.ts` exposes on desktop (the XML preview mirrors it). */
let memo:
  | { key: string; version: number; findings: PropertyFinding[] }
  | undefined;

export function webFindingsNow(doc: vscode.TextDocument): PropertyFinding[] {
  const key = doc.uri.toString();
  if (memo && memo.key === key && memo.version === doc.version) {
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
  memo = { key, version: doc.version, findings: gate.findings };
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
      timers.delete(doc.uri.toString());
      diagnostics.delete(doc.uri);
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
    memo = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      schedule(editor.document, 0);
    }
  };
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(reload),
    watcher.onDidCreate(reload),
    watcher.onDidDelete(reload)
  );

  log("web: property gate registered (repo config through workspace.fs)");
  void reload();
}
