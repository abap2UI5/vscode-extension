import * as vscode from "vscode";
import { safeFileStem } from "./previewcore";

/*
 * The live model of the running app, as a document.
 *
 * Completion and hover know the model's statically derived SHAPE; the "Show
 * the app's JSON model" button in the preview asks the running app for its
 * actual VALUES (through the hook the proxy plants) and this module shows
 * them as a read-only JSON document beside the code. "Why is that field
 * empty?" becomes one click: the binding path on one side, what the model
 * really holds on the other.
 *
 * Every dump replaces the document's content in place - the tab stays.
 */

const SCHEME = "abap2ui5-model";

const contents = new Map<string, string>();

export interface ModelView {
  /** Renders one dump (or the reason there is none) for the given class. */
  show(className: string, payload: { text?: string; error?: string }): Promise<void>;
}

export function registerModelView(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): ModelView {
  const emitter = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    emitter,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
      onDidChange: emitter.event,
      provideTextDocumentContent(uri: vscode.Uri): string {
        return (
          contents.get(uri.toString()) ??
          "// No model dump yet - use the { } button in the preview toolbar.\n"
        );
      },
    }),
    /*
     * The dump is deliberately NOT dropped when the document closes. VS Code
     * closes a virtual document it has kept hidden for a few minutes and asks
     * the provider again when the tab is returned to - so forgetting here
     * showed the "no model dump yet" placeholder in a tab that was still
     * open and had a dump a moment ago. The map is bounded by the number of
     * classes a session dumps, and one dump per class at that.
     */
  );

  return {
    async show(className, payload): Promise<void> {
      let body: string;
      if (payload.error) {
        body = `// ${payload.error}\n`;
      } else {
        try {
          body = JSON.stringify(JSON.parse(payload.text ?? ""), null, 2) + "\n";
        } catch {
          // an over-long dump was cut at the cap - still worth seeing
          body = payload.text ?? "";
        }
      }
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
      body = `// ${className} - model as of ${stamp}\n` + body;

      // A namespace class (`/UI2/CL_APP`) starts with a slash, and a path
      // beginning with `//` is not a URI without an authority - the button
      // threw and visibly did nothing. The raw name stays in the header.
      const uri = vscode.Uri.from({
        scheme: SCHEME,
        path: `/${safeFileStem(className)}.model.json`,
      });
      contents.set(uri.toString(), body);
      emitter.fire(uri);
      const doc = await vscode.workspace.openTextDocument(uri);
      // jsonc, because the header (and an error) is a comment line
      await vscode.languages.setTextDocumentLanguage(doc, "jsonc");
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: false,
      });
      log(`model-view: dumped the model of ${className}`);
    },
  };
}
