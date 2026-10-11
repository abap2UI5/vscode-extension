import * as vscode from "vscode";
import { appClassEntries, onDidRefreshAppClasses } from "./appclasses";

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
 *
 * The list is the app-class index's (`appclasses.ts`): the index already
 * reads every class the window sees and updates one entry on a save, an
 * open, a close or a change on disk. The tree used to run its own sweep of
 * the workspace on every one of those events - re-reading every file once
 * the source cache had expired - to answer what the index knew.
 */

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
  /** Bumped by every refresh: a scan that started before the latest one
   *  must not store its older list over the newer one's. */
  private generation = 0;

  refresh(): void {
    this.cache = undefined;
    this.generation++;
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  async getChildren(node?: AppNode): Promise<AppNode[]> {
    if (node) {
      return [];
    }
    if (this.cache) {
      return this.cache;
    }
    const generation = this.generation;
    const nodes = await scan();
    if (generation === this.generation) {
      this.cache = nodes;
    }
    return nodes;
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
    // a view-building app gets the window, a nav-only app the link - the
    // same distinction the context menu (contextValue) already draws
    item.iconPath = new vscode.ThemeIcon(node.buildsViews ? "window" : "link");
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
  // Files AND open documents - working straight against the system through
  // ADT means there is no file to glob, and this tree was simply empty there.
  const out = (await appClassEntries()).map((entry) => ({
    className: entry.name,
    uri: vscode.Uri.parse(entry.key),
    buildsViews: entry.usesBuilder,
    fromEditor: entry.fromEditor,
  }));
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

/** How long event-driven refreshes are coalesced. A branch switch touches
 *  hundreds of files at once, and the index says so once per file. */
const REFRESH_DEBOUNCE_MS = 300;

export function registerAppView(context: vscode.ExtensionContext): void {
  const provider = new AppTree();
  let pending: NodeJS.Timeout | undefined;
  const refresh = () => {
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => {
      pending = undefined;
      provider.refresh();
    }, REFRESH_DEBOUNCE_MS);
  };
  context.subscriptions.push(
    provider,
    {
      dispose: () => {
        if (pending) {
          clearTimeout(pending);
        }
      },
    },
    vscode.window.createTreeView("abap2ui5.apps", { treeDataProvider: provider }),
    // every change of the index: a rebuild in the background (a subclass of
    // a base class it did not know before is an app now), a saved class
    // that became an app or stopped being one, an ADT document opened or
    // closed (the whole list, where the classes come from editors), a file
    // created, changed or deleted on disk - the index hears of all of it
    onDidRefreshAppClasses(refresh),
    // the explicit command answers now, not after the debounce
    vscode.commands.registerCommand("abap2ui5.refreshApps", () => provider.refresh()),
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
