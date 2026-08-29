import * as vscode from "vscode";
import { layoutGraph, navGraph, navMapSvg, NavSource } from "./navmap";
import { abapSources } from "./abapsources";
import { createNonce, navMapHtml } from "./webview";

/*
 * "Show App Navigation Map": every z2ui5_if_app class in the workspace and
 * each nav_app_call( ) between them, as a clickable graph. The Fiori tools'
 * Page Map for the thin-frontend world: which app starts where, what the
 * user can reach from it, and which target is missing from the workspace.
 */

/** Same cap as the workspace symbol search - beyond this, a real index. */
const NAV_FILE_CAP = 500;

async function workspaceSources(
  token: vscode.CancellationToken
): Promise<NavSource[]> {
  // Files and open documents alike - a map drawn only from a folder is empty
  // for anyone working straight against a system through ADT, where the apps
  // that exist are the ones somebody opened.
  const sources: NavSource[] = [];
  for (const source of await abapSources(NAV_FILE_CAP)) {
    if (token.isCancellationRequested) {
      break;
    }
    sources.push({ fileName: source.uri.toString(), source: source.text });
  }
  return sources;
}

export function registerNavMap(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  let panel: vscode.WebviewPanel | undefined;

  const render = async () => {
    const sources = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "abap2UI5: scanning the workspace for apps",
      },
      (_progress, token) => workspaceSources(token)
    );
    const graph = navGraph(sources);
    const layout = layoutGraph(graph);
    const appCount = graph.nodes.filter((n) => n.isApp).length;
    // at the cap the scan stopped, not the workspace - say so instead of
    // presenting a partial map as the whole picture
    const truncated = sources.length >= NAV_FILE_CAP;
    log(
      `nav-map: ${appCount} apps, ${graph.edges.length} navigations ` +
        `(${sources.length} files scanned${
          truncated ? " - cap reached, apps beyond it are missing" : ""
        })`
    );

    if (!panel) {
      panel = vscode.window.createWebviewPanel(
        "abap2ui5.navmap",
        "abap2UI5 App Navigation",
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true }
      );
      panel.iconPath = {
        light: vscode.Uri.joinPath(context.extensionUri, "media", "icon-light.svg"),
        dark: vscode.Uri.joinPath(context.extensionUri, "media", "icon-dark.svg"),
      };
      panel.onDidDispose(() => {
        panel = undefined;
      });
      panel.webview.onDidReceiveMessage(
        async (msg: { type?: string; file?: string; offset?: number }) => {
          // the map's own refresh button - a rescan without the palette
          if (msg?.type === "refresh") {
            void render();
            return;
          }
          if (msg?.type !== "open" || !msg.file) {
            return;
          }
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.parse(msg.file)
            );
            // an edge carries the nav_app_call's offset; a node opens plain
            const at =
              typeof msg.offset === "number" && msg.offset >= 0
                ? doc.positionAt(Math.min(msg.offset, doc.getText().length))
                : undefined;
            await vscode.window.showTextDocument(doc, {
              preview: false,
              selection: at ? new vscode.Range(at, at) : undefined,
            });
          } catch (err) {
            log(`nav-map: could not open ${msg.file} - ${String(err)}`);
          }
        }
      );
    } else {
      panel.reveal();
    }
    panel.webview.html = navMapHtml({
      nonce: createNonce(),
      svg: navMapSvg(layout),
      appCount,
      edgeCount: graph.edges.length,
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.showNavMap", () => render())
  );
}
