import * as vscode from "vscode";
import * as fs from "fs";
import { classDefinitionOffset, usesBuilder } from "./abap";
import { CONFIG_SECTION } from "./settings";
import { isAppSource, onDidRefreshAppClasses } from "./appclasses";
import { eventRaises, whenBranches } from "./context";
import { fixableCount } from "./quickfix";
import { classOfFile, testIncludeFor } from "./unitrunner";
import { DIAG_SOURCE } from "./diagnostics";

/*
 * The things you do to an app class, offered where the class is declared.
 *
 * F9 and Ctrl+F3 are the fast path once you know them, but nothing in the
 * editor says they exist - the extension's whole dev loop was discoverable
 * only through the command palette. A lens above `CLASS … DEFINITION` costs
 * one line and makes it obvious.
 */

class AppCodeLens implements vscode.CodeLensProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  /** Re-emit when the setting is toggled - the lenses appear or vanish. */
  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (
      !vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>("codeLens", true)
    ) {
      return [];
    }
    const text = doc.getText();
    const app = isAppSource(text);
    const builder = usesBuilder(text);
    const tested = hasTestInclude(doc);
    if (!app && !builder && !tested) {
      return [];
    }
    const anchor = doc.positionAt(classDefinitionOffset(text));
    const range = new vscode.Range(anchor, anchor);
    const lenses: vscode.CodeLens[] = [];
    if (app) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(play) Run",
          tooltip: "Launch this app in the preview (F9)",
          command: "abap2ui5.run",
        }),
        new vscode.CodeLens(range, {
          title: "$(zap) Activate & reload",
          tooltip: "Activate through your ABAP tooling, then reload the preview",
          command: "abap2ui5.activate",
        })
      );
    }
    if (builder) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(checklist) Check views",
          tooltip: "Run the static view check on this class",
          command: "abap2ui5.checkViews",
        })
      );
      lenses.push(...fixLens(range, doc));
      lenses.push(...whenLenses(doc, text));
    }
    if (tested) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: "$(beaker) Run unit tests",
          tooltip:
            "Run this class's ABAP Unit tests in the transpiled abap2UI5 backend - no system needed",
          command: "abap2ui5.runUnitTests",
          arguments: [{ uri: doc.uri }],
        })
      );
    }
    return lenses;
  }
}

/**
 * Whether a `<class>.clas.testclasses.abap` sits next to the class file - the
 * one condition for the test lens. Not gated on the class being an app: the
 * runner runs every class with a test include, and a helper class with tests
 * is exactly the kind of class that has nothing else to offer up here. A
 * synchronous `existsSync`, because a CodeLens provider cannot await, and
 * one stat per lens pass is what the autofix lens already costs.
 */
function hasTestInclude(doc: vscode.TextDocument): boolean {
  if (doc.uri.scheme !== "file") {
    return false;
  }
  const key = doc.uri.toString();
  const known = testIncludes.get(key);
  if (known !== undefined) {
    return known;
  }
  const include = testIncludeFor(doc.uri.fsPath);
  let exists = false;
  if (include) {
    try {
      exists = fs.existsSync(include);
    } catch {
      exists = false;
    }
  }
  testIncludes.set(key, exists);
  return exists;
}

/**
 * The `existsSync` answers, per class uri. A lens pass runs on every change
 * of the document and on every refresh the provider is asked for, and the
 * answer only moves when a test include is created or deleted - which the
 * watcher in `registerCodeLens` reports. The shared ABAP watcher cannot: its
 * glob matches every `.clas.abap`, and a test include ends in
 * `.testclasses.abap`.
 */
const testIncludes = new Map<string, boolean>();

/** The class file a test include belongs to - the memo entry its change
 *  invalidates (`zcl_app.clas.testclasses.abap` -> `zcl_app.clas.abap`). */
function classUriOfInclude(include: vscode.Uri): vscode.Uri | undefined {
  if (!classOfFile(include.path)) {
    return undefined;
  }
  return include.with({
    path: include.path.replace(/\.clas\.testclasses\.abap$/i, ".clas.abap"),
  });
}

/**
 * The autofix, next to the check that finds the work: "Autofix n finding(s)",
 * running the same `abap2ui5.fixAll` the palette and `source.fixAll.abap2ui5`
 * do.
 *
 * It carries the count and disappears at zero on purpose. A lens that is
 * always there says nothing about whether pressing it would do anything -
 * and the mechanical fixes are exactly the findings nobody should have to
 * read first, so the number is the whole message. Findings whose correction
 * would have to guess carry no fix and are not counted here: those stay a
 * lightbulb decision on the line itself.
 */
function fixLens(range: vscode.Range, doc: vscode.TextDocument): vscode.CodeLens[] {
  const count = fixableCount(doc);
  if (!count) {
    return [];
  }
  return [
    new vscode.CodeLens(range, {
      title: `$(wrench) Autofix ${count} finding${count === 1 ? "" : "s"}`,
      tooltip: "Apply every mechanical correction the view check found in this file",
      command: "abap2ui5.fixAll",
    }),
  ];
}

/**
 * One lens over every `WHEN '…'` the view actually raises: "raised n× in
 * the view", opening a peek at the `_event( )` call(s). A WHEN nothing
 * raises gets no lens - the CASE may switch over something else entirely,
 * and a wrong "0×" would accuse innocent code.
 *
 * And the counterpart on the raise: an `_event( )` naming an event no WHEN
 * of the class handles gets a lens saying so - the wire that addresses
 * nothing does nothing at runtime, silently. Only when the class dispatches
 * at all (it has WHEN branches); a class handing its events elsewhere would
 * otherwise be accused on every raise.
 *
 * One scan of the source serves every lens: the raises are indexed once,
 * where each branch used to re-read the whole class for its own count.
 */
function whenLenses(doc: vscode.TextDocument, text: string): vscode.CodeLens[] {
  const lenses: vscode.CodeLens[] = [];
  const raises = eventRaises(text);
  const branches = whenBranches(text);
  const raisesByName = new Map<string, number[]>();
  for (const raise of raises) {
    const key = raise.name.toUpperCase();
    const list = raisesByName.get(key) ?? [];
    list.push(raise.at);
    raisesByName.set(key, list);
  }
  const handled = new Set(branches.map((branch) => branch.name.toUpperCase()));

  for (const branch of branches) {
    const usages = raisesByName.get(branch.name.toUpperCase());
    if (!usages?.length) {
      continue;
    }
    const at = doc.positionAt(branch.start);
    const locations = usages.map((usage) => {
      const pos = doc.positionAt(usage);
      return new vscode.Location(doc.uri, doc.lineAt(pos.line).range);
    });
    lenses.push(
      new vscode.CodeLens(new vscode.Range(at, at), {
        title: `$(zap) raised ${usages.length}× in the view`,
        tooltip: `Peek the _event( ) ${
          usages.length === 1 ? "call" : "calls"
        } raising this event`,
        command: "editor.action.showReferences",
        arguments: [doc.uri, at, locations],
      })
    );
  }

  if (branches.length) {
    const flagged = new Set<string>();
    for (const raise of raises) {
      const key = raise.name.toUpperCase();
      if (handled.has(key) || flagged.has(key)) {
        continue;
      }
      flagged.add(key);
      const at = doc.positionAt(raise.at);
      lenses.push(
        new vscode.CodeLens(new vscode.Range(at, at), {
          title: `$(warning) '${raise.name}' has no WHEN branch`,
          tooltip:
            "The view raises this event, but no WHEN of this class handles it - " +
            "at runtime the raise does nothing, silently.",
          command: "",
        })
      );
    }
  }
  return lenses;
}

export function registerCodeLens(context: vscode.ExtensionContext): void {
  const provider = new AppCodeLens();
  // Over the test includes alone - the shared ABAP watcher's glob does not
  // reach them (see `testIncludes`).
  const includeWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.clas.testclasses.abap"
  );
  const includeChanged = (include: vscode.Uri): void => {
    const cls = classUriOfInclude(include);
    if (cls) {
      testIncludes.delete(cls.toString());
      provider.refresh();
    }
  };
  context.subscriptions.push(
    provider,
    vscode.languages.registerCodeLensProvider({ language: "abap" }, provider),
    // whether a class INHERITS the interface is the index's answer, and the
    // index is rebuilt in the background
    onDidRefreshAppClasses(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("abap2ui5.codeLens")) {
        provider.refresh();
      }
    }),
    /* The autofix count follows the findings, and those change without the
     * document changing: a settings switch, an adopted baseline, the check
     * finishing after the keystroke that triggered it. Every one of them ends
     * in published diagnostics, so that is what the lens listens to.
     *
     * Every extension in the window fires this - abaplint on every
     * keystroke - so only a change that involves OUR findings on a visible
     * ABAP editor re-evaluates the lenses: a uri that carries one now, or
     * carried one the last time (then they were just removed), the same
     * filter `inlineview.ts` applies. */
    vscode.languages.onDidChangeDiagnostics((e) => {
      const open = new Set(
        vscode.window.visibleTextEditors
          .filter((editor) => editor.document.languageId === "abap")
          .map((editor) => editor.document.uri.toString())
      );
      let ours = false;
      for (const uri of e.uris) {
        const key = uri.toString();
        if (!open.has(key)) {
          continue;
        }
        const now = vscode.languages
          .getDiagnostics(uri)
          .some((d) => d.source === DIAG_SOURCE);
        if (now || withOurFindings.has(key)) {
          ours = true;
        }
        if (now) {
          withOurFindings.add(key);
        } else {
          withOurFindings.delete(key);
        }
      }
      if (ours) {
        provider.refresh();
      }
    }),
    // the "Run unit tests" lens follows the test include beside the class
    includeWatcher,
    includeWatcher.onDidCreate(includeChanged),
    includeWatcher.onDidDelete(includeChanged),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      testIncludes.clear();
      provider.refresh();
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      testIncludes.delete(doc.uri.toString());
    })
  );
}

/** The visible ABAP editors that carried one of our diagnostics at the last
 *  change notice - see the `onDidChangeDiagnostics` listener. */
const withOurFindings = new Set<string>();
