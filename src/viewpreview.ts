import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
import { run } from "./childproc";
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


/** How long the checker may take before it is killed. Shorter than the render
 *  gate's limit on purpose: this one runs because somebody is LOOKING at the
 *  panel, and a preview that has not appeared in a minute has failed as a
 *  preview whatever the process is still doing. */
const PREVIEW_TIMEOUT_MS = 60_000;

/** `git show` is local and immediate; anything longer is a repository state
 *  that will not resolve itself (an index lock, a stalled credential helper). */
const GIT_TIMEOUT_MS = 15_000;

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
/** The mode the panel was opened in - a save after "Preview Diff" must
 *  re-render the comparison, not silently fall back to a plain preview. */
let lastMode: { compare?: boolean } = {};
/** Set by registerViewPreview - where the panel's tab icons live. */
let extensionUri: vscode.Uri | undefined;

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
export function mockFileFor(doc: vscode.TextDocument): string | undefined {
  if (doc.uri.scheme === "file") {
    const candidate = doc.uri.fsPath.replace(
      /\.(clas\.abap|abap|view\.xml|fragment\.xml|xml)$/i,
      ".mock.json"
    );
    if (candidate !== doc.uri.fsPath && fs.existsSync(candidate)) {
      return candidate;
    }
    return undefined;
  }
  /*
   * A class opened through ADT has nothing next to it - there is no "next
   * to". The convention still has to be usable there, or the preview of a
   * table filled by a SELECT stays empty for everyone who does not check out
   * a repository: the same file is looked for by CLASS NAME in the open
   * workspace folders, so `zcl_app.mock.json` anywhere in the project feeds
   * the picture of ZCL_APP however the class itself was opened.
   */
  const className = classNameOf(doc.getText(), doc.uri.path).toLowerCase();
  if (!className) {
    return undefined;
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const hit = findMockByName(folder.uri.fsPath, `${className}.mock.json`, 0);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/** The named mock file under a directory. Shallow on purpose - a handful of
 *  levels covers every repository layout, and walking a whole checkout on
 *  every preview would cost more than the answer is worth. */
function findMockByName(
  dir: string,
  name: string,
  depth: number
): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === name) {
      return path.join(dir, entry.name);
    }
  }
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name !== "node_modules"
    ) {
      const hit = findMockByName(path.join(dir, entry.name), name, depth + 1);
      if (hit) {
        return hit;
      }
    }
  }
  return undefined;
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
async function render(
  source: { text: string; fileName: string; mock?: string; prefix: string },
  dir: string,
  log: (m: string) => void,
  superseded: () => boolean
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

  /*
   * Same shape as the render gate, and now the same spawn: with a timeout, a
   * kill of the whole tree, and `abandoned` - a closed panel stops paying for
   * its picture. Without them a checker that hung left `running` true forever
   * - the panel said "busy" until the window was reloaded, every later save
   * only replaced the queued request, and closing the panel took the scratch
   * directory away while nothing held the child, so a Chromium tree stayed
   * behind.
   */
  const useShell = checker.cmd !== "node" && process.platform === "win32";
  const outcome = await run(
    checker.cmd === "node" ? process.execPath : checker.cmd,
    args,
    checker.cmd === "node"
      ? {
          cwd: dir,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...checker.env },
          timeoutMs: PREVIEW_TIMEOUT_MS,
          abandoned: superseded,
        }
      : {
          cwd: dir,
          env: { ...spawnEnv(), ...checker.env },
          shell: useShell,
          timeoutMs: PREVIEW_TIMEOUT_MS,
          abandoned: superseded,
        }
  );

  if (outcome.kind === "spawn-failed") {
    return {
      files: [],
      errors: [],
      problem:
        `The render gate could not be started (${checker.cmd}). ` +
        `Run "abap2UI5: Install Render Gate" once - it needs no Node ` +
        `installation of its own. (${String(outcome.error)})`,
    };
  }
  if (outcome.kind === "timeout") {
    log(`view-preview: the checker exceeded ${PREVIEW_TIMEOUT_MS} ms - killed`);
    return {
      files: [],
      errors: [],
      problem:
        `The render gate did not finish within ${Math.round(PREVIEW_TIMEOUT_MS / 1000)} ` +
        "seconds and was stopped. Saving again runs it afresh.",
    };
  }
  if (outcome.kind === "abandoned") {
    return { files: [], errors: [] };
  }

  const { stdout, stderr } = outcome;
  const files = parseScreenshotOutput(stdout);
  if (files.length) {
    return { files, errors: parseScreenshotErrors(stderr) };
  }
  log(`view-preview: no picture - ${stderr.slice(0, 400)}`);
  return {
    files: [],
    errors: [],
    /*
     * Reinstalling was the advice here, and it could not possibly help: the
     * installer fetches the bundle built from the linter commit this
     * extension pins, so running it again produces the same gate that just
     * refused the option. Saying "update it" sent people round that loop as
     * often as they were willing.
     *
     * The honest version names the one thing that does move it - a newer
     * bundle published by the linter - and points at the setting for anyone
     * who has a current checkout of their own.
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
  };
}

/** Paint what we have: pictures, the errors that came with them, or the one
 *  sentence saying why there are none. */
function paint(
  target: vscode.WebviewPanel,
  doc: vscode.TextDocument,
  state: { shots: Shot[]; errors: string[]; busy?: boolean; problem?: string },
  mock: string | undefined
): void {
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
  // Through the shared runner: under `shell: true` the path is quoted (a
  // repository under `C:\\Users\\John Smith\\...` used to break the compare
  // mode outright), and a git that never answers is killed rather than
  // holding the preview open for the rest of the session.
  return run("git", ["show", `HEAD:${relative}`], {
    cwd: folder.uri.fsPath,
    env: spawnEnv(),
    shell: process.platform === "win32",
    timeoutMs: GIT_TIMEOUT_MS,
  }).then((outcome) =>
    outcome.kind === "closed" && outcome.code === 0 ? outcome.stdout : undefined
  );
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
  // the panel went away, or was pointed at another document - whose render
  // this is not, so the child is killed instead of finishing for nobody
  const superseded = () =>
    target !== panel || previewed?.toString() !== startedFor;
  try {
    paint(target, doc, { ...shown, busy: true }, mock);
    const runs: Array<{ prefix: string; caption: string; text: string }> = [];
    if (options.compare) {
      const before = await committedText(doc);
      if (target !== panel) {
        return; // closed while git was answering
      }
      if (before === undefined) {
        paint(
          target,
          doc,
          {
            ...shown,
            problem:
              "There is no committed version of this file to compare with - " +
              "it is outside a git repository, or git does not know it yet.",
          },
          mock
        );
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
        log,
        superseded
      );
      if (superseded()) {
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
    paint(target, doc, { ...shown, problem }, mock);
    log(
      `view-preview: ${shots.length} picture(s), ${errors.length} render error(s)` +
        (mock ? `, data from ${path.basename(mock)}` : "")
    );
  } catch (err) {
    // this runs from a save listener, where a rejection would land nowhere
    log(`view-preview: refresh failed - ${String(err)}`);
  } finally {
    running = false;
    if (!panel) {
      // closed while rendering: the dispose handler left the directory to
      // this run, so the killed child could not write into a deleted path
      queued = undefined;
      disposeWorkDir();
    } else {
      const next = queued;
      queued = undefined;
      if (next) {
        void refresh(next.doc, log, next.options);
      }
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
    lastMode = {};
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
    if (extensionUri) {
      // the preview tab's own icon pair, like the app preview tab
      panel.iconPath = {
        light: vscode.Uri.joinPath(extensionUri, "media", "icon-light.svg"),
        dark: vscode.Uri.joinPath(extensionUri, "media", "icon-dark.svg"),
      };
    }
    panel.onDidDispose(() => {
      panel = undefined;
      previewed = undefined;
      shown = { shots: [], errors: [] };
      // a render still in flight is killed via its `abandoned` poll and
      // removes the directory itself when it settles - deleting it under a
      // live child recreated paths nothing ever cleaned up
      if (!running) {
        disposeWorkDir();
      }
    });
  }
  // the tab says WHICH view it shows - two classes previewed in turn are
  // otherwise indistinguishable until the panel is read
  panel.title = `Preview: ${titleOf(doc)}`;
  panel.reveal(vscode.ViewColumn.Beside, true);
}

export function registerViewPreview(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  extensionUri = context.extensionUri;
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
      lastMode = {};
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
      lastMode = { compare: true };
      await refresh(doc, log, lastMode);
    }),

    /* A save is the moment the author is done with a thought, and the render
     * costs a browser launch - so it is the trigger, not every keystroke.
     * In the mode the panel was opened in: a save after "Preview Diff" must
     * re-render the comparison, not quietly drop it. */
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (panel && previewed && doc.uri.toString() === previewed.toString()) {
        await refresh(doc, log, lastMode);
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
          await refresh(doc, log, lastMode);
        }
      }
    })
  );
  log("view-preview: command registered");
}
