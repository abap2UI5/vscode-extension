import * as vscode from "vscode";
import * as os from "os";
import { mcpStatus, registerMcp } from "./mcp";
import { createSystemMcpServer } from "./mcpsystem";
import {
  installRenderGate,
  registerRenderGate,
  renderGateStatus,
} from "./rendergate";
import {
  baselineFileFor,
  findingsNow,
  recheckOpenDocuments,
  registerViewCheck,
} from "./viewcheck";
import { addToBaseline } from "./baselinefile";
import { clearBaselineCache } from "./lintconfig";
import { registerXmlPreview } from "./xmlpreview";
import { registerQuickFix } from "./quickfix";
import { registerLanguageFeatures } from "./language";
import { registerCodeLens } from "./codelens";
import { registerViewPreview } from "./viewpreview";
import { registerFindingsBar } from "./findingsbar";
import { registerExamples } from "./exampleview";
import { registerFindingsView } from "./findingsview";
import { registerInlineAnnotations } from "./inlineview";
import { registerAppView } from "./appview";
import { registerDiagnosticsReport } from "./diagnosticsreport";
import { classNameOf } from "./abap";
import { isAppSource, registerAppClasses } from "./appclasses";
import { proxiedUrl, shortUrl } from "./urls";
import { registerAppSearch } from "./appsearch";
import { registerNewApp, registerNewProject } from "./wizard";
import { registerConvert } from "./convert";
import { registerNavMap } from "./navview";
import { registerPropertyEditor } from "./propview";
import { takeScreenshot } from "./screenshot";
import { formatTrafficLine, isRoundtrip } from "./traffic";
import { registerModelView } from "./modelview";
import { DEVICE_WIDTHS } from "./webview";
import { staleMessage } from "./previewcore";
import {
  ALLOW_UNAUTHORIZED_KEY,
  CONFIG_SECTION,
  OPEN_MODE_KEY,
  Session,
  TEMPLATE_KEY,
} from "./session";
import {
  movePreview,
  postToShownApp,
  PreviewViewProvider,
  reloadShownApp,
} from "./preview";
import {
  activateAndReload,
  checkConnection,
  makeConnectSystem,
  runApp,
  watchProxyStatus,
} from "./launch";
import {
  activeSystem,
  allSystems,
  askForTemplate,
  clearCredentials,
  pickSystem,
  storeTemplate,
} from "./systems";

/** Where the screenshot Save As dialog last saved to, per window. */
const SHOT_DIR_STATE = "abap2ui5.screenshotSaveDir";

/*
 * Desktop activation: builds the session (all mutable state, one dispose),
 * wires the preview surfaces and the proxy, and registers every command.
 * The interesting logic lives in the modules this one calls -
 * `previewcore.ts` / `activationwatch.ts` are `vscode`-free and unit-tested,
 * `session.ts` / `preview.ts` / `launch.ts` are the VS Code plumbing.
 */

export function activate(context: vscode.ExtensionContext): void {
  const session = new Session(context);
  const provider = new PreviewViewProvider(session);
  session.previewProvider = provider;
  // The activation watch's reload. `bounceFocus` like the save path and
  // Ctrl+F3: the user is in the editor - they just activated a class - and a
  // loading app grabbing focus would yank them out of it on exactly the
  // reload this extension exists to automate.
  session.reloadShown = (reason) =>
    reloadShownApp(session, reason, { bounceFocus: true });
  session.notifyShown = (message) => postToShownApp(session, message);
  const log = (message: string) => session.log(message);
  // What a "Show Log" button on a message does - the channel the message's
  // "see the output channel" points at, one click away.
  const showLog = () => session.output.show(true);

  // The session is the dispose chain: channels, status bar, proxy,
  // activation watch and the app tab all end with the extension.
  context.subscriptions.push(session);

  // First line of every session: which build is actually running.
  log(
    `extension ${String(context.extension.packageJSON.version ?? "?")} activated`
  );

  // Every request the embedded app makes goes through the proxy - log it
  // with its full roundtrip time, and feed the toolbar's badge with the
  // POSTs (the app's backend roundtrips). The same lines feed a bounded
  // ring so the system MCP server's `get_traffic` can hand an agent what
  // the traffic channel shows - an output channel cannot be read back.
  const TRAFFIC_RING_CAP = 200;
  const trafficRing: string[] = [];
  session.proxy.onTraffic = (entry) => {
    const line = formatTrafficLine(entry);
    session.trafficOutput.appendLine(line);
    trafficRing.push(line);
    if (trafficRing.length > TRAFFIC_RING_CAP) {
      trafficRing.shift();
    }
    if (isRoundtrip(entry)) {
      postToShownApp(session, { type: "roundtrip", ms: entry.durationMs });
    }
  };

  watchProxyStatus(session);
  session.modelView = registerModelView(context, log);
  session.updateStatusItem();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      PreviewViewProvider.viewId,
      provider,
      // The running app - its server session, whatever popup or detail page it
      // navigated to - would otherwise be torn down and reloaded from scratch
      // on every Ctrl+J, and messages posted while the panel was hidden went
      // nowhere. The tab surface has kept its context for the same reason.
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    // The optional class name serves the welcome screen's one-click relaunch;
    // the palette, F9 and the CodeLens pass nothing and keep the editor path.
    vscode.commands.registerCommand("abap2ui5.run", (className?: unknown) =>
      runApp(
        session,
        provider,
        typeof className === "string" ? className : undefined
      )
    ),
    vscode.commands.registerCommand("abap2ui5.reload", () => {
      if (!session.currentTarget) {
        vscode.window.showInformationMessage(
          "abap2UI5: no app is running yet - press F9 in an app class."
        );
        return;
      }
      // both surfaces, not just the tab - an app reloading in a hidden
      // panel looked like the command doing nothing at all
      if (session.appPanel) {
        session.appPanel.reveal(undefined, true);
      } else {
        provider.reveal();
      }
      reloadShownApp(session);
    }),
    vscode.commands.registerCommand("abap2ui5.activate", () =>
      activateAndReload(session)
    ),
    vscode.commands.registerCommand("abap2ui5.previewInPanel", () =>
      movePreview(session, provider, "panel")
    ),
    vscode.commands.registerCommand("abap2ui5.previewInTab", () =>
      movePreview(session, provider, "tab")
    ),
    // Where the app is depends on the open mode, so "show me the app" is a
    // command rather than something the user has to go looking for.
    vscode.commands.registerCommand("abap2ui5.revealApp", async () => {
      if (session.appPanel) {
        // where it is, not Beside: a column would move the tab
        session.appPanel.reveal(undefined, false);
        return;
      }
      if (provider.isShowing) {
        await vscode.commands.executeCommand(`${PreviewViewProvider.viewId}.focus`);
        return;
      }
      vscode.window.showInformationMessage(
        "abap2UI5: no app is running yet - press F9 in an app class."
      );
    }),
    // Launching does not need the class open: after the first F9 the app is
    // one command away from anywhere, which is what a preview next to a test
    // or a helper class actually needs.
    vscode.commands.registerCommand("abap2ui5.runRecent", async () => {
      const recent = session.recentApps();
      if (!recent.length) {
        vscode.window.showInformationMessage(
          "abap2UI5: no app launched yet in this window - press F9 in an app class."
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(recent, {
        title: "abap2UI5: Run a Recently Launched App",
        placeHolder: "Recently launched in this window",
      });
      if (pick) {
        await runApp(session, provider, pick);
      }
    }),
    vscode.commands.registerCommand("abap2ui5.selectSystem", async () => {
      const system = await pickSystem(context);
      if (!system) {
        return;
      }
      provider.refreshWelcome();
      log(`system: now launching against ${system.name}`);
      if (session.currentTarget) {
        // Same app, other system - relaunch instead of reloading a URL that
        // no longer points where the user is looking.
        await runApp(session, provider, session.currentTarget.className);
      } else {
        vscode.window.showInformationMessage(
          `abap2UI5: launching against ${system.name}.`
        );
      }
    }),
    vscode.commands.registerCommand("abap2ui5.setLaunchUrl", async () => {
      // Edit the ACTIVE system, wherever it is stored. Writing the single
      // `launchUrlTemplate` while a profile list is configured did not edit
      // anything - it grew an extra system next to the one on screen.
      const active = activeSystem(context);
      const current =
        active?.template ??
        vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>(TEMPLATE_KEY, "");
      const template = await askForTemplate(current);
      if (!template) {
        return;
      }
      await storeTemplate(active?.name ?? shortUrl(template), template);
      vscode.window.showInformationMessage(
        `abap2UI5: launch URL of ${active?.name ?? shortUrl(template)} saved.`
      );
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${CONFIG_SECTION}.${TEMPLATE_KEY}`) ||
        e.affectsConfiguration(`${CONFIG_SECTION}.systems`) ||
        // The empty state says where F9 opens the app - that is this setting.
        e.affectsConfiguration(`${CONFIG_SECTION}.${OPEN_MODE_KEY}`)
      ) {
        provider.refreshWelcome();
      }
      if (
        e.affectsConfiguration(`${CONFIG_SECTION}.${ALLOW_UNAUTHORIZED_KEY}`)
      ) {
        session.applyProxySettings();
      }
    }),
    // Shown app's class saved. A save alone does not change anything on the
    // server - the object has to be activated - so by default the preview only
    // says so instead of reloading.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== "abap" || !session.currentTarget) {
        return;
      }
      if (!session.appPanel && !provider.isShowing) {
        return;
      }
      const trigger = session.reloadTrigger();
      if (trigger === "never") {
        return;
      }
      // The cheap name check first: it dismisses every save of another class
      // before the full app-source scan runs.
      const text = doc.getText();
      if (classNameOf(text, doc.fileName) !== session.currentTarget.className) {
        return;
      }
      if (!isAppSource(text)) {
        return;
      }
      if (trigger === "activation") {
        postToShownApp(session, staleMessage("Saved - activate to update"));
        // Notice the activation itself — however it is done — and reload
        // then. Deliberately not limited to a URI scheme: whichever way the
        // source reaches the server, the server knows whether an inactive
        // version exists.
        session.watch.start();
        return;
      }
      // Keep focus in the code in case the reloading app tries to grab it.
      const ed = vscode.window.activeTextEditor;
      const inSavedSource = !!ed && ed.document === doc;
      if (inSavedSource) {
        session.rememberSource(ed);
      }
      reloadShownApp(session, "Reloaded after save", {
        bounceFocus: inSavedSource,
      });
    }),
    // The white-preview diagnosis: probes the configured launch URL the way
    // F9 would and says which step fails (URL, host, logon, ICF path, page).
    vscode.commands.registerCommand("abap2ui5.checkConnection", () =>
      checkConnection(session)
    ),
    vscode.commands.registerCommand("abap2ui5.resetCredentials", async () => {
      await clearCredentials(context);
      vscode.window.showInformationMessage(
        "abap2UI5: stored SAP credentials deleted."
      );
    }),
    vscode.commands.registerCommand("abap2ui5.showTraffic", () => {
      session.trafficOutput.show(true);
    }),
    // `device` comes from the preview toolbar, so the PNG matches the width
    // the user is looking at; the palette passes nothing and gets desktop.
    vscode.commands.registerCommand("abap2ui5.screenshot", async (device?: unknown) => {
      if (!session.currentTarget || !session.proxy.isRunning) {
        vscode.window.showInformationMessage(
          "abap2UI5: run an app in tab or panel mode first - the screenshot " +
            "loads it through the auth proxy."
        );
        return;
      }
      // the same numbers the preview stage frames the app with
      const widths: Record<string, number | undefined> = DEVICE_WIDTHS;
      const width = typeof device === "string" ? widths[device] : undefined;
      const file = await takeScreenshot(
        context,
        {
          // A one-shot url: Chromium takes the page only as a command line
          // argument, which every process of this user can read.
          url: session.proxy.singleUseUrl(session.currentTarget.frameUrl),
          className: session.currentTarget.className,
          width,
        },
        log,
        showLog
      );
      if (!file) {
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(file),
        vscode.ViewColumn.Beside
      );
      const fileName = file.split(/[\\/]/).pop()!;
      const pick = await vscode.window.showInformationMessage(
        `abap2UI5: screenshot saved as ${fileName}.`,
        "Save As…"
      );
      if (pick === "Save As…") {
        // the dialog starts where the last screenshot was saved to - the
        // second save of a session is usually to the same place as the first
        const remembered = context.workspaceState.get<string>(SHOT_DIR_STATE);
        const base = remembered
          ? vscode.Uri.file(remembered)
          : (vscode.workspace.workspaceFolders?.[0]?.uri ??
            vscode.Uri.file(os.homedir()));
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(base, fileName),
          filters: { Images: ["png"] },
        });
        if (target) {
          await vscode.workspace.fs.copy(vscode.Uri.file(file), target, {
            overwrite: true,
          });
          await context.workspaceState.update(
            SHOT_DIR_STATE,
            vscode.Uri.joinPath(target, "..").fsPath
          );
        }
      }
    }),
    vscode.commands.registerCommand("abap2ui5.openHomepage", () =>
      vscode.env.openExternal(
        vscode.Uri.parse("https://github.com/abap2UI5/abap2UI5")
      )
    ),
    // The status-bar item's click: everything one does WITH a running
    // preview, in one QuickPick, instead of five commands to remember.
    vscode.commands.registerCommand("abap2ui5.previewMenu", async () => {
      const target = session.currentTarget;
      const mode = session.openMode();
      type Action = vscode.QuickPickItem & { run(): Thenable<unknown> | void };
      const items: Action[] = [
        {
          label: "$(refresh) Reload",
          description: target?.className,
          run: () => vscode.commands.executeCommand("abap2ui5.reload"),
        },
        mode === "panel"
          ? {
              label: "$(window) Move Preview to an Editor Tab",
              run: () => vscode.commands.executeCommand("abap2ui5.previewInTab"),
            }
          : {
              label: "$(layout-panel) Move Preview to the Panel",
              run: () => vscode.commands.executeCommand("abap2ui5.previewInPanel"),
            },
        {
          label: "$(link-external) Open in Browser",
          description: target ? shortUrl(target.externalUrl) : undefined,
          run: () =>
            target
              ? vscode.env.openExternal(vscode.Uri.parse(target.externalUrl))
              : vscode.window.showInformationMessage(
                  "abap2UI5: no app is running yet - press F9 in an app class."
                ),
        },
        {
          label: "$(device-camera) Take App Screenshot",
          run: () => vscode.commands.executeCommand("abap2ui5.screenshot"),
        },
        {
          label: "$(plug) Check System Connection",
          run: () => vscode.commands.executeCommand("abap2ui5.checkConnection"),
        },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: "abap2UI5: Preview Actions",
        placeHolder: target
          ? `${target.className} on ${target.system}`
          : "No app is running - press F9 in an app class to start one",
        // typing the class name or the host finds its action too
        matchOnDescription: true,
      });
      await pick?.run();
    }),
    // Reinstall the render gate on demand - and say first what is installed:
    // the pinned linter commit and the remembered bundle digest are what a
    // bug report about a render-gate finding needs.
    vscode.commands.registerCommand("abap2ui5.updateRenderGate", async () => {
      const status = renderGateStatus(context);
      log(
        `render-gate: ${status.installed ? "installed" : "not installed"} - ` +
          `pinned linter commit ${
            status.pinnedCommit ? status.pinnedCommit.slice(0, 12) : "none (dev build)"
          }, stored bundle digest ${
            status.storedDigest
              ? `${status.storedDigest.slice(0, 12)}…`
              : "none (nothing downloaded from this URL yet)"
          }`
      );
      log(`render-gate: bundle URL ${status.bundleUrl}`);
      const installed = await installRenderGate(context, log, showLog);
      // success and failure already speak for themselves (installRenderGate
      // shows both); the log ties the outcome to the digests above
      log(
        installed
          ? "render-gate: update finished"
          : "render-gate: update did not complete - see the messages above"
      );
    })
  );

  const connectSystem = makeConnectSystem(session);

  registerAppSearch(context, {
    proxy: session.proxy,
    connect: connectSystem,
    run: (className) => runApp(session, provider, className),
    recent: () => session.recentApps(),
    log,
  });

  // The system MCP server: the extension's systems, credentials and proxy,
  // offered to AI agents as tools (list/search/run-with-screenshot).
  const systemMcp = createSystemMcpServer(
    {
      listSystems: () => ({
        active: activeSystem(context)?.name,
        systems: allSystems().map((s) => ({
          name: s.name,
          host: shortUrl(s.template),
        })),
      }),
      connect: connectSystem,
      proxy: session.proxy,
      frameUrlFor: (className) => {
        const system = activeSystem(context);
        if (!system || !session.proxy.isRunning) {
          return undefined;
        }
        const externalUrl = session.urlFor(system, className);
        return proxiedUrl(externalUrl, session.proxy.origin);
      },
      screenshot: (className, url, viewport) =>
        takeScreenshot(
          context,
          {
            // same one-shot url as the command above - the token must not
            // stay valid in an argument vector
            url: session.proxy.singleUseUrl(url),
            className,
            width: viewport?.width,
            height: viewport?.height,
          },
          log,
          showLog
        ),
      recentTraffic: () => [...trafficRing],
      log,
    },
    String(context.extension.packageJSON.version ?? "0.0.0")
  );
  context.subscriptions.push({ dispose: () => systemMcp.dispose() });

  // What the MCP registration resolved - the answer to "why does my agent
  // not see the abap2UI5 tools". The system server's URL is shown as origin
  // only: the token path segment authorizes acting with the stored system
  // credentials and belongs in no message or log.
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.showMcpStatus", () => {
      const status = mcpStatus();
      const stdio = status.stdioEnabled
        ? `${status.stdioCommand.join(" ")} (from ${status.stdioSource})`
        : "disabled (abap2ui5.mcp.enabled is off)";
      const systemUrl = systemMcp.currentUrl();
      const systemOrigin = (() => {
        if (!systemUrl) {
          return undefined;
        }
        try {
          return new URL(systemUrl).origin;
        } catch {
          return undefined;
        }
      })();
      const system = !status.systemEnabled
        ? "disabled (abap2ui5.mcp.system is off)"
        : systemOrigin
          ? `running on ${systemOrigin}`
          : "enabled, not started yet (starts when an MCP client asks for it)";
      log(`mcp: status - stdio server: ${stdio}`);
      const envEntries = Object.entries(status.env);
      if (status.stdioEnabled && envEntries.length) {
        log(
          `mcp: status - checkout env: ${envEntries
            .map(([key, value]) => `${key}=${value}`)
            .join(", ")}`
        );
      }
      log(`mcp: status - system server: ${system}`);
      void vscode.window
        .showInformationMessage(
          `abap2UI5 MCP - stdio server: ${stdio}; system server: ${system}. ` +
            "Details in the abap2UI5 output channel.",
          "Show Log"
        )
        .then((pick) => {
          if (pick === "Show Log") {
            showLog();
          }
        });
    })
  );

  // before the features that ask it whether a class is an app - an app that
  // inherits z2ui5_if_app is only recognised once the window's classes are
  // indexed (issue #81)
  registerAppClasses(context);
  registerNewApp(context);
  registerNewProject(context);
  registerConvert(context, log);
  registerNavMap(context, log);
  registerPropertyEditor(context, log);
  registerViewCheck(context, log, showLog);
  registerXmlPreview(context, log, findingsNow);
  registerViewPreview(context, log);
  registerQuickFix(context, log);
  registerLanguageFeatures(context, log);
  registerCodeLens(context);
  registerFindingsBar(context);
  registerExamples(context, log);
  registerFindingsView(context, findingsNow, {
    // the desktop-only baseline machinery, injected so the view itself stays
    // web-safe (see findingsview.ts)
    baselineFileFor,
    addToBaseline,
    clearBaselineCache,
    recheckOpenDocuments,
  });
  registerInlineAnnotations(context, log);
  registerAppView(context);
  registerDiagnosticsReport(context, session);
  registerRenderGate(context, log, showLog);
  registerMcp(context, log, systemMcp);
}

export function deactivate(): void {
  // Everything is torn down through context.subscriptions - the Session's
  // dispose( ) covers the proxy, the activation watch and the app tab.
}
