import * as vscode from "vscode";
import { sourceLabel } from "./checkcore";

/*
 * "Which ABAP does this window know about?" - the one answer four features
 * used to give differently.
 *
 * The apps tree, the navigation map, the workspace sweep and the method
 * index all reached for `workspace.findFiles`, which sees exactly one kind of
 * source: files in an open folder. That is the whole picture when a
 * repository is checked out, and it is EMPTY for the other way abap2UI5 is
 * worked on - straight against the system through ADT, where a class is a
 * virtual document with a scheme of its own (`adt:`, `abapfs:`, …), no path
 * on disk, and often no workspace folder at all.
 *
 * Nothing about those features needs a path. They need the source text and
 * something to open afterwards, and an open editor supplies both. So this
 * module answers with both kinds at once: the files of the workspace, plus
 * every ABAP document the window currently has open, whatever its scheme.
 *
 * What that cannot be is a complete inventory of a system: ADT has no glob,
 * so the classes it contributes are the ones somebody opened. That is a
 * smaller promise than the file case makes, and the callers say so in their
 * own words rather than pretending the list is exhaustive.
 */

/** A class this window can read, wherever it came from. */
export interface AbapSource {
  uri: vscode.Uri;
  text: string;
  /** True when it came from an open editor rather than from disk - the
   *  callers that want to say "of the ones you have open" ask this. */
  fromEditor: boolean;
}

const APP_GLOB = "**/*.clas.abap";
const EXCLUDE = "**/{node_modules,.git,dist,out}/**";

/** One decoder for every read - the sweep runs per picker keystroke over up
 *  to `limit` files, and a fresh TextDecoder per file was pure overhead. */
const DECODER = new TextDecoder();

/** Whether a document is ABAP at all - by language id first, because an ADT
 *  document's path may carry no extension worth testing. */
export function isAbapDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === "abap" || /\.abap$/i.test(doc.uri.path);
}

/**
 * Every ABAP source the window can see: the workspace's files, then the open
 * documents that are not among them. Reading the open ones costs nothing -
 * they are already in memory - and it is what makes the ADT case work at all.
 */
export async function abapSources(limit = 2000): Promise<AbapSource[]> {
  const seen = new Set<string>();
  const out: AbapSource[] = [];

  for (const uri of await vscode.workspace.findFiles(APP_GLOB, EXCLUDE, limit)) {
    const key = uri.toString();
    if (seen.has(key)) {
      continue;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      seen.add(key);
      out.push({
        uri,
        text: DECODER.decode(bytes),
        fromEditor: false,
      });
    } catch {
      // deleted between the glob and the read, or unreadable - not our
      // business to report, the next sweep will not find it either
    }
  }

  for (const doc of vscode.workspace.textDocuments) {
    const key = doc.uri.toString();
    if (seen.has(key) || !isAbapDocument(doc)) {
      continue;
    }
    seen.add(key);
    out.push({ uri: doc.uri, text: doc.getText(), fromEditor: true });
  }

  return out;
}

/** True when the workspace has no folder to glob - then everything on offer
 *  came from open editors, and a list saying "none found" would be a lie
 *  about the system rather than about the workspace. */
export function noWorkspaceFolders(): boolean {
  return !vscode.workspace.workspaceFolders?.length;
}

/** How a source is named in a list - see `sourceLabel`, which is where the
 *  decision lives so the test suite can reach it. */
export function labelOf(uri: vscode.Uri, className?: string): string {
  return sourceLabel(uri.path, className) || uri.toString();
}
