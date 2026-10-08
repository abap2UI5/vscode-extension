import * as vscode from "vscode";
import {
  agentSetupReport,
  confirmationDetail,
  planFromSnapshot,
  samePlan,
  writesOf,
  type AgentSetupPlan,
  type WorkspaceProbe,
} from "./agentsetup";

/*
 * "Add Agent Setup to Workspace" - abap2ui5.addAgentSetup.
 *
 * The plumbing only: which workspace folder, the confirmation, the writes
 * and the report. WHAT is written is `agentsetup.ts`, decided without
 * writing from the app-template snapshot - the same `agentSetup` key
 * `npm create abap2ui5-app@latest -- --agent-setup` executes.
 *
 * Shared by the desktop and the web entry: everything goes through
 * `vscode.workspace.fs`, so it works on vscode.dev's virtual folders too.
 */

const TITLE = "abap2UI5: Add Agent Setup to Workspace";

/** The workspace folder as the plan sees it: relative paths, read-only. */
function probeFor(root: vscode.Uri): WorkspaceProbe {
  const at = (rel: string) => vscode.Uri.joinPath(root, ...rel.split("/"));
  return {
    exists: async (rel) => {
      try {
        await vscode.workspace.fs.stat(at(rel));
        return true;
      } catch {
        return false;
      }
    },
    readText: async (rel) =>
      new TextDecoder().decode(await vscode.workspace.fs.readFile(at(rel))),
    // `stat` follows a link and ORs `SymbolicLink` into the type; a path
    // that is not there is no link
    isLink: async (rel) => {
      try {
        const stat = await vscode.workspace.fs.stat(at(rel));
        return (stat.type & vscode.FileType.SymbolicLink) !== 0;
      } catch {
        return false;
      }
    },
  };
}

/** The folder to set up: the one the command was invoked on (explorer), the
 *  only one open, or the user's pick. */
async function pickFolder(arg: unknown): Promise<vscode.WorkspaceFolder | undefined> {
  if (arg instanceof vscode.Uri) {
    const folder = vscode.workspace.getWorkspaceFolder(arg);
    if (folder) {
      return folder;
    }
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    void vscode.window.showErrorMessage(
      `${TITLE}: open the project's folder first - the setup is added to a workspace folder.`
    );
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: "Which project gets the agent setup",
  });
}

let channel: vscode.OutputChannel | undefined;

async function addAgentSetup(arg: unknown): Promise<void> {
  const folder = await pickFolder(arg);
  if (!folder) {
    return;
  }
  const probe = probeFor(folder.uri);
  const plan = async (): Promise<AgentSetupPlan | undefined> => {
    try {
      return await planFromSnapshot(probe, folder.name);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `${TITLE}: ${err instanceof Error ? err.message : String(err)} - nothing was written.`
      );
      return undefined;
    }
  };

  const first = await plan();
  if (!first) {
    return;
  }
  const output = (channel ??= vscode.window.createOutputChannel("abap2UI5 Agent Setup"));
  const writes = writesOf(first);
  if (!writes.length) {
    output.clear();
    output.appendLine(agentSetupReport(first, folder.uri.fsPath || folder.name));
    const show = "Show Details";
    const choice = await vscode.window.showInformationMessage(
      `abap2UI5: "${folder.name}" already has the complete agent setup - nothing to do.`,
      show
    );
    if (choice === show) {
      output.show(true);
    }
    return;
  }

  const go = "Add Agent Setup";
  const confirmed = await vscode.window.showInformationMessage(
    `Add the abap2UI5 agent setup to "${folder.name}"? ${writes.length} file${writes.length === 1 ? "" : "s"} will be written, ` +
      `${first.actions.length - writes.length} left as they are.`,
    { modal: true, detail: confirmationDetail(first) },
    go
  );
  if (confirmed !== go) {
    return;
  }

  // Again, right before writing: the folder can change while the dialog is
  // open, and writing a plan made for a different folder could overwrite a
  // file that appeared meanwhile - which is the one thing this must never do.
  const now = await plan();
  if (!now) {
    return;
  }
  if (!samePlan(first, now)) {
    void vscode.window.showWarningMessage(
      `${TITLE}: "${folder.name}" changed while the confirmation was open - nothing was written. Run the command again.`
    );
    return;
  }

  let written = 0;
  for (const action of writesOf(now)) {
    const parts = action.path.split("/");
    const target = vscode.Uri.joinPath(folder.uri, ...parts);
    try {
      if (parts.length > 1) {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(folder.uri, ...parts.slice(0, -1))
        );
      }
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(action.text));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `${TITLE}: could not write ${action.path} - ${String(err)}. ` +
          `${written} of ${writesOf(now).length} files were written; running the command again ` +
          "adds the rest and leaves those as they are."
      );
      return;
    }
    written++;
  }

  output.clear();
  output.appendLine(agentSetupReport(now, folder.uri.fsPath || folder.name));
  output.show(true);

  const openAgents = "Open AGENTS.md";
  const choice = await vscode.window.showInformationMessage(
    `abap2UI5: agent setup added to "${folder.name}" (${written} written). ` +
      'Run "npm install", then "npm run check" - the output panel lists the next steps.',
    openAgents
  );
  if (choice === openAgents) {
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(folder.uri, "AGENTS.md")
    );
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

export function registerAgentSetup(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("abap2ui5.addAgentSetup", (arg: unknown) =>
      addAgentSetup(arg)
    ),
    {
      dispose: () => {
        channel?.dispose();
        channel = undefined;
      },
    }
  );
}
