import * as vscode from "vscode";
import { setSnapshotText, snapshotError } from "../snapshot";
import { registerLanguageFeatures } from "../language";
import { registerXmlPreview } from "../xmlpreview";
import { registerWebCheck, webFindingsNow } from "../webcheck";
import { registerNewApp, registerNewProject } from "../wizard";
import { registerConvert } from "../convert";
import { registerNavMap } from "../navview";
import { registerPropertyEditor } from "../propview";
import { registerFindingsView } from "../findingsview";

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

  try {
    const raw = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(context.extensionUri, "dist", "properties.json")
    );
    setSnapshotText(new TextDecoder().decode(raw));
    const broken = snapshotError();
    if (broken) {
      log(`web: the bundled UI5 metadata could not be parsed (${broken})`);
    }
  } catch (err) {
    log(
      "web: dist/properties.json could not be read - the property gate and " +
        `completion have no metadata (${err instanceof Error ? err.message : String(err)})`
    );
  }

  registerLanguageFeatures(context, log);
  registerWebCheck(context, log);
  registerXmlPreview(context, log, webFindingsNow);
  registerNewApp(context);
  registerNewProject(context);
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
}

export function deactivate(): void {
  // nothing to tear down - every registration is in context.subscriptions
}
