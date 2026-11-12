import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CONFIG_SECTION } from "./settings";
import { CLOUD_GUI_DIRS } from "./repolayout";
import { run } from "./childproc";
import { plural } from "./text";
import { isCheckable } from "./viewcheck";
import { loadTar } from "./rendergate";
import { installReport2ui5, installRoot, type Report2ui5Pin } from "./report2ui5install";
import report2ui5Pin from "./data/report2ui5.json";
import {
  PATH_SETTING,
  defaultTargetClass,
  interpretRun,
  isReportFile,
  migrateArgs,
  outputFiles,
  refusalRange,
  resolveReport2cloud,
  targetClassError,
  type MigrateRequest,
  type MigrateResult,
  type Refusal,
} from "./report2cloud";

/*
 * "Migrate Classic Report to abap2UI5" - the plumbing around
 * `report2cloud.ts`: which report, which class, which folder, running the
 * CLI of the configured abap-cloud-gui checkout, and showing the answer -
 * the class and its migration report side by side, every refusal as a
 * problem on the statement it refuses.
 *
 * The CLI runs with VS Code's own Node.js (ELECTRON_RUN_AS_NODE), like the
 * render gate, so nothing beyond the checkout and its `npm ci` is needed.
 * The setting that chooses the checkout decides which program runs, so it
 * is machine scoped and restricted in untrusted workspaces; the report
 * itself is only parsed, never executed, which is why the command also runs
 * in Restricted Mode - with a checkout the user configured outside the
 * workspace (ABAP_CLOUD_GUI_HOME). The copy "Install Report Converter" puts
 * into global storage (`report2ui5install.ts`) is neither downloaded nor run
 * in Restricted Mode.
 */

const DIAGNOSTIC_SOURCE = "report2cloud";
/** The converter takes well under a second per report; this is for a stuck
 *  process, not a slow one. */
const TIMEOUT_MS = 120_000;

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/** The report the command was invoked on: the explorer's uri, the active
 *  editor's `.prog.abap`, else a file picked from disk. */
async function reportUri(arg?: unknown): Promise<vscode.Uri | undefined> {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const active = vscode.window.activeTextEditor?.document;
  if (active && isReportFile(active.fileName)) {
    return active.uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Migrate",
    title: "abap2UI5: Pick a Classic Report (*.prog.abap)",
    filters: { "ABAP report": ["abap"] },
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
  });
  return picked?.[0];
}

/** Where the files go: beside the report, or a folder picked like "New
 *  Project from Template" picks one. */
async function outputFolder(reportFile: string): Promise<string | undefined> {
  const beside = path.dirname(reportFile);
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(file-directory) Next to the report",
        description: vscode.workspace.asRelativePath(beside),
        dir: beside as string | undefined,
      },
      { label: "$(folder-opened) Choose a folder…", description: "", dir: undefined },
    ],
    { title: "abap2UI5: Where to Write the Class", placeHolder: "The folder for the class files and the migration report" }
  );
  if (!pick) {
    return undefined;
  }
  if (pick.dir) {
    return pick.dir;
  }
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Write the class here",
    title: "abap2UI5: Folder for the Migrated Class",
    defaultUri: vscode.Uri.file(beside),
  });
  return folders?.[0]?.fsPath;
}

/** The pinned converter (`src/data/report2ui5.json`). */
const PIN = report2ui5Pin as Report2ui5Pin;

/** How long one install may take - a stalled download must not leave the
 *  progress notification up for good. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** No archive of the closure comes near this; a response that does is not
 *  the artefact, and is not held in memory to find that out. */
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

/** The installed copy's directory for the pinned commit - undefined in
 *  Restricted Mode, where it is not run. */
function installedRoot(context: vscode.ExtensionContext): string | undefined {
  return vscode.workspace.isTrusted ? installRoot(context.globalStorageUri.fsPath, PIN.commit) : undefined;
}

/** One URL, whole, through VS Code's `fetch` - cancellable, capped. */
async function download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) {
    throw new Error(`download failed - HTTP ${res.status} for ${url}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_DOWNLOAD_BYTES) {
      throw new Error(`download of ${url} exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MB - refused`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

let installing = false;

/** "abap2UI5: Install Report Converter": the pinned report2UI5 and its
 *  parser into global storage. True when a converter is installed
 *  afterwards. Refused in Restricted Mode. */
export async function installReportConverter(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  force = false
): Promise<boolean> {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      "abap2UI5: the report converter is not downloaded in Restricted Mode - trust the workspace first."
    );
    return false;
  }
  if (installing) {
    vscode.window.showInformationMessage("abap2UI5: the report converter is being installed already.");
    return false;
  }
  installing = true;
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(new Error("install timed out")), INSTALL_TIMEOUT_MS);
  try {
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "abap2UI5: installing the report converter",
        cancellable: true,
      },
      (progress, token) => {
        token.onCancellationRequested(() => aborter.abort(new Error("install cancelled")));
        let reported = 0;
        return installReport2ui5({
          pin: PIN,
          storage: context.globalStorageUri.fsPath,
          download,
          tar: loadTar(),
          signal: aborter.signal,
          log,
          force,
          progress: (message, done, total) => {
            const pct = Math.round((done / total) * 100);
            progress.report({ message: `${message}…`, increment: pct - reported });
            reported = pct;
          },
        });
      }
    );
    log(`report2ui5: ${result.installed ? "installed" : "already installed"} at ${result.root} (abap-cloud-gui ${PIN.commit.slice(0, 12)})`);
    vscode.window.showInformationMessage(
      result.installed
        ? `abap2UI5: report converter installed (abap-cloud-gui ${PIN.commit.slice(0, 12)}) - Migrate Classic Report uses it when no checkout is configured.`
        : `abap2UI5: the report converter (abap-cloud-gui ${PIN.commit.slice(0, 12)}) is installed already.`
    );
    return true;
  } catch (err) {
    const cause = aborter.signal.aborted && aborter.signal.reason instanceof Error ? aborter.signal.reason : err;
    const text = cause instanceof Error ? cause.message : String(cause);
    log(`report2ui5: install failed - ${text}`);
    vscode.window.showErrorMessage(`abap2UI5: report converter install failed (${text.slice(0, 160)}).`);
    return false;
  } finally {
    clearTimeout(timer);
    installing = false;
  }
}

/** The answer to a converter that cannot run. `reinstall` and `install`
 *  come first when they would fix it; true when the command should run
 *  again (an install just succeeded). */
async function offerConfigure(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  message: string,
  opts: { root?: string; install?: boolean; reinstall?: boolean } = {}
): Promise<boolean> {
  const configure = "Configure…";
  const npmCi = "Run npm ci";
  const install = "Install";
  const actions = [
    ...(opts.install || opts.reinstall ? [install] : []),
    ...(opts.root && !opts.reinstall ? [npmCi] : []),
    configure,
  ];
  const picked = await vscode.window.showWarningMessage(`abap2UI5: ${message}`, ...actions);
  if (picked === install) {
    return installReportConverter(context, log, Boolean(opts.reinstall));
  }
  if (picked === configure) {
    await vscode.commands.executeCommand("workbench.action.openSettings", PATH_SETTING);
  } else if (picked === npmCi && opts.root) {
    const term = vscode.window.createTerminal({ name: "abap-cloud-gui: npm ci", cwd: opts.root });
    term.show();
    term.sendText("npm ci", true);
  }
  return false;
}

/** Opens a written file - the class in the current column, the migration
 *  report beside it. */
async function open(file: string, beside: boolean): Promise<vscode.TextEditor | undefined> {
  if (!fs.existsSync(file)) {
    return undefined;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  return vscode.window.showTextDocument(doc, {
    viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    preview: false,
  });
}

/** The refusals as problems on the report - one diagnostic each, with the
 *  statement it refuses underlined. */
function publishRefusals(
  collection: vscode.DiagnosticCollection,
  doc: vscode.TextDocument,
  refusals: readonly Refusal[]
): void {
  const lines = doc.getText().split(/\r?\n/);
  collection.set(
    doc.uri,
    refusals.map((r) => {
      const at = refusalRange(lines, r.row, r.col);
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(at.startLine, at.startChar, at.endLine, at.endChar),
        r.message,
        vscode.DiagnosticSeverity.Error
      );
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = "refused";
      return diagnostic;
    })
  );
}

/** After a class was written: open it with its report, then offer the
 *  view commands - when the class builds a view they can look at. A report
 *  class draws its screen through z2ui5_cl_cgui_report and builds none of
 *  its own, and then the offer would only lead to "no view here". */
async function showClass(result: { classFile?: string; report: string }, summary: string): Promise<void> {
  const editor = result.classFile ? await open(result.classFile, false) : undefined;
  await open(result.report, true);
  const preview = "Preview View (No System)";
  const checkViews = "Check Views";
  const actions = editor && isCheckable(editor.document) ? [preview, checkViews] : [];
  const picked = await vscode.window.showInformationMessage(`abap2UI5: ${summary}`, ...actions);
  if (!picked || !editor) {
    return;
  }
  // both commands act on the active editor - the report beside took the focus
  await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preview: false });
  await vscode.commands.executeCommand(picked === preview ? "abap2ui5.previewView" : "abap2ui5.checkViews");
}

export function registerMigrateReport(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("abap2ui5-report2cloud");

  async function convert(req: MigrateRequest, cwd: string): Promise<MigrateResult> {
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `abap2UI5: migrating ${path.basename(req.file)}…`,
      },
      () =>
        run(process.execPath, migrateArgs(req), {
          cwd,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          timeoutMs: TIMEOUT_MS,
        })
    );
    if (outcome.kind === "closed") {
      log(`report2cloud: exit ${outcome.code}${outcome.stdout ? `\n${outcome.stdout.trimEnd()}` : ""}${outcome.stderr ? `\n${outcome.stderr.trimEnd()}` : ""}`);
    }
    return interpretRun(outcome, req, (f) => fs.existsSync(f));
  }

  context.subscriptions.push(
    // the refusals stay until the command runs on the report again - like
    // any checker run on demand, the next run is what says they are gone
    diagnostics,
    vscode.commands.registerCommand("abap2ui5.installReportConverter", () =>
      installReportConverter(context, log)
    ),
    vscode.commands.registerCommand("abap2ui5.migrateReport", async (arg?: unknown) => {
      const uri = await reportUri(arg);
      if (!uri) {
        return;
      }
      if (uri.scheme !== "file" || !isReportFile(uri.fsPath)) {
        vscode.window.showInformationMessage(
          "abap2UI5: pick a classic report saved on disk as <name>.prog.abap (abapGit format) - " +
            "report2cloud reads the file and its .prog.xml text pool beside it."
        );
        return;
      }
      const resolution = resolveReport2cloud({
        setting: config().get<string>("report2cloud.path", ""),
        env: process.env,
        reposRoot: config().get<string>("mcp.reposRoot", ""),
        dirs: CLOUD_GUI_DIRS,
        installed: installedRoot(context),
        restricted: !vscode.workspace.isTrusted,
        exists: (f) => fs.existsSync(f),
      });
      if (!resolution.ok) {
        log(`report2cloud: ${resolution.message}`);
        const again = await offerConfigure(context, log, resolution.message, {
          root: resolution.reason === "no-deps" ? resolution.root : undefined,
          install: resolution.reason === "unconfigured" && vscode.workspace.isTrusted,
          reinstall: resolution.reason !== "unconfigured" && resolution.source === "installed",
        });
        if (again) {
          await vscode.commands.executeCommand("abap2ui5.migrateReport", uri);
        }
        return;
      }

      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.isDirty && !(await doc.save())) {
        vscode.window.showWarningMessage("abap2UI5: save the report first - report2cloud reads it from disk.");
        return;
      }
      const suggested = defaultTargetClass(uri.fsPath, doc.getText());
      const className = (
        await vscode.window.showInputBox({
          title: "abap2UI5: Class Name for the Migrated Report",
          value: suggested,
          prompt: "The report class to generate (inherits from z2ui5_cl_cgui_report, up to 30 characters)",
          validateInput: targetClassError,
        })
      )
        ?.trim()
        .toLowerCase();
      if (!className) {
        return;
      }
      const out = await outputFolder(uri.fsPath);
      if (!out) {
        return;
      }
      const existing = Object.values(outputFiles(out, className)).filter((f) => fs.existsSync(f));
      if (existing.length) {
        const overwrite = "Overwrite";
        const picked = await vscode.window.showWarningMessage(
          `abap2UI5: ${plural(existing.length, "file")} of ${className} already exist in ` +
            `${vscode.workspace.asRelativePath(out)} (${existing.map((f) => path.basename(f)).join(", ")}). Replace them?`,
          { modal: true },
          overwrite
        );
        if (picked !== overwrite) {
          return;
        }
      }

      const req: MigrateRequest = { cli: resolution.cli, file: uri.fsPath, className, out };
      log(`report2cloud: ${resolution.cli} (${resolution.source}) on ${uri.fsPath} -> ${className} in ${out}`);
      diagnostics.delete(uri);
      let result = await convert(req, resolution.root);

      if (result.kind === "refused") {
        publishRefusals(diagnostics, doc, result.refusals);
        await open(result.report, true);
        const partial = "Write Partial Result";
        const problems = "Show Problems";
        const picked = await vscode.window.showWarningMessage(
          `abap2UI5: ${plural(result.refusals.length, "statement")} of ${path.basename(uri.fsPath)} ` +
            "cannot be migrated - each is listed in Problems and in the migration report. No class was written.",
          partial,
          problems
        );
        if (picked === problems) {
          await vscode.commands.executeCommand("workbench.actions.view.problems");
          return;
        }
        if (picked !== partial) {
          return;
        }
        result = await convert({ ...req, partial: true }, resolution.root);
        if (result.kind === "refused") {
          publishRefusals(diagnostics, doc, result.refusals);
          await showClass(
            result,
            `${result.className} written as a draft with ${plural(result.refusals.length, "refused statement")} ` +
              "marked in it - rewrite them before activating the class."
          );
          return;
        }
      }

      if (result.kind === "converted") {
        await showClass(
          result,
          `${result.className} written - ${plural(result.mapped, "construct")} mapped, ` +
            `${plural(result.todos, "TODO")}` +
            (result.release !== undefined
              ? `, ${plural(result.release, "object")} to check for ABAP Cloud`
              : "") +
            " (see the migration report)."
        );
        return;
      }
      if (result.kind === "no-deps") {
        await offerConfigure(context, log, result.message, {
          root: resolution.root,
          reinstall: resolution.source === "installed",
        });
        return;
      }
      if (result.kind === "failed") {
        log(`report2cloud: ${result.message}`);
        vscode.window.showErrorMessage(`abap2UI5: ${result.message}`);
      }
    })
  );
}
