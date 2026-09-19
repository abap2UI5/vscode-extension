import * as vscode from "vscode";
import * as fs from "fs";
import { classNameOf } from "./abap";
import { preparedAbapOf } from "./language";
import { mockJson, mockSkeleton } from "./mockgen";
import { plural } from "./text";
import { isCheckable, pickDocument } from "./viewcheck";

/*
 * "Generate Mock Data for This App" - the plumbing around `mockgen.ts`.
 *
 * The systemless preview and the linter's `--screenshot` read a
 * `<class>.mock.json` next to the source (`viewpreview.ts` finds it). This
 * writes one from the class's own model shape, beside the file when there is
 * a file - asking before it replaces one the author has filled in - and as
 * an untitled document when the class came through ADT and has no "beside".
 */

/** The linter's `MOCK_SUFFIX`, spelt here because its main module pulls the
 *  render runtime into whatever bundles it - `viewpreview.ts` reads the same
 *  convention the same way. */
const MOCK_SUFFIX = ".mock.json";

/** The mock file's path for a document on disk, by the linter's convention -
 *  undefined for a virtual document or a name the convention does not fit. */
export function mockPathFor(doc: vscode.TextDocument): string | undefined {
  if (doc.uri.scheme !== "file") {
    return undefined;
  }
  const candidate = doc.uri.fsPath.replace(/\.(clas\.abap|abap)$/i, MOCK_SUFFIX);
  return candidate === doc.uri.fsPath ? undefined : candidate;
}

/** The apps tree hands its node; the palette hands nothing. Either way the
 *  class is opened first, because the shape is read off the document. */
async function documentFor(node?: { uri?: vscode.Uri }): Promise<vscode.TextDocument | undefined> {
  if (node?.uri) {
    const doc = await vscode.workspace.openTextDocument(node.uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
  }
  return pickDocument();
}

export function registerMockFile(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "abap2ui5.generateMock",
      async (node?: { uri?: vscode.Uri }) => {
        const doc = await documentFor(node);
        if (!doc || !isCheckable(doc) || doc.languageId !== "abap") {
          vscode.window.showInformationMessage(
            "abap2UI5: no app here to mock - open an ABAP class building " +
              "views with z2ui5_cl_ui5_view_builder."
          );
          return;
        }
        const prep = preparedAbapOf(doc);
        const shape = prep?.usesBuilder ? prep.modelShape : undefined;
        const { data, unknownRoots } = mockSkeleton(shape);
        if (!Object.keys(data).length) {
          vscode.window.showInformationMessage(
            "abap2UI5: this class binds nothing - there is no model to mock."
          );
          return;
        }
        const text = mockJson(shape);
        const className = classNameOf(doc.getText(), doc.fileName);
        const target = mockPathFor(doc);

        let opened: vscode.TextDocument;
        if (!target) {
          // An ADT document lives on the server; the preview looks the mock
          // up by class name in the workspace, so the author saves it there.
          opened = await vscode.workspace.openTextDocument({
            language: "json",
            content: text,
          });
          log(`mock: skeleton for ${className} opened as an untitled document`);
        } else {
          if (fs.existsSync(target)) {
            const overwrite = "Overwrite";
            const picked = await vscode.window.showWarningMessage(
              `abap2UI5: ${vscode.workspace.asRelativePath(target)} exists. ` +
                "Replace it with a fresh skeleton? Its values are lost.",
              { modal: true },
              overwrite
            );
            if (picked !== overwrite) {
              return;
            }
          }
          try {
            await vscode.workspace.fs.writeFile(
              vscode.Uri.file(target),
              Buffer.from(text, "utf8")
            );
          } catch (err) {
            vscode.window.showWarningMessage(
              `abap2UI5: could not write ${target} - ${String(err)}`
            );
            return;
          }
          log(`mock: wrote ${target}`);
          opened = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        }
        await vscode.window.showTextDocument(opened, {
          viewColumn: vscode.ViewColumn.Beside,
          preview: false,
        });
        if (unknownRoots.length) {
          vscode.window.showInformationMessage(
            `abap2UI5: ${plural(unknownRoots.length, "root")} typed outside ` +
              `this class left empty - ${unknownRoots.join(", ")}. ` +
              "Fill in the fields the view binds."
          );
        }
      }
    )
  );
}
