import * as vscode from "vscode";
import { ClassIndex, ClassIndexStore } from "./classindex";
import {
  abapSources,
  isAbapDocument,
  onDidChangeAbapSources,
  watchAbapSources,
} from "./abapsources";

/*
 * Keeps the window's class index (`classindex.ts`) fed - the plumbing half.
 *
 * What goes in is the SAVED state of the workspace's classes, the state CI
 * judges: the files on disk through the shared ABAP watcher, plus the open
 * documents that have no file behind them (ADT), whose editor text is all
 * there is. A keystroke changes nothing here - the document being typed in
 * is judged against the OTHER classes, and those only change when they are
 * saved; the save updates exactly that file's contribution.
 *
 * Both entries register it (the web host has `workspace.fs` and the same
 * watcher), and both skip it entirely while the pinned linter has no
 * `classIndexOf`: no scan, no listener, `workspaceClassIndex( )` undefined.
 */

const store = new ClassIndexStore();
const changed = new vscode.EventEmitter<void>();

/** Fires (debounced) when the index's CONTENT changed - a superclass gained a
 *  `cs_event`, a caller started reading an attribute. Findings memoised
 *  under the old index are stale then: the checks drop their memos and
 *  re-check what is open. */
export const onDidChangeClassIndex = changed.event;

/** The index for the gate, or undefined when the linter takes none. */
export function workspaceClassIndex(): ClassIndex | undefined {
  return store.enabled ? store.index() : undefined;
}

/** What a check of the file behind `uriKey` reads out of the index - for a
 *  cache of findings to add to its stamp (`ClassIndexStore.depsOf`). */
export function classIndexStamp(uriKey: string): string {
  return store.enabled ? store.depsOf(store.nameOf(uriKey)) : "";
}

/** Files read per tick of the initial scan - the extension host is shared,
 *  and reading a large workspace's classes in one go blocks it. */
const SCAN_SLICE = 50;

let registered = false;

export function registerClassIndex(context: vscode.ExtensionContext): void {
  if (!store.enabled || registered) {
    return;
  }
  registered = true;
  watchAbapSources(context);

  let lastGeneration = store.generation;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (notifyTimer) {
      clearTimeout(notifyTimer);
    }
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      const now = store.generation;
      if (now !== lastGeneration) {
        lastGeneration = now;
        changed.fire();
      }
    }, 300);
  };

  /** The keys the glob found - files, whatever their scheme (on vscode.dev a
   *  workspace file is `vscode-vfs:`, not `file:`). An open document that is
   *  not among them is a class from a system, contributed by its editor. */
  const onDisk = new Set<string>();
  let scanning: Promise<void> | undefined;
  let rescan = false;
  const fullScan = async (): Promise<void> => {
    if (scanning) {
      rescan = true;
      return scanning;
    }
    scanning = (async () => {
      const seen = new Set<string>();
      let n = 0;
      try {
        const sources = await abapSources();
        onDisk.clear();
        for (const source of sources) {
          const key = source.uri.toString();
          seen.add(key);
          if (!source.fromEditor) {
            onDisk.add(key);
          }
          store.set(key, source.text);
          if (++n % SCAN_SLICE === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
      } catch {
        return; // a workspace that cannot be globbed keeps what it had
      }
      store.retain(seen);
      settle();
    })();
    try {
      await scanning;
    } finally {
      scanning = undefined;
      if (rescan) {
        rescan = false;
        void fullScan();
      }
    }
  };

  const readFile = async (uri: vscode.Uri): Promise<void> => {
    const key = uri.toString();
    // an open document without a file is the editor's own, never re-read
    try {
      store.set(key, new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
      onDisk.add(key);
    } catch {
      store.delete(key);
      onDisk.delete(key);
    }
    settle();
  };

  context.subscriptions.push(
    {
      dispose: () => {
        registered = false;
        if (notifyTimer) {
          clearTimeout(notifyTimer);
        }
      },
    },
    // created / changed / deleted on disk (a pull, another tool) - that file
    // only; the folders themselves changing is a rescan
    onDidChangeAbapSources((uri) => {
      if (uri) {
        void readFile(uri);
      } else {
        void fullScan();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        store.set(doc.uri.toString(), doc.getText());
        settle();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      // a class from a system has no file the scan finds - its editor text
      // is the class; a file is in already, from disk
      if (isAbapDocument(doc) && !onDisk.has(doc.uri.toString())) {
        store.set(doc.uri.toString(), doc.getText());
        settle();
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isAbapDocument(doc) && !onDisk.has(doc.uri.toString())) {
        store.delete(doc.uri.toString());
        settle();
      }
    })
  );
  void fullScan();
}
