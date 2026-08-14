import * as vscode from "vscode";
import { xmlToAbap } from "./xmltoabap";

/*
 * "Convert XML View to Builder Chain" - the reverse direction of the
 * reconstructed XML view. A sample from the UI5 demo kit (or any existing
 * *.view.xml) goes in, the z2ui5_cl_ui5_view_builder chain a port writes by hand comes
 * out - in the corpus style the chain formatter enforces, so Format Document
 * is a no-op on the result.
 *
 * Where the XML comes from, in order: the active editor's selection, the
 * active document when it is XML, the clipboard. The result opens as a new
 * ABAP document beside the source - it is a starting point to paste into a
 * class, not an edit of anything.
 */

function looksLikeXml(text: string): boolean {
  return /^\s*(?:<\?xml|<!--|<\w)/.test(text);
}

async function xmlSource(): Promise<{ text: string; from: string } | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && !editor.selection.isEmpty) {
    const selected = editor.document.getText(editor.selection);
    if (looksLikeXml(selected)) {
      return { text: selected, from: "the selection" };
    }
  }
  if (editor && looksLikeXml(editor.document.getText())) {
    return { text: editor.document.getText(), from: "the active document" };
  }
  const clipboard = await vscode.env.clipboard.readText();
  if (looksLikeXml(clipboard)) {
    return { text: clipboard, from: "the clipboard" };
  }
  return undefined;
}

export function registerConvert(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.convertXml", async () => {
      const source = await xmlSource();
      if (!source) {
        vscode.window.showInformationMessage(
          "abap2UI5: no XML found - select view XML, open a view file, or " +
            "copy the XML to the clipboard first."
        );
        return;
      }
      const { abap, warnings } = xmlToAbap(source.text, "    ");
      if (!abap) {
        vscode.window.showWarningMessage(
          `abap2UI5: could not convert ${source.from} - ${warnings.join("; ")}`
        );
        return;
      }
      const header =
        `" Converted from XML (${source.from}) by abap2UI5: ` +
        `Convert XML View to Builder Chain.\n` +
        warnings.map((w) => `" TODO: ${w}\n`).join("");
      const doc = await vscode.workspace.openTextDocument({
        language: "abap",
        content: header + abap + "\n",
      });
      await vscode.window.showTextDocument(doc, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
      log(
        `convert: XML from ${source.from} -> builder chain` +
          (warnings.length ? ` (${warnings.length} warning(s))` : "")
      );
      if (warnings.length) {
        vscode.window.showWarningMessage(
          `abap2UI5: converted with ${warnings.length} caveat(s) - see the ` +
            "TODO comments at the top of the result."
        );
      }
    })
  );
}
