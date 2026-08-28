import * as vscode from "vscode";
import { classNameOf, isAppClass, isAppClassDeep, superclassOf } from "./abap";
import { abapSources, isAbapDocument } from "./abapsources";

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
 * What the index costs is freshness: a base class created after the last
 * refresh is not known until the next one. That is why every save of an ABAP
 * document schedules one, and why the answer for an unknown parent is "not an
 * app" rather than a guess - the same answer the extension gave before, so a
 * stale index can only ever be as wrong as the old behaviour was.
 */

/** Upper-cased class name -> its source, for the classes this window sees. */
let index = new Map<string, string>();
let refreshing: Promise<void> | undefined;
let scheduled: NodeJS.Timeout | undefined;

/** Open documents first: they are what the user is editing, so their text
 *  beats whatever is on disk for the same class. */
function openDocuments(): Map<string, string> {
  const out = new Map<string, string>();
  for (const doc of vscode.workspace.textDocuments) {
    if (!isAbapDocument(doc)) {
      continue;
    }
    const text = doc.getText();
    out.set(classNameOf(text, doc.uri.path), text);
  }
  return out;
}

/** Rebuilds the index from the workspace's files and the open documents. */
export async function refreshAppClasses(): Promise<void> {
  if (refreshing) {
    return refreshing;
  }
  refreshing = (async () => {
    const next = new Map<string, string>();
    try {
      for (const source of await abapSources()) {
        next.set(classNameOf(source.text, source.uri.path), source.text);
      }
    } catch {
      // a workspace that cannot be globbed still has its open documents
    }
    for (const [name, text] of openDocuments()) {
      next.set(name, text);
    }
    index = next;
  })();
  try {
    await refreshing;
  } finally {
    refreshing = undefined;
  }
}

/** The source of a class this window knows, by name. */
function sourceOf(className: string): string | undefined {
  const name = className.toUpperCase();
  // an open document wins - it is the version being edited
  for (const doc of vscode.workspace.textDocuments) {
    if (!isAbapDocument(doc)) {
      continue;
    }
    const text = doc.getText();
    if (classNameOf(text, doc.uri.path) === name) {
      return text;
    }
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
  return isAppClassDeep(source, sourceOf);
}

/**
 * Keeps the index roughly current. Deliberately coarse: a rebuild is cheap
 * next to a keystroke, and the only thing that can change the answer is a
 * class definition line.
 */
export function registerAppClasses(context: vscode.ExtensionContext): void {
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
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        schedule();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (isAbapDocument(doc)) {
        schedule();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => schedule())
  );
  void refreshAppClasses();
}
