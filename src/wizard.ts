import * as vscode from "vscode";
import { APP_TEMPLATES, templateSource } from "./template";
import { projectNameFrom, scaffoldFiles, scaffoldText } from "./scaffold";

/*
 * "New App from Template" - the template gallery behind abap2ui5.newApp.
 *
 * Two steps: pick a template (empty view, list, form, master & detail,
 * popup), name the class. The result lands where the user already is: at the
 * cursor of an open ABAP editor, or as a fresh untitled ABAP document when
 * none is open. Every template ships linter-clean - the test suite runs each
 * one through the bundled gates.
 *
 * Shared by the desktop and the web entry: nothing here needs a process or
 * a socket.
 */

const CLASS_NAME_RE = /^[zy][a-z0-9_]{0,29}$/i;

export async function newAppWizard(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    APP_TEMPLATES.map((template) => ({
      label: template.label,
      description: template.description,
      template,
    })),
    {
      title: "abap2UI5: new app",
      placeHolder: "Which kind of app to start from",
    }
  );
  if (!pick) {
    return;
  }
  const className = await vscode.window.showInputBox({
    title: "abap2UI5: class name",
    value: "zcl_my_app",
    prompt: "Name of the app class (customer namespace, up to 30 characters)",
    validateInput: (value) =>
      CLASS_NAME_RE.test(value.trim())
        ? undefined
        : "A class name starts with Z (or Y) and uses letters, digits and _ only.",
  });
  if (!className) {
    return;
  }
  const source = templateSource(pick.template, className.trim());

  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === "abap") {
    await editor.edit((b) => b.insert(editor.selection.active, source));
    return;
  }
  const doc = await vscode.workspace.openTextDocument({
    language: "abap",
    content: source,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

export function registerNewApp(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.newApp", () => newAppWizard())
  );
}

/*
 * "New Project from Template" - abap2ui5.newProject.
 *
 * The gap this closes: newAppWizard hands out a class, which is right when
 * you already have a repository and leaves you one file short when you do
 * not. The file that matters is `abap2ui5lint.jsonc` - without it the view
 * check falls back to VS Code settings, and the first CI run in that new
 * repository disagrees with everything the editor has been telling you.
 */
export async function newProjectWizard(): Promise<void> {
  const folders = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Create project here",
    title: "abap2UI5: new project - pick an empty folder",
  });
  if (!folders?.length) {
    return;
  }
  const root = folders[0];

  // An existing project is not something to write files into: a scaffold that
  // overwrites abap2ui5lint.jsonc or package.json takes settings with it.
  for (const name of ["package.json", "abap2ui5lint.jsonc", "src"]) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, name));
      void vscode.window.showErrorMessage(
        `That folder already has a ${name}. Pick an empty folder - this would overwrite it.`
      );
      return;
    } catch {
      /* not there, which is what we want */
    }
  }

  const pick = await vscode.window.showQuickPick(
    APP_TEMPLATES.map((template) => ({
      label: template.label,
      description: template.description,
      template,
    })),
    { title: "abap2UI5: new project", placeHolder: "Which kind of app to start from" }
  );
  if (!pick) {
    return;
  }
  const className = await vscode.window.showInputBox({
    title: "abap2UI5: class name",
    value: "zcl_my_app",
    prompt: "Name of the app class (customer namespace, up to 30 characters)",
    validateInput: (value) =>
      CLASS_NAME_RE.test(value.trim())
        ? undefined
        : "A class name starts with Z (or Y) and uses letters, digits and _ only.",
  });
  if (!className) {
    return;
  }

  const folderName = root.path.split("/").filter(Boolean).pop() ?? "abap2ui5-app";
  const files = scaffoldFiles(
    projectNameFrom(folderName),
    className.trim().toLowerCase(),
    pick.template
  );
  for (const file of files) {
    const target = vscode.Uri.joinPath(root, ...file.path.split("/"));
    // scaffoldText adds the BOM abapGit expects on the XML - a BOM-less
    // file comes back changed on the first pull, for everyone
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(scaffoldText(file))
    );
  }

  const open = "Open project";
  const choice = await vscode.window.showInformationMessage(
    // `npm install`, not `npm ci`: a brand-new project has no lockfile yet,
    // and `npm ci` refuses without one. The install writes it - AGENTS.md and
    // the README tell the reader to commit it.
    `Created ${files.length} files. Run "npm install" there, then "npm run check" - the same gates CI runs.`,
    open,
    "Not now"
  );
  if (choice === open) {
    await vscode.commands.executeCommand("vscode.openFolder", root, {
      forceNewWindow: false,
    });
  }
}

export function registerNewProject(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.newProject", () => newProjectWizard())
  );
}
