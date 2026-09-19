import * as vscode from "vscode";
import * as fs from "fs";
import { CONFIG_SECTION } from "./settings";
import { SERVER_DIRS } from "./repolayout";
import { checkoutEnv } from "./mcp";
import {
  classOfFile,
  resolveUnitRunner,
  unitTestArgs,
  unitTestBanner,
  unitTestCommandLine,
} from "./unitrunner";

/*
 * "Run Unit Tests (No System)" - the plumbing around `unitrunner.ts`.
 *
 * The tests run in an integrated terminal rather than a child process the
 * extension reads: the runner logs a clone, a backend download or build and
 * one line per test method, over minutes the first time, and a terminal shows
 * that live where an output channel would show it afterwards. The terminal is
 * one, named, and reused - a run per terminal tab is how a panel fills up
 * with dead shells.
 *
 * Trust: the settings that choose the program (`mcp.reposRoot`) are machine
 * scoped and restricted, so a cloned repository's `.vscode/settings.json`
 * cannot point the runner at something else - the same protection the MCP
 * registration relies on. And in a workspace that is not trusted the command
 * does not run at all: the tests ARE the repository's code, transpiled and
 * executed, which is what Restricted Mode exists to hold back.
 */

const TERMINAL_NAME = "abap2UI5 unit tests";

/** The one terminal, with what it was created for: `env` and `cwd` cannot
 *  be changed on a live terminal, so a run whose environment differs (the
 *  repos root moved, another workspace folder) gets a fresh one. */
let terminal: { handle: vscode.Terminal; signature: string } | undefined;

function terminalFor(
  cwd: string,
  env: Record<string, string>,
  message: string
): vscode.Terminal {
  const signature = JSON.stringify([cwd, env]);
  if (
    terminal &&
    terminal.signature === signature &&
    vscode.window.terminals.includes(terminal.handle)
  ) {
    return terminal.handle;
  }
  terminal?.handle.dispose();
  const handle = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd,
    env,
    message,
  });
  terminal = { handle, signature };
  return handle;
}

/** The class file the command was invoked on: the apps tree's node or the
 *  CodeLens hands a uri, the palette hands nothing and the active editor
 *  decides - a class (or its test include) on disk runs alone, anything else
 *  runs the project. */
function classFileOf(node?: { uri?: vscode.Uri }): string | undefined {
  const uri = node?.uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== "file" || !classOfFile(uri.fsPath)) {
    return undefined;
  }
  return uri.fsPath;
}

/** The project folder: the class's own workspace folder, otherwise the one
 *  folder on disk - or a pick when the workspace has several. */
async function projectFolder(classFile?: string): Promise<vscode.WorkspaceFolder | undefined> {
  if (classFile) {
    const own = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(classFile));
    if (own) {
      return own;
    }
  }
  const onDisk = (vscode.workspace.workspaceFolders ?? []).filter(
    (folder) => folder.uri.scheme === "file"
  );
  if (onDisk.length <= 1) {
    return onDisk[0];
  }
  return vscode.window.showWorkspaceFolderPick({
    placeHolder: "The project whose unit tests run (the folder holding abaplint.jsonc and src/)",
  });
}

export function registerUnitTests(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (terminal?.handle === closed) {
        terminal = undefined;
      }
    }),
    { dispose: () => terminal?.handle.dispose() },
    vscode.commands.registerCommand(
      "abap2ui5.runUnitTests",
      async (node?: { uri?: vscode.Uri }) => {
        if (!vscode.workspace.isTrusted) {
          const manage = "Manage Workspace Trust";
          const pick = await vscode.window.showWarningMessage(
            "abap2UI5: the unit tests transpile and execute this repository's " +
              "code, which Restricted Mode holds back. Trust the workspace to run them.",
            manage
          );
          if (pick === manage) {
            await vscode.commands.executeCommand("workbench.trust.manage");
          }
          return;
        }
        const classFile = classFileOf(node);
        const folder = await projectFolder(classFile);
        if (!folder) {
          vscode.window.showInformationMessage(
            "abap2UI5: open the project folder first - the one holding " +
              "abaplint.jsonc and the src/ with the classes and their " +
              "*.clas.testclasses.abap includes."
          );
          return;
        }
        const cwd = folder.uri.fsPath;
        // the same *_HOME variables the MCP registration hands its server, so
        // the runner finds the checkouts the user pointed reposRoot at
        const env = checkoutEnv();
        const home = env.A2UI5_HOME;
        const runner = resolveUnitRunner({
          reposRoot: vscode.workspace
            .getConfiguration(CONFIG_SECTION)
            .get<string>("mcp.reposRoot", ""),
          serverDirs: SERVER_DIRS,
          exists: (file) => fs.existsSync(file),
        });
        const args = unitTestArgs({
          cwd,
          classFile,
          home,
          exists: (dir) => fs.existsSync(dir),
        });
        const line = unitTestCommandLine(runner, args, process.platform);
        // written straight to the terminal, before the shell's prompt - the
        // clone/build warning has to be read BEFORE the minutes it announces
        const banner = unitTestBanner(runner, home).join("\r\n") + "\r\n";
        const term = terminalFor(cwd, env, banner);
        term.show(true);
        term.sendText(line, true);
        log(`unit tests: (${runner.source}) ${line} - in ${cwd}`);
      }
    )
  );
}
