import * as vscode from "vscode";
import * as path from "path";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { addToBaseline } from "./baselinefile";
import { plannedFixes } from "./checkcore";
import { baselineFileFor, findingsNow, recheckOpenDocuments } from "./viewcheck";

/*
 * Quick fixes for the view-check findings.
 *
 * The linter already attaches `fixes: [{ start, end, text }]` to every finding
 * whose correction is mechanical - the current method name for an obsolete
 * binder, the missing `$` in an event argument, an ABAP boolean wrapped in
 * `as_bool( )`. A rule whose correction would have to guess (which of two
 * duplicate attributes survives) deliberately carries none, and there is
 * nothing to offer for it. All this module does is turn those spans into
 * workspace edits.
 *
 * Two more actions come with it: "fix everything in this file", which
 * `editor.codeActionsOnSave` can run through `source.fixAll.abap2ui5`, and a
 * suppression that writes the linter's own `abap2ui5lint-disable-next-line`
 * directive - the escape hatch CI honours too, rather than a setting only
 * this editor knows about.
 */

const DIAG_SOURCE = "abap2UI5-linter";

/** Our slice of "fix all" - so a user can opt in per language without
 *  triggering every other extension's fixers. */
const FIX_ALL = vscode.CodeActionKind.SourceFixAll.append("abap2ui5");

/** Moved to `selector.ts` so the web bundle can share it - re-exported here
 *  because the desktop modules historically import it from this file. */
export { VIEW_SELECTOR } from "./selector";
import { VIEW_SELECTOR } from "./selector";

/** The rule id behind a diagnostic, whether or not it carries a docs link. */
function ruleOf(diagnostic: vscode.Diagnostic): string | undefined {
  const code = diagnostic.code;
  if (typeof code === "string") {
    return code;
  }
  if (code && typeof code === "object" && "value" in code) {
    return String(code.value);
  }
  return undefined;
}

/** The edits one finding's fixes describe, in document coordinates. */
function editsOf(doc: vscode.TextDocument, finding: PropertyFinding): vscode.TextEdit[] {
  return (finding.fixes ?? []).map(
    (fix) =>
      new vscode.TextEdit(
        new vscode.Range(doc.positionAt(fix.start), doc.positionAt(fix.end)),
        fix.text
      )
  );
}

/** The span a finding's fixes touch - what decides whether the lightbulb
 *  offers it at the cursor. */
function spanOf(edits: vscode.TextEdit[]): vscode.Range {
  return new vscode.Range(edits[0].range.start, edits[edits.length - 1].range.end);
}

/** Line overlap rather than character overlap: the cursor usually sits
 *  somewhere on the squiggled line, not exactly inside the replaced token. */
function touchesLines(a: vscode.Range, b: vscode.Range): boolean {
  return a.start.line <= b.end.line && a.end.line >= b.start.line;
}

/**
 * The directive that waives a rule for the next line, in the comment syntax
 * of the file it goes into. Indented like the line it protects, so it does
 * not stand out in otherwise aligned ABAP.
 */
function suppressionFor(
  doc: vscode.TextDocument,
  line: number,
  rule: string
): vscode.TextEdit {
  const text = doc.lineAt(line).text;
  const indent = /^[ \t]*/.exec(text)?.[0] ?? "";
  const isXml = /\.(view|fragment)\.xml$/i.test(doc.fileName) || doc.languageId === "xml";
  const directive = `abap2ui5lint-disable-next-line ${rule}`;
  const comment = isXml ? `<!-- ${directive} -->` : `" ${directive}`;
  return vscode.TextEdit.insert(
    new vscode.Position(line, 0),
    `${indent}${comment}\n`
  );
}

class ViewCheckActions implements vscode.CodeActionProvider {
  static readonly kinds = [
    vscode.CodeActionKind.QuickFix,
    FIX_ALL,
    vscode.CodeActionKind.SourceFixAll,
  ];

  provideCodeActions(
    doc: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];
    let findings: PropertyFinding[];
    try {
      findings = findingsNow(doc);
    } catch {
      return actions; // an unparsable buffer mid-edit is not worth reporting
    }

    // --- one action per fixable finding at the cursor ---------------------
    const fixable = findings.filter((f) => f.fixes?.length);
    for (const finding of fixable) {
      const edits = editsOf(doc, finding);
      if (!edits.length || !touchesLines(range, spanOf(edits))) {
        continue;
      }
      const action = new vscode.CodeAction(
        `abap2UI5: fix ${finding.type}`,
        vscode.CodeActionKind.QuickFix
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.set(doc.uri, edits);
      action.diagnostics = context.diagnostics.filter(
        (d) => ruleOf(d) === finding.type
      );
      action.isPreferred = true;
      actions.push(action);
    }

    // --- fix everything this file has ------------------------------------
    const all = applyAll(doc, fixable);
    if (all) {
      for (const kind of [FIX_ALL, vscode.CodeActionKind.SourceFixAll]) {
        const action = new vscode.CodeAction(
          `abap2UI5: fix all ${all.count} finding(s) in this file`,
          kind
        );
        action.edit = all.edit;
        actions.push(action);
      }
    }

    // --- waive one line, the way the CLI understands it -------------------
    const baselineFile = baselineFileFor(doc);
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAG_SOURCE) {
        continue;
      }
      const rule = ruleOf(diagnostic);
      if (!rule || rule === "render-error") {
        continue; // the render gate is switched off wholesale, not per line
      }
      const action = new vscode.CodeAction(
        `abap2UI5: suppress ${rule} on this line`,
        vscode.CodeActionKind.QuickFix
      );
      action.edit = new vscode.WorkspaceEdit();
      action.edit.set(doc.uri, [
        suppressionFor(doc, diagnostic.range.start.line, rule),
      ]);
      action.diagnostics = [diagnostic];
      actions.push(action);

      // --- adopt into the baseline, when the repo config names one --------
      if (baselineFile) {
        const finding =
          findings.find(
            (f) =>
              f.type === rule &&
              typeof f.line === "number" &&
              f.line - 1 === diagnostic.range.start.line
          ) ?? findings.find((f) => f.type === rule);
        if (finding) {
          const baseline = new vscode.CodeAction(
            `abap2UI5: add ${rule} to ${path.basename(baselineFile)}`,
            vscode.CodeActionKind.QuickFix
          );
          baseline.command = {
            command: "abap2ui5.addToBaseline",
            title: "Add to baseline",
            arguments: [baselineFile, doc.uri.fsPath, finding],
          };
          baseline.diagnostics = [diagnostic];
          actions.push(baseline);
        }
      }
    }

    return actions;
  }
}

/**
 * Every fix in the file as one edit - `plannedFixes( )` decides which of them
 * survive together, in document coordinates here.
 */
function applyAll(
  doc: vscode.TextDocument,
  findings: PropertyFinding[]
): { edit: vscode.WorkspaceEdit; count: number } | undefined {
  const edits = plannedFixes(findings).map(
    (fix) =>
      new vscode.TextEdit(
        new vscode.Range(doc.positionAt(fix.start), doc.positionAt(fix.end)),
        fix.text
      )
  );
  if (!edits.length) {
    return undefined;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(doc.uri, edits);
  return { edit, count: edits.length };
}

/**
 * How many corrections `abap2ui5.fixAll` would apply to this document right
 * now - what the code lens above the class definition offers, so a run that
 * would report "nothing here can be corrected mechanically" is never offered
 * in the first place.
 *
 * Cheap enough for a lens: `findingsNow( )` is memoised per document version
 * and shared with the code actions, so the gate runs once per edit no matter
 * how many of the three ask. An unparsable buffer mid-edit has nothing to
 * offer rather than something to report.
 */
export function fixableCount(doc: vscode.TextDocument): number {
  try {
    return plannedFixes(findingsNow(doc)).length;
  } catch {
    return 0;
  }
}

export function registerQuickFix(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(VIEW_SELECTOR, new ViewCheckActions(), {
      providedCodeActionKinds: ViewCheckActions.kinds,
    }),
    vscode.commands.registerCommand(
      "abap2ui5.addToBaseline",
      (baselineFile: string, sourceFile: string, finding: PropertyFinding) => {
        try {
          const key = addToBaseline(baselineFile, sourceFile, finding);
          log(`quick-fix: baselined ${key} in ${baselineFile}`);
          recheckOpenDocuments();
        } catch (err) {
          vscode.window.showWarningMessage(
            `abap2UI5: could not update ${baselineFile} - ${String(err)}`
          );
        }
      }
    ),
    vscode.commands.registerCommand("abap2ui5.fixAll", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("abap2UI5: no file open to fix.");
        return;
      }
      const all = applyAll(
        editor.document,
        findingsNow(editor.document).filter((f) => f.fixes?.length)
      );
      if (!all) {
        vscode.window.showInformationMessage(
          "abap2UI5: nothing here can be corrected mechanically."
        );
        return;
      }
      await vscode.workspace.applyEdit(all.edit);
      log(`quick-fix: applied ${all.count} fix(es) to ${editor.document.fileName}`);
      vscode.window.showInformationMessage(
        `abap2UI5: applied ${all.count} fix(es).`
      );
    })
  );
  log("quick-fix: code action provider registered");
}
