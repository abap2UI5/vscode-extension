import * as vscode from "vscode";
import { loadAppTemplate } from "./scaffold";

/*
 * Where the app-template snapshot comes from at runtime: `dist/app-template.json`,
 * shipped next to the bundle by `esbuild.js` the way `properties.json` is,
 * and read through `workspace.fs` - the one file API both hosts have, so the
 * desktop and the web entry share this. Read on demand by the two commands
 * that need it ("New Project from Template", "Add Agent Setup to
 * Workspace"), never at activation: the snapshot is 300 KB, and most windows
 * run neither.
 */

/** Resolves once the snapshot is in (`scaffold.ts`); rejects with the read
 *  or parse error, which the command reports. */
export function ensureAppTemplate(context: vscode.ExtensionContext): Promise<void> {
  return loadAppTemplate(async () =>
    new TextDecoder().decode(
      await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(context.extensionUri, "dist", "app-template.json")
      )
    )
  );
}
