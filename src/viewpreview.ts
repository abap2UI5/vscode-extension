import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
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
  shotLabel,
  viewportCount,
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
 * The preview data for a document, by the linter's own convention: a
 * `zcl_app.mock.json` next to `zcl_app.clas.abap`.
 *
 * It has to be passed explicitly rather than left to the convention, because
 * what is rendered is a scratch copy in a temp directory - nothing is next to
 * it there. Without one the picture shows the model derived from the class's
 * literal seeds, which for a table filled by a SELECT is an empty table.
 */
function mockFileFor(doc: vscode.TextDocument): string | undefined {
  if (doc.uri.scheme !== "file") {
    return undefined;
  }
  const candidate = doc.uri.fsPath.replace(
    /\.(clas\.abap|abap|view\.xml|fragment\.xml|xml)$/i,
    ".mock.json"
  );
  return candidate !== doc.uri.fsPath && fs.existsSync(candidate)
    ? candidate
    : undefined;
}

/**
 * Run the linter's screenshot mode over a source text.
 *
 * The text rather than the file: a view is previewed while it is being
 * written, and an unsaved editor is the normal case - the comparison mode
 * renders a text that is in no file at all (the committed version). It goes to
 * a scratch file under the name the CLI recognises (`scratchFileName`),
 * exactly as the render gate does it.
 */
function render(
  source: { text: string; fileName: string; mock?: string; prefix: string },
  dir: string,
  log: (m: string) => void
): Promise<{ files: string[]; errors: string[]; problem?: string }> {
  const scratchDir = path.join(dir, source.prefix);
  fs.mkdirSync(scratchDir, { recursive: true });
  const scratch = path.join(scratchDir, scratchFileName(source.fileName));
  fs.writeFileSync(scratch, source.text);
  const checker = checkerCommand();
  const args = [
    ...checker.args,
    ...screenshotArgs({
      target: scratch,
      out: path.join(scratchDir, "view.png"),
      theme: config().get<string>("viewPreview.theme", "sap_horizon"),
      viewport: config().get<string>("viewPreview.viewport", "1280x900"),
      model: source.mock,
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
          /*
           * Reinstalling was the advice here, and it could not possibly
           * help: the installer fetches the bundle built from the linter
           * commit this extension pins, so running it again produces the
           * same gate that just refused the option. Saying "update it" sent
           * people round that loop as often as they were willing.
           *
           * The honest version names the one thing that does move it - a
           * newer bundle published by the linter - and points at the setting
           * for anyone who has a current checkout of their own.
           */
          problem: screenshotUnsupported(stderr)
            ? "This render gate is older than the picture feature: its " +
              "checker does not know --screenshot. Reinstalling fetches the " +
              "same version again, so it will not help - the bundle for a " +
              "linter new enough has to be published first. With a local " +
              "linter checkout you can point abap2ui5.viewCheck.command at " +
              "its cli.mjs instead. The view check works either way."
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
  const mock = mockFileFor(doc);
  target.webview.html = viewPreviewHtml({
    nonce: createNonce(),
    cspSource: target.webview.cspSource,
    title: titleOf(doc),
    shots: state.shots,
    theme: config().get<string>("viewPreview.theme", "sap_horizon"),
    viewport: config().get<string>("viewPreview.viewport", "1280x900"),
    /* Which data the picture shows is not a detail: an empty table is a
     * perfectly correct rendering of a model with no rows, and without this
     * line nobody can tell that from a broken binding. */
    data: mock ? path.basename(mock) : "model derived from the class",
    errors: state.errors,
    busy: state.busy,
    problem: state.problem,
  });
}

/**
 * The committed text of a document - what the comparison renders as "before".
 *
 * `git show HEAD:<path>`, because that is the version the question is about:
 * "what did my change do to the view" means the change against what is
 * committed, not against what was last saved. A file git does not know has no
 * before, and says so.
 */
function committedText(doc: vscode.TextDocument): Promise<string | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder || doc.uri.scheme !== "file") {
    return Promise.resolve(undefined);
  }
  const relative = path
    .relative(folder.uri.fsPath, doc.uri.fsPath)
    .split(path.sep)
    .join("/");
  return new Promise((resolve) => {
    const child = spawn("git", ["show", `HEAD:${relative}`], {
      cwd: folder.uri.fsPath,
      env: spawnEnv(),
      shell: process.platform === "win32",
    });
    let stdout = "";
    child.stdout.on("data", (c) => (stdout += String(c)));
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => resolve(code === 0 ? stdout : undefined));
  });
}

/** A refresh asked for while one was running - the latest one, which is the
 *  only one worth doing. */
let queued: { doc: vscode.TextDocument; options: { compare?: boolean } } | undefined;

async function refresh(
  doc: vscode.TextDocument,
  log: (m: string) => void,
  options: { compare?: boolean } = {}
): Promise<void> {
  if (!panel || !workDir) {
    return;
  }
  if (running) {
    // Dropping it left the panel showing a picture of an older buffer with
    // nothing to say it was stale - a render takes seconds, and saving twice
    // inside those seconds is normal.
    queued = { doc, options };
    return;
  }
  running = true;
  const target = panel;
  const startedFor = previewed?.toString();
  const dir = workDir;
  const sizes = viewportCount(config().get<string>("viewPreview.viewport", "1280x900"));
  const mock = mockFileFor(doc);
  try {
    paint(target, doc, { ...shown, busy: true });
    const runs: Array<{ prefix: string; caption: string; text: string }> = [];
    if (options.compare) {
      const before = await committedText(doc);
      if (target !== panel) {
        return; // closed while git was answering
      }
      if (before === undefined) {
        paint(target, doc, {
          ...shown,
          problem:
            "There is no committed version of this file to compare with - " +
            "it is outside a git repository, or git does not know it yet.",
        });
        return;
      }
      runs.push({ prefix: "head", caption: "HEAD", text: before });
    }
    runs.push({
      prefix: "now",
      caption: options.compare ? "working tree" : "",
      text: doc.getText(),
    });

    const shots: Shot[] = [];
    const errors: string[] = [];
    let problem: string | undefined;
    for (const run of runs) {
      const result = await render(
        { text: run.text, fileName: doc.fileName, mock, prefix: run.prefix },
        dir,
        log
      );
      if (target !== panel || previewed?.toString() !== startedFor) {
        // the panel went away while the browser was starting, or it was
        // pointed at another document - whose pictures these are not
        return;
      }
      problem ??= result.problem;
      errors.push(
        ...result.errors.map((e) => (run.caption ? `${run.caption}: ${e}` : e))
      );
      for (const file of result.files) {
        const label = shotLabel(file, sizes);
        shots.push({
          uri: `${target.webview.asWebviewUri(vscode.Uri.file(file))}?v=${++generation}`,
          label: run.caption ? `${run.caption} · ${label}` : label,
        });
      }
    }
    // a failed re-render keeps the last good pictures and says what went
    // wrong above them; a first render that fails has none to keep
    shown = shots.length ? { shots, errors } : shown;
    paint(target, doc, { ...shown, problem });
    log(
      `view-preview: ${shots.length} picture(s), ${errors.length} render error(s)` +
        (mock ? `, data from ${path.basename(mock)}` : "")
    );
  } catch (err) {
    // this runs from a save listener, where a rejection would land nowhere
    log(`view-preview: refresh failed - ${String(err)}`);
  } finally {
    running = false;
    const next = queued;
    queued = undefined;
    if (next && panel) {
      void refresh(next.doc, log, next.options);
    }
  }
}

/** The panel, revealed and pointed at this document. Both commands go through
 *  here so a comparison and a plain preview cannot end up in two panels
 *  fighting over one temp directory. */
function openPanel(doc: vscode.TextDocument): void {
  // a preview of another class starts from nothing: the old pictures are of
  // the old view, and keeping them up while the new ones render would show
  // the wrong app
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
      openPanel(doc);
      await refresh(doc, log);
    }),

    vscode.commands.registerCommand("abap2ui5.previewDiff", async () => {
      const doc = pickDocument();
      if (!doc || !isCheckable(doc)) {
        vscode.window.showInformationMessage(
          "abap2UI5: no view here to compare - open an ABAP class building " +
            "views with z2ui5_cl_ui5_view_builder, or a *.view.xml."
        );
        return;
      }
      openPanel(doc);
      await refresh(doc, log, { compare: true });
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
