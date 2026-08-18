import * as vscode from "vscode";
import { classNameOf, isAppClass, usesBuilder } from "./abap";
import { abapSources, isAbapDocument } from "./abapsources";

/*
 * The apps of this workspace, as a tree with the actions on them.
 *
 * The pattern every toolchain extension settled on - npm scripts, Docker,
 * Maven, Jest all put the things of the project in a list with a play button.
 * abap2UI5 had no such list: F9 works on the class you happen to have open,
 * and "Run a Recently Launched App" only knows what this window already ran.
 * Opening a repository with thirty apps in it, there was nothing that said
 * which thirty.
 *
 * A class counts as an app when it implements `z2ui5_if_app` - the same test
 * the navigation map uses, so the two cannot disagree about what an app is.
 */

const APP_GLOB = "**/*.clas.abap";

interface AppNode {
  className: string;
  uri: vscode.Uri;
  /** Came from an open editor rather than from a file on disk. */
  fromEditor?: boolean;
  /** A class building views is previewable without a system; one that only
   *  navigates is not. */
  buildsViews: boolean;
}

class AppTree implements vscode.TreeDataProvider<AppNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private cache: AppNode[] | undefined;

  refresh(): void {
    this.cache = undefined;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  async getChildren(node?: AppNode): Promise<AppNode[]> {
    if (node) {
      return [];
    }
    if (!this.cache) {
      this.cache = await scan();
    }
    return this.cache;
  }

  getTreeItem(node: AppNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.className, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = node.uri;
    // asRelativePath answers with the full uri for anything outside a folder,
    // which for an ADT document is a long service path nobody reads - the
    // editor it is open in is the more useful thing to say
    const where = node.fromEditor
      ? "open in the editor"
      : vscode.workspace.asRelativePath(node.uri);
    item.description = where;
    item.iconPath = new vscode.ThemeIcon("window");
    item.contextValue = node.buildsViews ? "abap2ui5.app.view" : "abap2ui5.app";
    item.tooltip = new vscode.MarkdownString(
      `**${node.className}**\n\n${where}` +
        (node.buildsViews ? "" : "\n\nBuilds no view of its own.")
    );
    // clicking opens the class - the actions hang off the item, so a click
    // never starts something that talks to a system
    item.command = {
      title: "Open the class",
      command: "vscode.open",
      arguments: [node.uri],
    };
    return item;
  }
}

async function scan(): Promise<AppNode[]> {
  const out: AppNode[] = [];
  // Files AND open documents - working straight against the system through
  // ADT means there is no file to glob, and this tree was simply empty there.
  for (const source of await abapSources()) {
    if (!isAppClass(source.text)) {
      continue;
    }
    out.push({
      className: classNameOf(source.text, source.uri.path),
      uri: source.uri,
      buildsViews: usesBuilder(source.text),
      fromEditor: source.fromEditor,
    });
  }
  return out.sort((a, b) => a.className.localeCompare(b.className));
}

/** Run a command with the app's class opened first: F9, the preview and the
 *  check all work on the active editor, which is the right contract for them
 *  and means the tree has to put the class there. */
async function withOpenClass(node: AppNode | undefined, command: string): Promise<void> {
  if (!node) {
    return;
  }
  const doc = await vscode.workspace.openTextDocument(node.uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  await vscode.commands.executeCommand(command);
}

export function registerAppView(context: vscode.ExtensionContext): void {
  const provider = new AppTree();
  const watcher = vscode.workspace.createFileSystemWatcher(APP_GLOB);
  const refresh = () => provider.refresh();
  context.subscriptions.push(
    provider,
    watcher,
    vscode.window.createTreeView("abap2ui5.apps", { treeDataProvider: provider }),
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh),
    // a saved class can BECOME an app (or stop being one) - the tree follows
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        refresh();
      }
    }),
    // Opening and closing an ABAP document changes the list itself when the
    // classes come from editors rather than from a folder - which is the
    // whole picture in the ADT case.
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        refresh();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        refresh();
      }
    }),
    vscode.commands.registerCommand("abap2ui5.refreshApps", refresh),
    vscode.commands.registerCommand("abap2ui5.runApp", (node: AppNode) =>
      withOpenClass(node, "abap2ui5.run")
    ),
    vscode.commands.registerCommand("abap2ui5.previewApp", (node: AppNode) =>
      withOpenClass(node, "abap2ui5.previewView")
    ),
    vscode.commands.registerCommand("abap2ui5.checkApp", (node: AppNode) =>
      withOpenClass(node, "abap2ui5.checkViews")
    ),
    // The name is what an ADT workflow pastes on: into the class search, a
    // transport, a colleague's message. The tree knows it exactly - reading
    // it off the title bar and retyping it is where the typo comes from.
    vscode.commands.registerCommand("abap2ui5.copyAppName", async (node: AppNode) => {
      if (!node?.className) {
        return;
      }
      await vscode.env.clipboard.writeText(node.className);
      vscode.window.setStatusBarMessage(
        `abap2UI5: ${node.className} copied`,
        3000
      );
    })
  );
}
