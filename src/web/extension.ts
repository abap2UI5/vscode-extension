import * as vscode from "vscode";
import { setSnapshotText, snapshotError } from "../snapshot";
import { clientApiError, setClientApiText } from "../clientapi";
import { registerLanguageFeatures } from "../language";
import { registerXmlPreview } from "../xmlpreview";
import { registerWebCheck, webFindingsNow } from "../webcheck";
import { registerNewApp, registerNewProject } from "../wizard";
import { registerAgentSetup } from "../agentsetupview";
import { registerConvert } from "../convert";
import { registerNavMap } from "../navview";
import { registerPropertyEditor } from "../propview";
import { registerFindingsView } from "../findingsview";
import { seedLinterData } from "./linterdata";
import { DataGate, startWeb } from "./startup";

/*
 * The web extension host entry (vscode.dev, github.dev, browser-based SAP
 * Business Application Studio).
 *
 * Everything here is the in-process half of the extension: the UI5 metadata
 * snapshot, the property gate, completion/hover, binding paths, the view
 * outline, event navigation, the reconstructed XML, the navigation map, the
 * Control Properties view and the findings tree - none of it needs a
 * process, a socket or `fs`. What stays desktop-only is everything that
 * does: the embedded preview with its auth proxy, the ADT integration, the
 * render gate and the MCP server. `package.json` hides those commands from
 * the palette when `isWeb`.
 *
 * The snapshot ships as `dist/properties.json` and is read here through
 * `vscode.workspace.fs` - the browser host's way to the extension's own
 * files.
 */

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const output = vscode.window.createOutputChannel("abap2UI5");
  context.subscriptions.push(output);
  const log = (message: string) => {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    output.appendLine(`${stamp}  ${message}`);
  };
  log(
    `extension ${String(context.extension.packageJSON.version ?? "?")} ` +
      "activated (web build - language features and property gate)"
  );

  // The data reads go out together - each is a round trip to the browser
  // host's file system, and none depends on another - and AFTER the
  // registrations (`startWeb`): every command, provider and view used to
  // wait for the slowest of the three. The gate alone is held until they
  // are in (`DataGate`): a check that ran before would cache an empty icon
  // registry in the linter for the session. Completion and hover tolerate
  // an unloaded snapshot (no offers) and pick the data up when it lands.
  const readPackaged = async (...segments: string[]) =>
    new TextDecoder().decode(
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(context.extensionUri, ...segments)
      )
    );
  const load = () => Promise.all([
    readPackaged("dist", "properties.json").then(
      (text) => {
        setSnapshotText(text);
        return snapshotError()
          ? `web: the bundled UI5 metadata could not be parsed (${snapshotError()})`
          : undefined;
      },
      (err: unknown) =>
        "web: dist/properties.json could not be read - the property gate and " +
        `completion have no metadata (${err instanceof Error ? err.message : String(err)})`
    ),
    // the z2ui5_if_client reference behind the `client->` completion and hover
    readPackaged("dist", "client-api.json").then(
      (text) => {
        setClientApiText(text);
        return clientApiError()
          ? `web: the bundled client API could not be parsed (${clientApiError()})`
          : undefined;
      },
      (err: unknown) =>
        "web: dist/client-api.json could not be read - the client-> completion " +
        `and hover have no reference (${err instanceof Error ? err.message : String(err)})`
    ),
    // the linter's icon data, before the first check can cache an empty registry
    seedLinterData((packaged) => readPackaged(...packaged)).then((unseeded) =>
      unseeded.map(
        (failure) =>
          `web: the linter's data file could not be read - its rules report nothing (${failure})`
      )
    ),
  ]).then(([snapshotFailure, clientApiFailure, unseeded]) => [
    snapshotFailure,
    clientApiFailure,
    ...unseeded,
  ]);

  const gate = new DataGate();
  const register = () => {
    registerLanguageFeatures(context, log);
    registerWebCheck(context, log, gate);
    registerXmlPreview(context, log, webFindingsNow);
    registerNewApp(context);
    registerNewProject(context);
    registerAgentSetup(context);
    registerConvert(context, log);
    // The three surfaces that needed nothing a browser host lacks: the
    // navigation map (workspace scan through workspace.fs), the Control
    // Properties view (a form over the bundled snapshot) and the findings tree
    // (the published diagnostics, with the web gate as its re-check source; no
    // baseline machinery - that is a file on disk).
    registerNavMap(context, log);
    registerPropertyEditor(context, log);
    registerFindingsView(context, webFindingsNow);

    context.subscriptions.push(
      vscode.commands.registerCommand("abap2ui5.openHomepage", () =>
        vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/abap2UI5/abap2UI5")
        )
      )
    );
  };
  // the registrations are done before the first await; the activation
  // promise resolves once the data is in and the held checks have run
  await startWeb({ register, load, log, gate });
}

export function deactivate(): void {
  // nothing to tear down - every registration is in context.subscriptions
}
