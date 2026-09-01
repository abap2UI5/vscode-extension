import * as vscode from "vscode";
import {
  AppClassInfo,
  appClassInfoOf,
  classNameOf,
  isAppClass,
  isAppInfoDeep,
  superclassOf,
} from "./abap";
import {
  abapSources,
  invalidateAbapSource,
  isAbapDocument,
  onDidChangeAbapSources,
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
 * document schedules one, and why the answer for an unknown parent is "not an
 * app" rather than a guess - the same answer the extension gave before, so a
 * stale index can only ever be as wrong as the old behaviour was.
 */

/** Upper-cased class name -> what the walk asks of it, for the classes this
 *  window sees. */
let index = new Map<string, AppClassInfo>();
let refreshing: Promise<void> | undefined;
let rerun = false;
let scheduled: NodeJS.Timeout | undefined;

/** Upper-cased class name -> the OPEN document that defines it - the version
 *  being edited beats whatever the index read from disk. Maintained by the
 *  open/save/close listeners below; `infoOf` used to find this out by
 *  scanning every open document per inheritance hop on every CodeLens pass. */
const openByName = new Map<string, vscode.TextDocument>();

/** What an open document last told us about itself, keyed on the document so
 *  a closed one falls away with it. Re-derived only when the version moved. */
const docNames = new WeakMap<
  vscode.TextDocument,
  { version: number; name: string; info: AppClassInfo }
>();

function docEntry(
  doc: vscode.TextDocument
): { version: number; name: string; info: AppClassInfo } {
  let entry = docNames.get(doc);
  if (!entry || entry.version !== doc.version) {
    const text = doc.getText();
    entry = {
      version: doc.version,
      name: classNameOf(text, doc.uri.path),
      info: appClassInfoOf(text),
    };
    docNames.set(doc, entry);
  }
  return entry;
}

/** Open documents first: they are what the user is editing, so their state
 *  beats whatever is on disk for the same class. Also (re)seeds the
 *  name->document map - documents already open at activation never fire
 *  onDidOpenTextDocument. */
function openDocuments(): Map<string, AppClassInfo> {
  const out = new Map<string, AppClassInfo>();
  for (const doc of vscode.workspace.textDocuments) {
    if (!isAbapDocument(doc)) {
      continue;
    }
    const entry = docEntry(doc);
    out.set(entry.name, entry.info);
    openByName.set(entry.name, doc);
  }
  return out;
}

/** Rebuilds the index from the workspace's files and the open documents. A
 *  request landing while a rebuild is running marks it to run again - the
 *  in-flight pass read the files before the change that asked for it. */
export async function refreshAppClasses(): Promise<void> {
  if (refreshing) {
    rerun = true;
    return refreshing;
  }
  refreshing = (async () => {
    const next = new Map<string, AppClassInfo>();
    try {
      for (const source of await abapSources()) {
        next.set(classNameOf(source.text, source.uri.path), appClassInfoOf(source.text));
      }
    } catch {
      // a workspace that cannot be globbed still has its open documents
    }
    for (const [name, info] of openDocuments()) {
      next.set(name, info);
    }
    index = next;
  })();
  try {
    await refreshing;
  } finally {
    refreshing = undefined;
    if (rerun) {
      rerun = false;
      void refreshAppClasses();
    }
  }
}

/** One document's entry, updated in place - a save can only change that one
 *  class, so the whole workspace does not need to be re-read for it.
 *
 *  A renamed class leaves its OLD name behind: the index kept answering for a
 *  name the window no longer has, so `isAppSource` still followed
 *  `INHERITING FROM` to a base class that had been renamed away. The previous
 *  entry is dropped when it is still the one this document put there. */
function updateFromDocument(doc: vscode.TextDocument): void {
  const previous = docNames.get(doc);
  const entry = docEntry(doc);
  if (previous && previous.name !== entry.name) {
    if (index.get(previous.name) === previous.info) {
      index.delete(previous.name);
    }
    if (openByName.get(previous.name) === doc) {
      openByName.delete(previous.name);
    }
  }
  index.set(entry.name, entry.info);
  openByName.set(entry.name, doc);
}

/** What the window knows about a class, by name - the open document's current
 *  state when it is open, the indexed answer otherwise. */
function infoOf(className: string): AppClassInfo | undefined {
  const name = className.toUpperCase();
  const doc = openByName.get(name);
  if (doc) {
    const entry = docEntry(doc);
    if (entry.name === name) {
      return entry.info;
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
 * answered without touching the index at all.
 */
export function isAppSource(source: string): boolean {
  if (isAppClass(source)) {
    return true;
  }
  if (!superclassOf(source)) {
    return false; // a root class that does not write it is not one
  }
  return isAppInfoDeep(source, infoOf);
}

/**
 * Keeps the index roughly current. Deliberately coarse: a rebuild is cheap
 * next to a keystroke, and the only thing that can change the answer is a
 * class definition line.
 *
 * The editor's own events are not enough. A `git pull`, a branch switch or a
 * class written by another tool adds or edits a base class carrying
 * `z2ui5_if_app` without any save, open or close in this window - and the
 * index then stayed stale indefinitely, so F9, the CodeLens and the apps tree
 * went quiet on every subclass of it. That is exactly the issue #81 symptom
 * this module exists to fix, so the shared file watcher schedules a rebuild
 * too.
 */
export function registerAppClasses(context: vscode.ExtensionContext): void {
  watchAbapSources(context);
  const schedule = () => {
    if (scheduled) {
      clearTimeout(scheduled);
    }
    scheduled = setTimeout(() => {
      scheduled = undefined;
      void refreshAppClasses();
    }, 500);
  };

  context.subscriptions.push(
    {
      dispose: () => {
        if (scheduled) {
          clearTimeout(scheduled);
          scheduled = undefined;
        }
      },
    },
    // a create / change / delete on disk that no editor event reports - the
    // one shared watcher over `**/*.clas.abap`
    onDidChangeAbapSources(() => schedule()),
    // a save or an open concerns one document, and its entry is updated in
    // place - the full rebuild is for what those events cannot see
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        invalidateAbapSource(doc.uri);
        updateFromDocument(doc);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        updateFromDocument(doc);
      }
    }),
    // a closed ADT or untitled document leaves the window's view - its map
    // entry goes at once, and the rebuild refreshes the index (a file on
    // disk is picked up again)
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        const entry = docNames.get(doc);
        if (entry && openByName.get(entry.name) === doc) {
          openByName.delete(entry.name);
        }
        schedule();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule())
  );
  void refreshAppClasses();
}
