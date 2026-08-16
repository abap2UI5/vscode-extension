import * as vscode from "vscode";
import * as os from "os";
import { registerMcp } from "./mcp";
import { createSystemMcpServer } from "./mcpsystem";
import { registerRenderGate } from "./rendergate";
import { findingsNow, registerViewCheck } from "./viewcheck";
import { registerXmlPreview } from "./xmlpreview";
import { registerQuickFix } from "./quickfix";
import { registerLanguageFeatures } from "./language";
import { registerCodeLens } from "./codelens";
import { classNameOf, isAppClass } from "./abap";
import { originOf } from "./urls";
import { registerAppSearch } from "./appsearch";
import { registerNewApp, registerNewProject } from "./wizard";
import { registerConvert } from "./convert";
import { registerNavMap } from "./navview";
import { registerPropertyEditor } from "./propview";
import { takeScreenshot } from "./screenshot";
import { formatTrafficLine, isRoundtrip } from "./traffic";
import { registerModelView } from "./modelview";
import { shortUrl } from "./webview";
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
} from "./systems";

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
  session.reloadShown = (reason) => reloadShownApp(session, reason);
  const log = (message: string) => session.log(message);

  // The session is the dispose chain: channels, status bar, proxy,
  // activation watch and the app tab all end with the extension.
  context.subscriptions.push(session);

  // First line of every session: which build is actually running.
  log(
    `extension ${String(context.extension.packageJSON.version ?? "?")} activated`
  );

  // Every request the embedded app makes goes through the proxy - log it
  // with its full roundtrip time, and feed the toolbar's badge with the
  // POSTs (the app's backend roundtrips).
  session.proxy.onTraffic = (entry) => {
    session.trafficOutput.appendLine(formatTrafficLine(entry));
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
      provider
    ),
    vscode.commands.registerCommand("abap2ui5.run", () =>
      runApp(session, provider)
    ),
    vscode.commands.registerCommand("abap2ui5.reload", () => {
      if (!session.currentTarget) {
        vscode.window.showInformationMessage(
          "abap2UI5: no app is running yet - press F9 in an app class."
        );
        return;
      }
      session.appPanel?.reveal(vscode.ViewColumn.Beside, true);
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
        session.appPanel.reveal(vscode.ViewColumn.Beside, false);
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
        title: "abap2UI5: run an app",
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
      const current = vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<string>(TEMPLATE_KEY, "");
      const template = await askForTemplate(current);
      if (!template) {
        return;
      }
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update(TEMPLATE_KEY, template, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage("abap2UI5: launch URL saved.");
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
      if (!isAppClass(doc.getText())) {
        return;
      }
      if (
        classNameOf(doc.getText(), doc.fileName) !==
        session.currentTarget.className
      ) {
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
      if (ed && ed.document === doc) {
        session.rememberSource(ed);
        session.bounceFocusUntil = Date.now() + 2500;
      }
      reloadShownApp(session, "Reloaded after save");
    }),
    vscode.commands.registerCommand("abap2ui5.resetCredentials", async () => {
      await clearCredentials(context);
      vscode.window.showInformationMessage(
        "abap2UI5: stored SAP credentials deleted."
      );
    }),
    vscode.commands.registerCommand("abap2ui5.showTraffic", () => {
      session.trafficOutput.show(true);
    }),
    vscode.commands.registerCommand("abap2ui5.screenshot", async () => {
      if (!session.currentTarget || !session.proxy.isRunning) {
        vscode.window.showInformationMessage(
          "abap2UI5: run an app in tab or panel mode first - the screenshot " +
            "loads it through the auth proxy."
        );
        return;
      }
      const file = await takeScreenshot(
        context,
        {
          url: session.currentTarget.frameUrl,
          className: session.currentTarget.className,
        },
        log
      );
      if (!file) {
        return;
      }
      await vscode.commands.executeCommand(
        "vscode.open",
        vscode.Uri.file(file),
        vscode.ViewColumn.Beside
      );
      const pick = await vscode.window.showInformationMessage(
        "abap2UI5: screenshot taken.",
        "Save As…"
      );
      if (pick === "Save As…") {
        const base =
          vscode.workspace.workspaceFolders?.[0]?.uri ??
          vscode.Uri.file(os.homedir());
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.joinPath(base, file.split(/[\\/]/).pop()!),
          filters: { Images: ["png"] },
        });
        if (target) {
          await vscode.workspace.fs.copy(vscode.Uri.file(file), target, {
            overwrite: true,
          });
        }
      }
    }),
    vscode.commands.registerCommand("abap2ui5.openHomepage", () =>
      vscode.env.openExternal(
        vscode.Uri.parse("https://github.com/abap2UI5/abap2UI5")
      )
    )
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
        const origin = originOf(externalUrl);
        return origin
          ? externalUrl.replace(origin, session.proxy.origin)
          : undefined;
      },
      screenshot: (className, url) =>
        takeScreenshot(context, { url, className }, log),
      log,
    },
    String(context.extension.packageJSON.version ?? "0.0.0")
  );
  context.subscriptions.push({ dispose: () => systemMcp.dispose() });

  registerNewApp(context);
  registerNewProject(context);
  registerConvert(context, log);
  registerNavMap(context, log);
  registerPropertyEditor(context, log);
  registerViewCheck(context, log);
  registerXmlPreview(context, log, findingsNow);
  registerQuickFix(context, log);
  registerLanguageFeatures(context, log);
  registerCodeLens(context);
  registerRenderGate(context, log);
  registerMcp(context, log, systemMcp);
}

export function deactivate(): void {
  // Everything is torn down through context.subscriptions - the Session's
  // dispose( ) covers the proxy, the activation watch and the app tab.
}
