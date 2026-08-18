import * as vscode from "vscode";
import { SapProxy } from "./proxy";
import { ActivationWatch } from "./activationwatch";
import { AppTarget, resolveReloadTrigger, ReloadTrigger, nextRecentApps } from "./previewcore";
import { OpenMode } from "./webview";
import { expandTemplate, sapClientOf, withParams } from "./urls";
import { allSystems, SystemProfile } from "./systems";
import { ModelView } from "./modelview";

import { CONFIG_SECTION } from "./settings";

export { CONFIG_SECTION };

/** How much of the log the bug report carries. Enough to hold a launch, a
 *  check and whatever went wrong after them; small enough to paste. */
const RECENT_LOG_LINES = 400;
export const TEMPLATE_KEY = "launchUrlTemplate";
export const OPEN_MODE_KEY = "openMode";
const RELOAD_KEY = "reloadOn";
/** Replaced by `reloadOn` in 0.9.0, still honoured while it is set. */
const LEGACY_RELOAD_KEY = "reloadOnSave";
/** Whether the proxy may talk to systems whose TLS certificate cannot be
 *  verified (self-signed dev systems). */
export const ALLOW_UNAUTHORIZED_KEY = "allowUnauthorizedCerts";

/** Preview parameters and the recently launched apps live in the window's
 *  state: two windows may well look at two systems in two themes. */
const THEME_STATE = "abap2ui5.theme";
const LANGUAGE_STATE = "abap2ui5.language";
const RECENT_STATE = "abap2ui5.recentApps";
const RECENT_MAX = 10;

/** What the session knows about the preview surface in the bottom panel -
 *  the concrete `PreviewViewProvider` lives in `preview.ts`. */
export interface PreviewSurface {
  show(target: AppTarget, reason?: string): Promise<void>;
  post(message: unknown): void;
  readonly isShowing: boolean;
  refreshWelcome(): void;
  clear(): void;
}

/**
 * The mutable state of one extension session, in one place with one
 * dispose( ) - what used to be a pile of module-level globals. Everything
 * created here is torn down here; `activate` registers the session itself
 * in `context.subscriptions`.
 */
export class Session implements vscode.Disposable {
  readonly proxy = new SapProxy();

  /** App currently shown (tab or panel) — the target of reload-on-save. */
  currentTarget: AppTarget | undefined;

  appPanel: vscode.WebviewPanel | undefined;

  readonly statusItem: vscode.StatusBarItem;

  readonly output: vscode.OutputChannel;

  /** The proxy's request log (View → Output → "abap2UI5 Traffic"). */
  readonly trafficOutput: vscode.OutputChannel;

  /** The live-model document, set up during activation. */
  modelView: ModelView | undefined;

  /** The panel preview surface, set up during activation. */
  previewProvider: PreviewSurface | undefined;

  /** Watches the server for an activation while the preview is stale. */
  readonly watch: ActivationWatch;

  /** Reloads whichever preview is showing - wired during activation, the
   *  activation watch fires it. */
  reloadShown: (reason?: string) => void = () => {};

  // Editor position the focus should return to after F9.
  sourceDoc: vscode.TextDocument | undefined;
  sourceSelection: vscode.Selection | undefined;
  sourceColumn: vscode.ViewColumn | undefined;
  /** Time window (ms timestamp) in which a focus switch to the app counts as
   *  the app stealing focus automatically, and is handed back. */
  bounceFocusUntil = 0;

  /** So a page made of fifty requests does not produce fifty notifications. */
  lastAuthPrompt = 0;

  constructor(readonly ctx: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("abap2UI5");
    this.trafficOutput = vscode.window.createOutputChannel("abap2UI5 Traffic");
    this.statusItem = vscode.window.createStatusBarItem(
      "abap2ui5.status",
      vscode.StatusBarAlignment.Left,
      50
    );
    this.statusItem.name = "abap2UI5";
    this.statusItem.command = "abap2ui5.reload";
    this.applyProxySettings();
    this.watch = new ActivationWatch({
      source: this.proxy,
      current: () =>
        this.currentTarget && {
          className: this.currentTarget.className,
          sapClient: sapClientOf(this.currentTarget.externalUrl),
        },
      log: (m) => this.log(m),
      reload: (reason) => this.reloadShown(reason),
    });
  }

  /**
   * The last log lines, so the bug report can carry them.
   *
   * VS Code lets an extension WRITE to an output channel and never read it
   * back, so "paste the log" meant the user finding the channel, selecting
   * all of it and hoping the interesting part had not scrolled away. Keeping
   * a bounded copy costs a few kilobytes and turns that into one command.
   */
  private readonly recent: string[] = [];

  /** Writes to the "abap2UI5" output channel (View → Output). */
  log(message: string): void {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const line = `${stamp}  ${message}`;
    this.output.appendLine(line);
    this.recent.push(line);
    if (this.recent.length > RECENT_LOG_LINES) {
      this.recent.shift();
    }
  }

  /** The recent log, oldest first - what `abap2ui5.copyDiagnostics` pastes. */
  recentLog(): string[] {
    return [...this.recent];
  }

  theme(): string {
    return this.ctx.workspaceState.get<string>(THEME_STATE, "") ?? "";
  }

  language(): string {
    return this.ctx.workspaceState.get<string>(LANGUAGE_STATE, "") ?? "";
  }

  setPreviewParam(name: "theme" | "language", value: string): Thenable<void> {
    return this.ctx.workspaceState.update(
      name === "theme" ? THEME_STATE : LANGUAGE_STATE,
      value
    );
  }

  /** The launch URL of one class on one system, with the preview's theme and
   *  language applied — both are ordinary URL parameters of the app. */
  urlFor(system: SystemProfile, className: string): string {
    return withParams(expandTemplate(system.template, className), {
      "sap-ui-theme": this.theme() || undefined,
      "sap-language": this.language() || undefined,
    });
  }

  hasLaunchUrl(): boolean {
    return allSystems().length > 0;
  }

  /** Where F9 opens the app. Only `panel` fills the panel view. */
  openMode(): OpenMode {
    const value = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<string>(OPEN_MODE_KEY, "tab");
    return value === "panel" || value === "external" ? value : "tab";
  }

  reloadTrigger(): ReloadTrigger {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const chosen = cfg.inspect<string>(RELOAD_KEY);
    const explicit =
      chosen?.workspaceFolderValue ?? chosen?.workspaceValue ?? chosen?.globalValue;
    // Nothing set: keep honouring an explicit `reloadOnSave` from an older version.
    const legacy = cfg.inspect<boolean>(LEGACY_RELOAD_KEY);
    const legacyValue =
      legacy?.workspaceFolderValue ?? legacy?.workspaceValue ?? legacy?.globalValue;
    return resolveReloadTrigger(explicit, legacyValue);
  }

  /** Reads the proxy's TLS stance from the settings - called at start and
   *  whenever `abap2ui5.allowUnauthorizedCerts` changes. Applies to the next
   *  request; connections already open are unaffected. */
  applyProxySettings(): void {
    this.proxy.allowUnauthorized = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(ALLOW_UNAUTHORIZED_KEY, true);
  }

  recentApps(): string[] {
    return this.ctx.workspaceState.get<string[]>(RECENT_STATE, []) ?? [];
  }

  rememberApp(className: string): Thenable<void> {
    return this.ctx.workspaceState.update(
      RECENT_STATE,
      nextRecentApps(this.recentApps(), className, RECENT_MAX)
    );
  }

  rememberSource(editor: vscode.TextEditor): void {
    this.sourceDoc = editor.document;
    this.sourceSelection = editor.selection;
    this.sourceColumn = editor.viewColumn;
  }

  async restoreSourceFocus(): Promise<void> {
    if (!this.sourceDoc) {
      return;
    }
    await vscode.window.showTextDocument(this.sourceDoc, {
      viewColumn: this.sourceColumn,
      selection: this.sourceSelection,
      preserveFocus: false,
    });
  }

  updateStatusItem(): void {
    if (!this.currentTarget) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text = `$(play-circle) ${this.currentTarget.className}`;
    this.statusItem.tooltip = new vscode.MarkdownString(
      `**abap2UI5 preview** — ${this.currentTarget.system}\n\n` +
        `${this.currentTarget.externalUrl}\n\nClick to reload.`
    );
    this.statusItem.show();
  }

  dispose(): void {
    this.watch.dispose();
    this.proxy.dispose();
    this.appPanel?.dispose();
    this.statusItem.dispose();
    this.output.dispose();
    this.trafficOutput.dispose();
  }
}
