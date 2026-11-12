import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { classNameOf } from "./abap";
import { CONFIG_SECTION } from "./settings";
import { SERVER_DIRS } from "./repolayout";
import { proxiedUrl } from "./urls";
import { FOCUS_BOUNCE_MS, PreviewSurface, Session } from "./session";
import { postToShownApp, reloadShownApp, showInTab } from "./preview";
import { AppTarget, staleMessage } from "./previewcore";
import { SystemProfile } from "./systems";
import {
  decideStart,
  HostIdentity,
  LAUNCHER_FILE,
  launcherEnv,
  LocalBackendAuth,
  LocalHost,
  localTemplate,
  mockNote,
  newToken,
  projectRootFor,
  resolveLocalHost,
  runtimePinFor,
  sourceFingerprint,
  sourceFolderFor,
  startLocalHost,
} from "./localbackend";

/*
 * The "Local (transpiled)" system - the plumbing around `localbackend.ts`.
 *
 * F9 on that profile builds the folder the class lives in (abapGit's
 * STARTING_FOLDER, else src) with mcp-server's npm backend, (re)starts the
 * host, points the auth proxy at it with the host's token as its
 * `AuthStrategy`, and loads `/?app_start=<CLASS>` through the proxy into the
 * usual preview - so the inspector, the live model and the traffic log work
 * as they do against a system. A save of a class in the built folder (with
 * `abap2ui5.reloadOn` not `never`) and Ctrl+F3 rebuild, restart and reload: there
 * is no activation here, the file on disk IS the version.
 *
 * Desktop only (it spawns a process), never in Restricted Mode (it runs the
 * repository's code), one host per window, stopped with the session, on a
 * system switch and when the window closes. The build log goes to the
 * "abap2UI5 Local Backend" output channel.
 */

interface Running extends HostIdentity {
  host: LocalHost;
  token: string;
  /** The folder it was built from. */
  folder: string;
}

let output: vscode.OutputChannel | undefined;
let running: Running | undefined;
/** One start at a time; a second F9 waits for the first and then decides. */
let queue: Promise<unknown> = Promise.resolve();
let context: vscode.ExtensionContext | undefined;

function channel(): vscode.OutputChannel {
  output ??= vscode.window.createOutputChannel("abap2UI5 Local Backend");
  return output;
}

function serialize<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op, op);
  queue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/** Wires the controller's lifetime to the extension's. */
export function registerLocalBackend(ctx: vscode.ExtensionContext): void {
  context = ctx;
  ctx.subscriptions.push({
    dispose: () => {
      stopLocalBackend("the window closed");
      output?.dispose();
      output = undefined;
    },
  });
}

/** Stops the host, if one runs. */
export function stopLocalBackend(why: string): void {
  if (running) {
    channel().appendLine(`stopped (${why})`);
    running.host.stop();
    running = undefined;
  }
}

/** Whether the shown app runs on the local backend. */
export function isLocalTarget(target: AppTarget | undefined): boolean {
  return !!target && !!running && target.externalUrl.startsWith(`${running.host.origin}/`);
}

/** Whether a saved file belongs to what the running host was built from. */
export function isInBuiltFolder(file: string): boolean {
  if (!running) {
    return false;
  }
  const rel = path.relative(running.folder, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The class's file on disk: the active editor when it holds the class,
 *  else the workspace's `<class>.clas.abap`. */
async function classFileFor(className: string): Promise<string | undefined> {
  const doc = vscode.window.activeTextEditor?.document;
  if (
    doc &&
    doc.uri.scheme === "file" &&
    /\.clas\.abap$/i.test(doc.fileName) &&
    classNameOf(doc.getText(), doc.fileName).toUpperCase() === className.toUpperCase()
  ) {
    return doc.uri.fsPath;
  }
  const hits = await vscode.workspace.findFiles(
    `**/${className.toLowerCase()}.clas.abap`,
    "**/node_modules/**",
    1
  );
  return hits[0]?.fsPath;
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function showFailure(message: string): void {
  void vscode.window
    .showErrorMessage(`abap2UI5: the local backend did not start - ${message}`, "Show Log")
    .then((pick) => {
      if (pick === "Show Log") {
        channel().show(true);
      }
    });
}

/**
 * Builds and (re)starts the host for a class, or reuses the running one.
 * Undefined when it did not start (the reason was shown).
 */
async function ensureHost(
  session: Session,
  className: string,
  force: boolean
): Promise<Running | undefined> {
  const ctx = context ?? session.ctx;
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage(
      "abap2UI5: the local backend runs this workspace's code - it is not started in Restricted Mode. Trust the workspace to use it."
    );
    return undefined;
  }
  const classFile = await classFileFor(className);
  if (!classFile) {
    void vscode.window.showErrorMessage(
      `abap2UI5: the local backend builds the classes of this workspace's folders - no ${className.toLowerCase()}.clas.abap was found in them.`
    );
    return undefined;
  }
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(classFile))?.uri.fsPath;
  const projectRoot = projectRootFor(classFile, workspaceRoot, fs.existsSync);
  const source = sourceFolderFor({
    projectRoot,
    classFile,
    abapgitXml: readText(path.join(projectRoot, ".abapgit.xml")),
    exists: fs.existsSync,
  });

  // the build reads the disk: what is typed and not saved would be missed
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.scheme === "file" && doc.uri.fsPath.startsWith(source.folder)) {
      await doc.save();
    }
  }

  const pin = String(
    (ctx.extension.packageJSON as { localBackend?: { mcpServer?: string } }).localBackend?.mcpServer ?? ""
  );
  const command = resolveLocalHost({
    reposRoot: vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("mcp.reposRoot", ""),
    serverDirs: SERVER_DIRS,
    pin,
    launcher: path.join(ctx.extensionPath, "dist", LAUNCHER_FILE),
    exists: fs.existsSync,
  });
  const runtime = runtimePinFor(readText(path.join(projectRoot, "abaplint.jsonc")));
  const wanted: HostIdentity = {
    key: JSON.stringify([command.cmd, command.args, command.env, source.folder, runtime.version ?? ""]),
    fingerprint: sourceFingerprint(source.folder),
  };
  const decision = decideStart(
    running && { key: running.key, fingerprint: running.fingerprint, alive: running.host.alive },
    wanted,
    force
  );
  const log = channel();
  if (decision === "reuse" && running) {
    log.appendLine(`reused: nothing changed under ${source.folder} since the last build`);
    return running;
  }

  const previousPort = running?.host.port;
  stopLocalBackend(decision === "restart" ? "rebuilding" : "replaced");
  log.appendLine("");
  log.appendLine(`build: ${source.folder} (${source.from}) for ${className}`);
  log.appendLine(`mcp-server: ${command.from} (${command.source})`);
  if (runtime.note) {
    log.appendLine(`framework: ${runtime.note}`);
  } else {
    log.appendLine(`framework: @abap2ui5/node-runtime ${runtime.version} (the project's abaplint.jsonc pin)`);
  }
  const mock = mockNote(classFile, fs.existsSync);
  if (mock) {
    log.appendLine(`mock data: ${mock}`);
  }
  const workspace = path.join(ctx.globalStorageUri.fsPath, "local-backend");
  fs.mkdirSync(workspace, { recursive: true });
  const token = newToken();
  try {
    const host = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `abap2UI5: building ${className} for the local backend`,
      },
      (progress) =>
        startLocalHost(command, {
          cwd: projectRoot,
          env: launcherEnv({
            base: process.env,
            command,
            token,
            source: source.folder,
            workspace,
            port: previousPort,
            runtime: runtime.version,
          }),
          onLog: (line) => {
            log.appendLine(line);
            if (/^(transpile|open-abap-core|runtime|local backend):/.test(line)) {
              progress.report({ message: line.slice(0, 120) });
            }
          },
        })
    );
    log.appendLine(`ready: ${host.origin} - ${host.banner}`);
    session.log(`local backend: ready on ${host.origin} (@abap2ui5/node-runtime ${host.runtime})`);
    running = { ...wanted, host, token, folder: source.folder };
    const started = running;
    void host.exited.then((code) => {
      if (running === started) {
        log.appendLine(`the local backend ended (exit code ${code ?? "none"})`);
        running = undefined;
      }
    });
    return running;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // the build log is in the channel already, line by line
    log.appendLine(`failed: ${reason}`);
    session.log(`local backend: not started - ${reason}`);
    showFailure(reason);
    return undefined;
  }
}

/** Points the proxy at the host and builds the app's two urls. */
async function targetFor(
  session: Session,
  system: SystemProfile,
  className: string,
  host: Running
): Promise<AppTarget> {
  await session.proxy.start(host.host.origin, new LocalBackendAuth(host.token));
  const externalUrl = session.urlFor({ ...system, template: localTemplate(host.host.port) }, className);
  const frameUrl = proxiedUrl(externalUrl, session.proxy.origin) ?? externalUrl;
  return { className, frameUrl, externalUrl, system: system.name };
}

/** F9 on the local profile. */
export function runLocal(
  session: Session,
  provider: PreviewSurface,
  system: SystemProfile,
  className: string,
  editor: vscode.TextEditor | undefined
): Promise<void> {
  return serialize(async () => {
    session.log(`run: ${className} on ${system.name}`);
    const host = await ensureHost(session, className, false);
    if (!host) {
      return;
    }
    let target: AppTarget;
    try {
      target = await targetFor(session, system, className, host);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      session.log(`run: could not start the proxy - ${reason}`);
      vscode.window.showErrorMessage(`abap2UI5: could not start the proxy - ${reason}`);
      return;
    }
    // the host answers only through the proxy: an external browser would
    // carry no token, so "external" opens the tab here
    let mode = session.openMode();
    if (mode === "external") {
      session.log("run: the local backend is shown in the tab - an external browser cannot reach it");
      mode = "tab";
    }
    if (editor) {
      session.rememberSource(editor);
    } else {
      session.forgetSource();
    }
    session.bounceFocusUntil = Date.now() + FOCUS_BOUNCE_MS;
    // no activation watch: there is no ADT here, a save rebuilds instead
    session.watch.stop();
    if (mode === "panel") {
      session.appPanel?.dispose();
    } else {
      provider.clear();
    }
    session.currentTarget = target;
    session.updateStatusItem();
    if (mode === "panel") {
      await provider.show(target);
    } else {
      showInTab(session, target);
      provider.refreshWelcome();
    }
    await session.rememberApp(className);
    await session.restoreSourceFocus();
  });
}

/**
 * A save in the built folder or Ctrl+F3 while a local app is shown: rebuild,
 * restart, reload. The host keeps its port when it can, so the proxy and the
 * shown url stay; when it could not, the app is relaunched on the new one.
 */
export function rebuildAndReload(session: Session, reason: string): Promise<void> {
  return serialize(async () => {
    const target = session.currentTarget;
    if (!target || !isLocalTarget(target)) {
      return;
    }
    postToShownApp(session, staleMessage("Rebuilding in the local backend..."));
    const host = await ensureHost(session, target.className, true);
    if (!host || session.currentTarget !== target) {
      return;
    }
    const system = { name: target.system, template: localTemplate(host.host.port), local: true as const };
    const next = await targetFor(session, system, target.className, host);
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      session.rememberSource(editor);
    }
    // the same urls when the host kept its port; new ones (a restarted
    // proxy) when it could not - the reload loads whichever is current
    session.currentTarget = next;
    session.updateStatusItem();
    // keepWatch: no activation watch and no class-state baseline here -
    // there is no ADT behind the local backend
    session.watch.stop();
    reloadShownApp(session, reason, { bounceFocus: true, keepWatch: true });
  });
}
