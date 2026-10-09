import * as vscode from "vscode";
import { ClassIndex, ClassIndexStore } from "./classindex";
import { ClassIndexSync } from "./classindexsync";
import {
  abapSources,
  isAbapDocument,
  onDidChangeAbapSources,
  watchAbapSources,
} from "./abapsources";

/*
 * Keeps the window's class index (`classindex.ts`) fed - the plumbing half;
 * what is read when, and when the checks hear of it, is decided `vscode`-free
 * in `classindexsync.ts`.
 *
 * Both entries register it (the web host has `workspace.fs` and the same
 * watcher), and both skip it entirely while the pinned linter has no
 * `classIndexOf`: no listener, `workspaceClassIndex( )` undefined. With one,
 * nothing is read either until the first check asks for the index (see
 * `classindexsync.ts` on why the scan is lazy).
 */

const changed = new vscode.EventEmitter<void>();

const DECODER = new TextDecoder();

const sync = new ClassIndexSync(new ClassIndexStore(), {
  scan: async () =>
    (await abapSources()).map((source) => ({
      key: source.uri.toString(),
      text: source.text,
      fromEditor: source.fromEditor,
    })),
  read: async (key) => DECODER.decode(await vscode.workspace.fs.readFile(vscode.Uri.parse(key))),
  onChange: () => changed.fire(),
});

/** Fires (debounced) when the index's CONTENT changed - a superclass gained a
 *  `cs_event`, a caller started reading an attribute - and once when the
 *  first scan lands. Findings memoised under the old index are stale then:
 *  the checks drop their memos and re-check what is open. */
export const onDidChangeClassIndex = changed.event;

/** The index for the gate, or undefined when the linter takes none (or the
 *  first scan, which this call starts, is still out). */
export function workspaceClassIndex(): ClassIndex | undefined {
  return sync.index();
}

/** What a check of the file behind `uriKey` reads out of the index - for a
 *  cache of findings to add to its stamp (`ClassIndexStore.depsOf`). */
export function classIndexStamp(uriKey: string): string {
  return sync.stamp(uriKey);
}

let registered = false;

export function registerClassIndex(context: vscode.ExtensionContext): void {
  if (!sync.enabled || registered) {
    return;
  }
  registered = true;
  watchAbapSources(context);
  context.subscriptions.push(
    { dispose: () => sync.dispose() },
    changed,
    // created / changed / deleted on disk (a pull, another tool) - that file
    // only; the folders themselves changing is a rescan
    onDidChangeAbapSources((uri) => void sync.fileChanged(uri?.toString())),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        sync.saved(doc.uri.toString(), doc.getText());
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        sync.opened(doc.uri.toString(), doc.getText());
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        sync.closed(doc.uri.toString());
      }
    })
  );
}
