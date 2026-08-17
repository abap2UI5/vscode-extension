import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import {
  parseScreenshotErrors,
  parseScreenshotOutput,
  scratchFileName,
  screenshotArgs,
  screenshotUnsupported,
} from "./checkcore";
import { classNameOf } from "./abap";
import { checkerCommand, isCheckable, pickDocument, spawnEnv } from "./viewcheck";
import { createNonce, viewPreviewHtml } from "./webview";

/*
 * Preview View (No System) - the render gate used as a mirror.
 *
 * An abap2UI5 view exists at runtime and nowhere else: the class builds it on
 * a roundtrip, the frontend renders it, and nothing in between is a file
 * anyone can open. Seeing one has therefore meant a system - activate the
 * class, launch the app, wait for the roundtrip - which is a long way to go to
 * find out that a column is in the wrong order.
 *
 * The render gate already loads exactly this view in a real browser to decide
 * whether it survives creation. `--screenshot` (linter 0.2.2) keeps it
 * standing and photographs it, so the whole of this module is: write the
 * buffer to a scratch file, run that, and put the PNGs in a panel that
 * re-renders on save.
 *
 * What it is NOT is an app. Nothing round-trips, no event reaches ABAP, and
 * the data is the model derived from the class's own TYPES rather than what a
 * system would serve. F9 remains the way to run an app; this is the way to
 * look at a view.
 */

const CONFIG_SECTION = "abap2ui5";

interface Shot {
  uri: string;
  label: string;
}

/** The one panel. A second preview replaces the first rather than stacking:
 *  every one of them costs a temp directory and a browser launch. */
let panel: vscode.WebviewPanel | undefined;
/** The document the visible pictures are of - what a save re-renders. */
let previewed: vscode.Uri | undefined;
/** Temp directory holding the scratch source and the PNGs of that panel. */
let workDir: string | undefined;
/** Bumped per render so the webview loads the new picture instead of the
 *  cached one under the same path. */
let generation = 0;
/** A render in flight, so a burst of saves does not launch three browsers. */
let running = false;
/** What the panel currently shows - so a re-render can keep the last picture
 *  up while the new one is taken. A preview that blanks on every save is
 *  worse than one that is a few seconds old. */
let shown: { shots: Shot[]; errors: string[] } = { shots: [], errors: [] };

function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function disposeWorkDir(): void {
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
}

/** The title over the pictures: the class, or the file for a raw view. */
function titleOf(doc: vscode.TextDocument): string {
  return classNameOf(doc.getText(), doc.fileName);
}

/**
 * Run the linter's screenshot mode over the current buffer.
 *
 * The buffer, not the file: a view is previewed while it is being written, and
 * an unsaved editor is the normal case. It is written to a scratch file under
 * the name the CLI recognises (`scratchFileName`), exactly as the render gate
 * does it.
 */
function render(
  doc: vscode.TextDocument,
  dir: string,
  log: (m: string) => void
): Promise<{ files: string[]; errors: string[]; problem?: string }> {
  const scratch = path.join(dir, scratchFileName(doc.fileName));
  fs.writeFileSync(scratch, doc.getText());
  const checker = checkerCommand();
  const args = [
    ...checker.args,
    ...screenshotArgs({
      target: scratch,
      out: path.join(dir, "view.png"),
      theme: config().get<string>("viewPreview.theme", "sap_horizon"),
      viewport: config().get<string>("viewPreview.viewport", "1280x900"),
    }),
  ];
  log(`view-preview: ${checker.cmd} ${args.join(" ")}`);

  return new Promise((resolve) => {
    const child =
      checker.cmd === "node"
        ? // VS Code's own Node, so nothing has to be on the PATH - the same
          // way the render gate is spawned
          spawn(process.execPath, args, {
            cwd: dir,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...checker.env },
          })
        : spawn(checker.cmd, args, {
            cwd: dir,
            env: { ...spawnEnv(), ...checker.env },
            shell: process.platform === "win32",
          });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.stderr.on("data", (c) => (stderr += String(c)));
    child.on("error", (err) =>
      resolve({
        files: [],
        errors: [],
        problem:
          `The render gate could not be started (${checker.cmd}). ` +
          `Run "abap2UI5: Install Render Gate" once - it needs no Node ` +
          `installation of its own. (${String(err)})`,
      })
    );
    child.on("close", () => {
      const files = parseScreenshotOutput(stdout);
      if (!files.length) {
        log(`view-preview: no picture - ${stderr.slice(0, 400)}`);
        resolve({
          files: [],
          errors: [],
          problem: screenshotUnsupported(stderr)
            ? "The installed render gate does not know --screenshot yet. " +
              'Run "abap2UI5: Install Render Gate" to update it - the view ' +
              "check keeps working either way."
            : parseScreenshotErrors(stderr)[0] ??
              "Nothing could be rendered from this file.",
        });
      } else {
        resolve({ files, errors: parseScreenshotErrors(stderr) });
      }
    });
  });
}

/** Paint what we have: pictures, the errors that came with them, or the one
 *  sentence saying why there are none. */
function paint(
  target: vscode.WebviewPanel,
  doc: vscode.TextDocument,
  state: { shots: Shot[]; errors: string[]; busy?: boolean; problem?: string }
): void {
  target.webview.html = viewPreviewHtml({
    nonce: createNonce(),
    cspSource: target.webview.cspSource,
    title: titleOf(doc),
    shots: state.shots,
    theme: config().get<string>("viewPreview.theme", "sap_horizon"),
    viewport: config().get<string>("viewPreview.viewport", "1280x900"),
    errors: state.errors,
    busy: state.busy,
    problem: state.problem,
  });
}

async function refresh(doc: vscode.TextDocument, log: (m: string) => void): Promise<void> {
  if (!panel || !workDir || running) {
    return;
  }
  running = true;
  const target = panel;
  const dir = workDir;
  try {
    paint(target, doc, { ...shown, busy: true });
    const result = await render(doc, dir, log);
    if (target !== panel) {
      return; // the panel went away while the browser was starting
    }
    const shots = result.files.map((file, index) => ({
      uri: `${target.webview.asWebviewUri(vscode.Uri.file(file))}?v=${++generation}`,
      label:
        result.files.length === 1
          ? path.basename(file)
          : `view ${index + 1} of ${result.files.length} - ${path.basename(file)}`,
    }));
    // a failed re-render keeps the last good pictures and says what went
    // wrong above them; a first render that fails has none to keep
    shown = result.files.length ? { shots, errors: result.errors } : shown;
    paint(target, doc, { ...shown, problem: result.problem });
    log(
      `view-preview: ${shots.length} picture(s), ${result.errors.length} render error(s)`
    );
  } finally {
    running = false;
  }
}

export function registerViewPreview(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    { dispose: disposeWorkDir },

    vscode.commands.registerCommand("abap2ui5.previewView", async () => {
      const doc = pickDocument();
      if (!doc || !isCheckable(doc)) {
        vscode.window.showInformationMessage(
          "abap2UI5: no view here to preview - open an ABAP class building " +
            "views with z2ui5_cl_ui5_view_builder, or a *.view.xml."
        );
        return;
      }
      // a preview of another class starts from nothing: the old pictures are
      // of the old view, and keeping them up while the new ones render would
      // show the wrong app
      if (previewed?.toString() !== doc.uri.toString()) {
        shown = { shots: [], errors: [] };
      }
      previewed = doc.uri;
      if (!workDir) {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), "abap2ui5-preview-"));
      }
      if (!panel) {
        panel = vscode.window.createWebviewPanel(
          "abap2ui5.viewPreview",
          "abap2UI5 View Preview",
          { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
          {
            retainContextWhenHidden: true,
            // pictures only - the panel runs no script of its own, so it is
            // given no permission to
            localResourceRoots: [vscode.Uri.file(workDir)],
          }
        );
        panel.onDidDispose(() => {
          panel = undefined;
          previewed = undefined;
          shown = { shots: [], errors: [] };
          disposeWorkDir();
        });
      }
      panel.reveal(vscode.ViewColumn.Beside, true);
      await refresh(doc, log);
    }),

    /* A save is the moment the author is done with a thought, and the render
     * costs a browser launch - so it is the trigger, not every keystroke. */
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (panel && previewed && doc.uri.toString() === previewed.toString()) {
        await refresh(doc, log);
      }
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (
        panel &&
        previewed &&
        e.affectsConfiguration("abap2ui5.viewPreview")
      ) {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === previewed?.toString()
        );
        if (doc) {
          await refresh(doc, log);
        }
      }
    })
  );
  log("view-preview: command registered");
}
