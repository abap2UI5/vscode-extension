import * as vscode from "vscode";
import { isAppClass, isAppInfoDeep, superclassOf } from "./abap";
import {
  AppClassEntry,
  AppClassIndex,
  appClassEntryOf,
  buildAppIndex,
  isAppEntry,
  sameAppClassEntry,
} from "./appindex";
import {
  abapSources,
  invalidateAbapSource,
  isAbapDocument,
  onDidChangeAbapSources,
  readAbapSource,
  watchAbapSources,
} from "./abapsources";

/*
 * "Is this class an abap2UI5 app?" - answered for a class that INHERITS the
 * interface as well as for one that writes it.
 *
 * A shared base class carrying `INTERFACES z2ui5_if_app` and the lifecycle
 * methods, with each app redefining them, is a common way to keep a team's
 * apps uniform - and the extension recognised none of them: F9, the CodeLens,
 * the apps tree and the navigation map all read the interface out of the class
 * in front of them and went quiet (abap2UI5/vscode-extension#81).
 *
 * Following the chain needs the SUPERCLASS's source, which is another file (or
 * another ADT document), and the callers all ask synchronously - a CodeLens
 * provider cannot await a workspace scan per keystroke. So the window's
 * classes are indexed in the background and the question is answered from that
 * index.
 *
 * The index remembers per class only what the walk asks - "is it an app" and
 * "what does it inherit from" (`AppClassInfo`), not the source text: keeping
 * every class's full source made the index cost megabytes in a big workspace
 * for two booleans' worth of answer.
 *
 * What the index costs is freshness: a base class created after the last
 * refresh is not known until the next one. That is why every save of an ABAP
 * document updates its entry, every change on disk re-reads that file, and
 * why the answer for an unknown parent is "not an app" rather than a guess -
 * the same answer the extension gave before, so a stale index can only ever
 * be as wrong as the old behaviour was.
 *
 * LAZY, and built in slices. Nothing is read until the window shows an ABAP
 * document or something asks the index (`isAppSource` on a class with a
 * superclass, the apps tree): the extension activates on any XML file
 * (`onLanguage:xml`), and a window with no ABAP in it must not pay for a
 * workspace scan. The rebuild parses `BUILD_SLICE` classes per turn of the
 * host (`appindex.ts`), and a rebuild asked for while one runs supersedes
 * it at the next slice - the older one never replaces the index.
 *
 * The index also carries what the apps tree shows (`AppClassEntry`: uri,
 * builds views, from an editor), so a save updates one node of the tree
 * instead of re-reading the workspace.
 */

/** Upper-cased class name -> what the walk asks of it and what the tree
 *  shows, for the classes this window sees. The bookkeeping - including what
 *  a rename has to drop - lives `vscode`-free in appindex.ts, where the test
 *  suite can reach it. */
const index = new AppClassIndex<AppClassEntry>();
/** The keys the last rebuild found on disk (whatever their scheme) - an open
 *  document not among them is a class from a system, `fromEditor`. */
const onDisk = new Set<string>();
let refreshing: Promise<void> | undefined;
let rerun = false;
let started = false;
let ready = false;
let scheduled: NodeJS.Timeout | undefined;
/** Files the watcher reported, waiting for the debounced flush. */
const pendingFiles = new Map<string, vscode.Uri>();
/** Above this many files in one burst (a branch switch) the index is
 *  rebuilt whole rather than file by file. */
const FULL_REBUILD_ABOVE = 100;
const DEBOUNCE_MS = 500;

/** Upper-cased class name -> the OPEN document that defines it - the version
 *  being edited beats whatever the index read from disk. Maintained by the
 *  open/save/close listeners below; `infoOf` used to find this out by
 *  scanning every open document per inheritance hop on every CodeLens pass. */
const openByName = new Map<string, vscode.TextDocument>();

/** Fires when the index's content moved: a background rebuild replaced it,
 *  or a save, an open, a close or a change on disk updated entries in place.
 *  The apps tree and the CodeLens ask `isAppSource` synchronously, and their
 *  own debounced refreshes usually run BEFORE the rebuild a `git pull` or
 *  the first ABAP document started has finished - so a subclass of a base
 *  class that just arrived stayed out of the tree, and without its lens,
 *  until some unrelated event asked again. */
const refreshed = new vscode.EventEmitter<void>();
export const onDidRefreshAppClasses = refreshed.event;

/** What an open document last told us about itself, keyed on the document so
 *  a closed one falls away with it. Re-derived only when the version moved. */
const docNames = new WeakMap<vscode.TextDocument, { version: number; entry: AppClassEntry }>();

function docEntry(doc: vscode.TextDocument): AppClassEntry {
  let memo = docNames.get(doc);
  if (!memo || memo.version !== doc.version) {
    const key = doc.uri.toString();
    memo = {
      version: doc.version,
      entry: appClassEntryOf({
        key,
        path: doc.uri.path,
        text: doc.getText(),
        fromEditor: !onDisk.has(key),
      }),
    };
    docNames.set(doc, memo);
  }
  return memo.entry;
}

/** Open documents first: they are what the user is editing, so their state
 *  beats whatever is on disk for the same class. Also (re)seeds the
 *  name->document map - documents already open at activation never fire
 *  onDidOpenTextDocument - and records which name each document contributes,
 *  which is what a later rename knows to delete. */
function openDocuments(into: Map<string, AppClassEntry>): Map<string, string> {
  const contributed = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (!isAbapDocument(doc)) {
      continue;
    }
    const entry = docEntry(doc);
    into.set(entry.name, entry);
    contributed.set(doc.uri.toString(), entry.name);
    openByName.set(entry.name, doc);
  }
  return contributed;
}

/**
 * Rebuilds the index from the workspace's files and the open documents, in
 * slices (`buildAppIndex`). A request landing while a rebuild is running
 * supersedes it: the in-flight pass read the files before the change that
 * asked for it, so it stops at its next slice and the fresh one runs - the
 * promise every caller holds resolves when a rebuild has finally landed.
 */
export function refreshAppClasses(): Promise<void> {
  started = true;
  if (refreshing) {
    rerun = true;
    return refreshing;
  }
  refreshing = (async () => {
    for (;;) {
      rerun = false;
      const built = await rebuildOnce();
      if (built) {
        return;
      }
      // superseded - the loop runs the newer request
    }
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/** One pass; false when superseded before it could land. */
async function rebuildOnce(): Promise<boolean> {
  let sources: Awaited<ReturnType<typeof abapSources>> = [];
  try {
    sources = await abapSources();
  } catch {
    // a workspace that cannot be globbed still has its open documents
  }
  if (rerun) {
    return false;
  }
  const next = await buildAppIndex(
    sources.map((source) => ({
      key: source.uri.toString(),
      path: source.uri.path,
      text: source.text,
      fromEditor: source.fromEditor,
    })),
    { superseded: () => rerun }
  );
  if (!next) {
    return false;
  }
  onDisk.clear();
  for (const source of sources) {
    if (!source.fromEditor) {
      onDisk.add(source.uri.toString());
    }
  }
  // the open documents' entries were memoised under the previous onDisk set
  for (const doc of vscode.workspace.textDocuments) {
    docNames.delete(doc);
  }
  const contributed = openDocuments(next);
  index.replace(next, contributed);
  ready = true;
  refreshed.fire();
  return true;
}

/** Starts the first build when nothing has yet - the first ABAP document the
 *  window shows, the first class with a superclass asked about, the apps
 *  tree's first ask. */
function ensureStarted(): void {
  if (!started) {
    void refreshAppClasses();
  }
}

/** One document's entry, updated in place - a save can only change that one
 *  class, so the whole workspace does not need to be re-read for it.
 *
 *  A renamed class leaves its OLD name behind: the index kept answering for a
 *  name the window no longer has, so `isAppSource` still followed
 *  `INHERITING FROM` to a base class that had been renamed away. Which name
 *  to drop is the index's own record of what this document contributed
 *  (appindex.ts) - it used to be an object-identity check against the
 *  `docNames` memo, which every lookup and every background rebuild
 *  refreshes as a side effect, so a rebuild landing between the rename
 *  keystroke and the save left the stale name in place.
 *
 *  The change is announced only when the entry differs from what the index
 *  held for that name (`sameAppClassEntry`) or a name was renamed away: the
 *  apps tree re-rendered whole on every save and every open, almost all of
 *  which change nothing it shows. */
function updateFromDocument(doc: vscode.TextDocument): void {
  const entry = docEntry(doc);
  const previous = index.get(entry.name);
  const stale = index.update(doc.uri.toString(), entry.name, entry);
  if (stale !== undefined) {
    const other = openByName.get(stale);
    if (other && other !== doc && docEntry(other).name === stale) {
      // another open document still defines the old name - its answer stands
      index.restore(stale, docEntry(other));
    } else if (other === doc) {
      openByName.delete(stale);
    }
  }
  openByName.set(entry.name, doc);
  if (stale !== undefined || !sameAppClassEntry(previous, entry)) {
    refreshed.fire();
  }
}

/**
 * The files the watcher reported since the last flush, applied one by one:
 * a file that is open in the window is the editor's business (its save
 * updated the entry already, or its reload will); any other is read again
 * - gone from disk, its entry goes. A burst above `FULL_REBUILD_ABOVE`, or
 * one landing while a rebuild runs (which read the files before the change),
 * is a rebuild instead - the way a request during a rebuild always was.
 */
async function flushPendingFiles(): Promise<void> {
  const files = [...pendingFiles.values()];
  pendingFiles.clear();
  if (!files.length) {
    return;
  }
  if (refreshing || files.length > FULL_REBUILD_ABOVE) {
    void refreshAppClasses();
    return;
  }
  const open = new Set(
    vscode.workspace.textDocuments.filter(isAbapDocument).map((d) => d.uri.toString())
  );
  let moved = false;
  await Promise.all(
    files.map(async (uri) => {
      const key = uri.toString();
      if (open.has(key)) {
        return;
      }
      const text = await readAbapSource(uri);
      if (refreshing) {
        return; // a rebuild started meanwhile reads it itself
      }
      if (text === undefined) {
        onDisk.delete(key);
        if (index.remove(key, (entry) => entry.key) !== undefined) {
          moved = true;
        }
        return;
      }
      onDisk.add(key);
      const entry = appClassEntryOf({ key, path: uri.path, text, fromEditor: false });
      const previous = index.get(entry.name);
      const stale = index.update(key, entry.name, entry);
      if (stale !== undefined) {
        const other = openByName.get(stale);
        if (other && docEntry(other).name === stale) {
          index.restore(stale, docEntry(other));
        }
      }
      // a file saved without a change to what the tree shows (the usual
      // save) does not re-render it
      if (stale !== undefined || !sameAppClassEntry(previous, entry)) {
        moved = true;
      }
    })
  );
  if (moved) {
    refreshed.fire();
  }
}

/** What the window knows about a class, by name - the open document's current
 *  state when it is open, the indexed answer otherwise. */
function infoOf(className: string): AppClassEntry | undefined {
  const name = className.toUpperCase();
  const doc = openByName.get(name);
  if (doc) {
    const entry = docEntry(doc);
    if (entry.name === name) {
      return entry;
    }
    // renamed while being edited - the map learns about it on the next save
    // or open; until then the index answers for the name asked about
    openByName.delete(name);
    openByName.set(entry.name, doc);
  }
  return index.get(name);
}

/**
 * Whether this source is an abap2UI5 app - the question F9, the CodeLens, the
 * apps tree and the navigation map ask.
 *
 * Cheap for the common case: a class that writes the interface itself is
 * answered without touching the index at all. A class with a superclass is
 * the first thing that needs the index - and starts its build when nothing
 * has: "not an app" until it lands, then `onDidRefreshAppClasses` says so.
 */
export function isAppSource(source: string): boolean {
  if (isAppClass(source)) {
    return true;
  }
  if (!superclassOf(source)) {
    return false; // a root class that does not write it is not one
  }
  ensureStarted();
  return isAppInfoDeep(source, infoOf);
}

/**
 * The window's app classes, for the apps tree: every indexed class that
 * writes the interface or inherits it, with what the tree shows. Starts the
 * first build when nothing has, and waits for it - afterwards the answer is
 * the index as it stands, kept current in place.
 */
export async function appClassEntries(): Promise<AppClassEntry[]> {
  if (!ready) {
    await refreshAppClasses();
  }
  const out: AppClassEntry[] = [];
  for (const entry of index.entries()) {
    if (isAppEntry(entry, infoOf)) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Keeps the index current. The editor's own events update one entry in
 * place. They are not enough on their own: a `git pull`, a branch switch or
 * a class written by another tool adds or edits a base class carrying
 * `z2ui5_if_app` without any save, open or close in this window - and the
 * index then stayed stale indefinitely, so F9, the CodeLens and the apps tree
 * went quiet on every subclass of it. That is exactly the issue #81 symptom
 * this module exists to fix, so the shared file watcher feeds it too: the
 * reported files, debounced, read one by one (`flushPendingFiles`) - a full
 * rebuild only for a burst or a workspace folder coming or going.
 */
export function registerAppClasses(context: vscode.ExtensionContext): void {
  watchAbapSources(context);
  const schedule = (full: boolean) => {
    if (!started) {
      return; // nothing to keep current - the first build reads it all
    }
    if (full) {
      pendingFiles.clear();
    }
    if (scheduled) {
      clearTimeout(scheduled);
    }
    scheduled = setTimeout(() => {
      scheduled = undefined;
      if (full || pendingFiles.size === 0) {
        void refreshAppClasses();
      } else {
        void flushPendingFiles();
      }
    }, DEBOUNCE_MS);
  };

  context.subscriptions.push(
    refreshed,
    {
      dispose: () => {
        if (scheduled) {
          clearTimeout(scheduled);
          scheduled = undefined;
        }
        pendingFiles.clear();
      },
    },
    // a create / change / delete on disk that no editor event reports - the
    // one shared watcher over `**/*.clas.abap`; undefined is the folders
    onDidChangeAbapSources((uri) => {
      if (!started) {
        return;
      }
      if (uri) {
        pendingFiles.set(uri.toString(), uri);
      }
      schedule(uri === undefined);
    }),
    // a save or an open concerns one document, and its entry is updated in
    // place - or, for the first ABAP document the window shows, starts the
    // index (whose open-documents pass covers it)
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        invalidateAbapSource(doc.uri);
        if (started) {
          updateFromDocument(doc);
        } else {
          ensureStarted();
        }
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        if (started) {
          updateFromDocument(doc);
        } else {
          ensureStarted();
        }
      }
    }),
    // a closed ADT or untitled document leaves the window's view - its map
    // entry goes at once; a file on disk keeps its entry (the index read it
    // from there), a class only its editor contributed goes with it
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        const memo = docNames.get(doc);
        if (memo && openByName.get(memo.entry.name) === doc) {
          openByName.delete(memo.entry.name);
        }
        const key = doc.uri.toString();
        if (onDisk.has(key)) {
          index.forget(key);
        } else {
          index.remove(key, (entry) => entry.key);
        }
        if (started) {
          refreshed.fire();
        }
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule(true))
  );
  // an ABAP document already open at activation is the first one shown
  if (vscode.workspace.textDocuments.some(isAbapDocument)) {
    ensureStarted();
  }
}
