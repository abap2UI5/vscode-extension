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

/** Why `value` is not a class name - specific enough to act on - or
 *  undefined when it is one. The rule is ABAP's: starts in the customer
 *  namespace, at most 30 characters, word characters only. */
export function classNameError(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Enter a class name, e.g. zcl_my_app.";
  }
  if (!/^[zy]/i.test(name)) {
    return `A class name starts with Z (or Y) - the customer namespace - not "${name[0]}".`;
  }
  if (name.length > 30) {
    return `Too long: ${name.length} characters - ABAP allows up to 30.`;
  }
  const bad = /[^a-z0-9_]/i.exec(name);
  if (bad) {
    return `"${bad[0]}" cannot appear in a class name - use letters, digits and _ only.`;
  }
  return undefined;
}

/** The template gallery pick both wizards share. */
async function pickTemplate(
  title: string
): Promise<(typeof APP_TEMPLATES)[number] | undefined> {
  const pick = await vscode.window.showQuickPick(
    APP_TEMPLATES.map((template) => ({
      label: template.label,
      description: template.description,
      template,
    })),
    { title, placeHolder: "Which kind of app to start from" }
  );
  return pick?.template;
}

/** The class-name prompt both wizards share. The `my_app` half of the
 *  default is preselected, so typing replaces it straight away. */
async function askClassName(): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: "abap2UI5: Class Name",
    value: "zcl_my_app",
    valueSelection: [4, 10],
    prompt: "Name of the app class (customer namespace, up to 30 characters)",
    validateInput: classNameError,
  });
  const name = value?.trim();
  return name || undefined;
}

export async function newAppWizard(): Promise<void> {
  const template = await pickTemplate("abap2UI5: New App from Template");
  if (!template) {
    return;
  }
  const className = await askClassName();
  if (!className) {
    return;
  }
  const source = templateSource(template, className);

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
    title: "abap2UI5: New Project - Pick an Empty Folder",
  });
  if (!folders?.length) {
    return;
  }
  const root = folders[0];

  // An existing project is not something to write files into: a scaffold
  // that overwrites a README or a .gitignore takes content with it just as a
  // package.json takes settings. The probe list is the scaffold's OWN file
  // list (its top-level entries), so a file added to the scaffold is guarded
  // without an edit here.
  const guarded = [
    ...new Set(
      scaffoldFiles(
        projectNameFrom("probe"),
        "zcl_probe",
        APP_TEMPLATES[0]
      ).map((file) => file.path.split("/")[0])
    ),
  ];
  const conflicts: string[] = [];
  for (const name of guarded) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, name));
      conflicts.push(name);
    } catch {
      /* not there, which is what we want */
    }
  }
  if (conflicts.length) {
    // all of them at once - fixing one conflict per attempt is a bad loop
    void vscode.window.showErrorMessage(
      `abap2UI5: that folder already has ${conflicts.join(", ")}. Pick an ` +
        `empty folder - this would overwrite ${
          conflicts.length === 1 ? "it" : "them"
        }.`
    );
    return;
  }

  const template = await pickTemplate("abap2UI5: New Project from Template");
  if (!template) {
    return;
  }
  const className = await askClassName();
  if (!className) {
    return;
  }

  const folderName = root.path.split("/").filter(Boolean).pop() ?? "abap2ui5-app";
  const files = scaffoldFiles(
    projectNameFrom(folderName),
    className.toLowerCase(),
    template
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

  // `npm install`, not `npm ci`: a brand-new project has no lockfile yet,
  // and `npm ci` refuses without one. The install writes it - AGENTS.md and
  // the README tell the reader to commit it.
  const created =
    `abap2UI5: created ${files.length} files. Run "npm install" there, ` +
    `then "npm run check" - the same gates CI runs.`;

  // A folder this window already shows needs no openFolder (which reloads
  // the window) - the project is right there, so open its starter class.
  if (vscode.workspace.getWorkspaceFolder(root)) {
    void vscode.window.showInformationMessage(created);
    const cls = files.find((f) => f.path.endsWith(".clas.abap"));
    if (cls) {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.joinPath(root, ...cls.path.split("/"))
      );
      await vscode.window.showTextDocument(doc, { preview: false });
    }
    return;
  }

  const open = "Open Project";
  const choice = await vscode.window.showInformationMessage(
    created,
    open,
    "Not Now"
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
