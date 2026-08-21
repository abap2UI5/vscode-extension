import * as vscode from "vscode";
import { createNonce, previewHtml, welcomeHtml } from "./webview";
import { AppTarget, loadMessage, modelRootsOfSource } from "./previewcore";
import { classNameOf, errorTokens } from "./abap";
import { proxiedUrl } from "./urls";
import { allSystems } from "./systems";
import { abapNsMap, viewOutline } from "./context";
import { matchOutline, RuntimeControl } from "./inspect";
import { CONFIG_SECTION, OPEN_MODE_KEY, PreviewSurface, Session } from "./session";

/*
 * The preview surfaces: the panel view, the editor tab, and the messages
 * flowing between them and the running app. All state lives on the
 * `Session` - this module is the VS Code plumbing around it.
 */

/** The open ABAP documents, narrowed to one class when a name is given. */
export function openAbapDocs(className?: string): vscode.TextDocument[] {
  return vscode.workspace.textDocuments.filter(
    (doc) =>
      (doc.languageId === "abap" || /\.abap$/i.test(doc.fileName)) &&
      (!className || classNameOf(doc.getText(), doc.fileName) === className)
  );
}

/** The class's own top-level model paths - see `modelRootsOfSource`. */
export function modelRootsOf(className: string): string[] {
  const doc = openAbapDocs(className)[0];
  return doc ? modelRootsOfSource(doc.getText()) : [];
}

/** The load message of one target, with the session's preview parameters. */
function loadMessageFor(session: Session, target: AppTarget, reason?: string) {
  return loadMessage(
    target,
    session.theme(),
    session.language(),
    modelRootsOf(target.className),
    reason
  );
}

// ---------------------------------------------------------------------------
// Panel view (bottom)
// ---------------------------------------------------------------------------

export class PreviewViewProvider
  implements vscode.WebviewViewProvider, PreviewSurface
{
  public static readonly viewId = "abap2ui5.preview";

  private view?: vscode.WebviewView;
  /** Whether the panel is showing the app rather than the welcome screen.
   *  WHICH app is not this class's to remember - `session.currentTarget` is
   *  the one answer, and keeping a copy meant the theme or language picker
   *  updated the session while the panel reloaded from the url it had first. */
  private showsApp = false;
  private previewRendered = false;

  constructor(private readonly session: Session) {}

  /** The app this panel shows, straight from the session. */
  private get target(): AppTarget | undefined {
    return this.showsApp ? this.session.currentTarget : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.previewRendered = false;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((msg) =>
      handleWebviewMessage(this.session, msg, this.target)
    );
    // The user can take the view away (right-click the panel, uncheck it).
    // Everything below would then post to a disposed webview, which throws -
    // in the save handler, between stopping the activation watch and taking
    // its new baseline.
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.previewRendered = false;
      }
    });
    this.render();
  }

  async show(target: AppTarget, reason?: string): Promise<void> {
    this.session.currentTarget = target;
    this.showsApp = true;
    const renderedBefore = this.previewRendered;
    await vscode.commands.executeCommand(`${PreviewViewProvider.viewId}.focus`);
    // Focusing an unresolved view resolves it, and resolving renders the app -
    // which starts loading it. Rendering again here would post a load message
    // on top of that and restart the load that had just begun.
    if (!renderedBefore && this.previewRendered) {
      return;
    }
    this.render(reason);
  }

  /** Posts to the rendered preview; ignored while the welcome screen is up. */
  post(message: unknown): void {
    if (this.view && this.previewRendered) {
      void this.view.webview.postMessage(message);
    }
  }

  get isShowing(): boolean {
    return !!this.view && this.previewRendered;
  }

  /**
   * Re-renders the empty state — after the launch URL was configured, and
   * whenever the app it points at moves (launched into a tab, tab closed),
   * because that is what the text on it talks about.
   */
  refreshWelcome(): void {
    if (this.view && !this.previewRendered) {
      this.render();
    }
  }

  /** Hands the app over to the tab: back to the empty state, no reload. */
  clear(): void {
    this.showsApp = false;
    this.render();
  }

  private render(reason?: string): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const session = this.session;
    const target = this.target;
    if (!target) {
      view.webview.html = welcomeHtml({
        nonce: createNonce(),
        hasLaunchUrl: session.hasLaunchUrl(),
        openMode: session.openMode(),
        // Only a real tab is offered as a place to go to - `external` opened
        // a browser this extension no longer has a handle on.
        runningClass: session.appPanel
          ? session.currentTarget?.className
          : undefined,
      });
      this.previewRendered = false;
      return;
    }
    if (!this.previewRendered) {
      view.webview.html = previewHtml({
        ...target,
        theme: session.theme(),
        language: session.language(),
        modelRoots: modelRootsOf(target.className),
        nonce: createNonce(),
      });
      this.previewRendered = true;
    } else {
      void view.webview.postMessage(loadMessageFor(session, target, reason));
    }
  }
}

// ---------------------------------------------------------------------------
// Messages between the previews and the extension
// ---------------------------------------------------------------------------

/** Sends a message to whichever preview is showing (tab and/or panel). */
export function postToShownApp(session: Session, message: unknown): void {
  if (session.appPanel) {
    void session.appPanel.webview.postMessage(message);
  }
  session.previewProvider?.post(message);
}

/** Reloads the app shown in tab or panel without moving the focus. */
export function reloadShownApp(session: Session, reason?: string): void {
  if (!session.currentTarget) {
    return;
  }
  session.watch.stop(); // whatever loads now is current, the badge clears
  postToShownApp(session, loadMessageFor(session, session.currentTarget, reason));
  session.watch.captureBaseline(); // remember which state is shown from now on
}

/**
 * Applies a changed theme or language: both are URL parameters, so the app's
 * URLs are rebuilt and the preview reloads onto them.
 */
export async function applyPreviewParam(
  session: Session,
  name: "theme" | "language",
  value: string
): Promise<void> {
  await session.setPreviewParam(name, value);
  const target = session.currentTarget;
  if (!target) {
    return;
  }
  const system = allSystems().find((s) => s.name === target.system);
  if (!system) {
    return;
  }
  const externalUrl = session.urlFor(system, target.className);
  const frameUrl =
    (session.proxy.isRunning
      ? proxiedUrl(externalUrl, session.proxy.origin)
      : undefined) ?? externalUrl;
  session.currentTarget = { ...target, externalUrl, frameUrl };
  session.updateStatusItem();
  reloadShownApp(
    session,
    name === "theme"
      ? value
        ? `Theme: ${value}`
        : "Theme: system default"
      : value
        ? `Language: ${value}`
        : "Logon language"
  );
}

export function handleWebviewMessage(
  session: Session,
  msg: unknown,
  target: AppTarget | undefined
): void {
  const message = msg as
    | {
        type?: string;
        command?: string;
        name?: string;
        value?: string;
        kind?: string;
        text?: string;
        error?: string;
        chain?: unknown;
      }
    | undefined;
  // Inspect mode: a control was clicked in the running app.
  if (message?.type === "inspected") {
    revealInspectedControl(
      session,
      Array.isArray(message.chain) ? (message.chain as RuntimeControl[]) : []
    );
    return;
  }
  // The app answered the model-dump command.
  if (message?.type === "appModel") {
    void session.modelView?.show(target?.className ?? "APP", {
      text: message.text,
      error: message.error || undefined,
    });
    return;
  }
  if (message?.type === "openExternal" && target) {
    void vscode.env.openExternal(vscode.Uri.parse(target.externalUrl));
    return;
  }
  // A runtime error the app reported through the hook the proxy plants: the
  // output channel is where the full text lives, the toolbar badge only counts.
  if (message?.type === "runtimeError") {
    const kind =
      message.kind === "rejection"
        ? "unhandled rejection"
        : message.kind === "console"
          ? "console.error"
          : "error";
    session.log(`app ${target?.className ?? "?"}: ${kind}: ${message.text ?? ""}`);
    const located = locateErrorInSource(message.text ?? "", target?.className);
    if (located) {
      session.log(`  ↳ ${located}`);
    }
    return;
  }
  if (message?.type === "showRuntimeLog") {
    session.output.show(true);
    return;
  }
  if (message?.type === "showTraffic") {
    session.trafficOutput.show(true);
    return;
  }
  if (message?.type === "screenshot") {
    void vscode.commands.executeCommand("abap2ui5.screenshot");
    return;
  }
  if (message?.type === "param" && session.previewProvider) {
    const name = message.name === "language" ? "language" : "theme";
    void applyPreviewParam(session, name, message.value ?? "");
    return;
  }
  if (message?.type === "command" && message.command?.startsWith(`${CONFIG_SECTION}.`)) {
    void vscode.commands.executeCommand(message.command);
  }
}

/**
 * Points a runtime error back at the source that likely caused it: the error
 * text's binding paths and quoted names are searched in the running class
 * (any open document of it), and the first hit becomes a `file:line` in the
 * log - for file-scheme documents that line is clickable in the output
 * channel. Best-effort on purpose: no hit, no line.
 */
function locateErrorInSource(
  errorText: string,
  className: string | undefined
): string | undefined {
  if (!errorText) {
    return undefined;
  }
  const tokens = errorTokens(errorText);
  if (!tokens.length) {
    return undefined;
  }
  const candidates = openAbapDocs(className);
  for (const doc of candidates) {
    const text = doc.getText();
    for (const token of tokens) {
      const ix = text.indexOf(token);
      if (ix < 0) {
        continue;
      }
      const line = doc.positionAt(ix).line + 1;
      const label =
        doc.uri.scheme === "file"
          ? vscode.workspace.asRelativePath(doc.uri)
          : doc.fileName;
      return `${label}:${line}  (matched "${token}")`;
    }
  }
  return undefined;
}

/**
 * A control clicked in inspect mode, revealed in the class: the runtime
 * chain (type/id, innermost first) is matched against the view outline and
 * the winning builder call is selected. Aggregation templates come out
 * right by construction - every cloned row item matches the one call that
 * wrote the template.
 */
function revealInspectedControl(session: Session, chain: RuntimeControl[]): void {
  const className = session.currentTarget?.className;
  const doc = openAbapDocs(className)[0];
  const clicked = chain[0]?.type ?? "the control";
  if (!doc) {
    vscode.window.showInformationMessage(
      `abap2UI5: open the class ${className ?? "of the app"} to jump to the ` +
        "inspected control."
    );
    return;
  }
  const text = doc.getText();
  const node = matchOutline(viewOutline(text), abapNsMap(text), chain);
  if (!node) {
    session.log(`inspect: nothing in ${doc.fileName} matched ${clicked}`);
    vscode.window.showInformationMessage(
      `abap2UI5: could not match ${clicked} to a builder call in ` +
        `${className ?? "the class"} - is the shown app up to date?`
    );
    return;
  }
  session.log(`inspect: ${clicked} -> ${node.label}`);
  const column = vscode.window.visibleTextEditors.find(
    (editor) => editor.document === doc
  )?.viewColumn;
  void vscode.window.showTextDocument(doc, {
    viewColumn: column,
    selection: new vscode.Range(
      doc.positionAt(node.selStart),
      doc.positionAt(node.selEnd)
    ),
    preserveFocus: false,
  });
}

// ---------------------------------------------------------------------------
// Tab (editor area)
// ---------------------------------------------------------------------------

export function showInTab(session: Session, target: AppTarget): void {
  const title = `${target.className} · abap2UI5`;
  if (session.appPanel) {
    // Existing tab: just reload (or switch to the new class).
    session.appPanel.title = title;
    session.appPanel.reveal(vscode.ViewColumn.Beside, true);
    void session.appPanel.webview.postMessage(loadMessageFor(session, target));
    return;
  }
  const appPanel = vscode.window.createWebviewPanel(
    "abap2ui5.app",
    title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true }
  );
  session.appPanel = appPanel;
  appPanel.iconPath = {
    light: vscode.Uri.joinPath(session.ctx.extensionUri, "media", "icon-light.svg"),
    dark: vscode.Uri.joinPath(session.ctx.extensionUri, "media", "icon-dark.svg"),
  };
  appPanel.onDidDispose(() => {
    session.appPanel = undefined;
    session.currentTarget = undefined;
    session.updateStatusItem();
    // The panel view's empty state names the app running in the tab.
    session.previewProvider?.refreshWelcome();
  });
  // If the loading app grabs focus shortly after F9, hand it back to the code.
  appPanel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active && Date.now() < session.bounceFocusUntil) {
      void session.restoreSourceFocus();
    }
  });
  appPanel.webview.onDidReceiveMessage((msg) =>
    handleWebviewMessage(session, msg, session.currentTarget)
  );
  appPanel.webview.html = previewHtml({
    ...target,
    theme: session.theme(),
    language: session.language(),
    modelRoots: modelRootsOf(target.className),
    nonce: createNonce(),
  });
}

// ---------------------------------------------------------------------------
// Moving the preview between tab and panel
// ---------------------------------------------------------------------------

/**
 * Switches where F9 opens an app and takes the running one along.
 *
 * Both halves matter: changing the setting alone leaves the app where it is,
 * which is exactly the dead end the panel's empty state used to be — the view
 * sat there explaining F9 while F9 filled a tab somewhere else.
 */
export async function movePreview(
  session: Session,
  provider: PreviewSurface,
  to: "tab" | "panel"
): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(OPEN_MODE_KEY, to, vscode.ConfigurationTarget.Global);

  // Disposing the tab clears `currentTarget` through its dispose handler. The
  // app is not gone, it changes place, so it is put back afterwards.
  const target = session.currentTarget;

  if (to === "panel") {
    session.appPanel?.dispose();
    session.currentTarget = target;
    session.updateStatusItem();
    if (target) {
      await provider.show(target, "Moved into the panel");
    } else {
      provider.refreshWelcome();
    }
    return;
  }

  provider.clear();
  if (target) {
    showInTab(session, target);
  }
  provider.refreshWelcome();
}
