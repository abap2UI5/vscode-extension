import * as vscode from "vscode";
import { DIAG_SOURCE, ruleOf } from "./diagnostics";

import * as path from "path";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { addToBaseline } from "./baselinefile";
import { directiveLine, plannedFixes } from "./checkcore";
import { clearBaselineCache } from "./lintconfig";
import { CONFIG_SECTION } from "./settings";
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


/** Our slice of "fix all" - so a user can opt in per language without
 *  triggering every other extension's fixers. */
const FIX_ALL = vscode.CodeActionKind.SourceFixAll.append("abap2ui5");

/** Moved to `selector.ts` so the web bundle can share it - re-exported here
 *  because the desktop modules historically import it from this file. */
export { VIEW_SELECTOR } from "./selector";
import { VIEW_SELECTOR } from "./selector";


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

function isXmlDoc(doc: vscode.TextDocument): boolean {
  return /\.(view|fragment)\.xml$/i.test(doc.fileName) || doc.languageId === "xml";
}

/** Where the directive goes and how it is indented. In XML the finding's
 *  line is often an attribute line inside a multi-line start tag, and a
 *  comment may not go there - see `directiveLine`. */
function suppressionSpot(
  doc: vscode.TextDocument,
  line: number
): { target: number; indent: string } {
  const target = directiveLine(doc.getText(), line, isXmlDoc(doc));
  const indent = /^[ \t]*/.exec(doc.lineAt(target).text)?.[0] ?? "";
  return { target, indent };
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
  const { target, indent } = suppressionSpot(doc, line);
  const directive = `abap2ui5lint-disable-next-line ${rule}`;
  const comment = isXmlDoc(doc) ? `<!-- ${directive} -->` : `" ${directive}`;
  return vscode.TextEdit.insert(
    new vscode.Position(target, 0),
    `${indent}${comment}\n`
  );
}

/**
 * The same directive with a `-- <reason>` tail, as a snippet whose
 * placeholder is the reason - the linter ignores everything after `--`, so
 * the waiver documents itself where CI reads it. ABAP only: in XML the
 * comment's own `-->` is the `--`, and a second one inside it would not be
 * well-formed.
 */
function suppressionWithReason(
  doc: vscode.TextDocument,
  line: number,
  rule: string
): vscode.SnippetTextEdit {
  const { target, indent } = suppressionSpot(doc, line);
  const snippet = new vscode.SnippetString();
  snippet.appendText(`${indent}" abap2ui5lint-disable-next-line ${rule} -- `);
  snippet.appendPlaceholder("why");
  snippet.appendText("\n");
  return new vscode.SnippetTextEdit(
    new vscode.Range(target, 0, target, 0),
    snippet
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
    // One action, under our own sub-kind. `source.fixAll.abap2ui5` matches a
    // request filtering for `source.fixAll` (VS Code matches kinds by prefix),
    // so codeActionsOnSave still finds it - while contributing both put two
    // identical entries in the menu for every such request.
    const all = applyAll(doc, fixable);
    if (all) {
      const action = new vscode.CodeAction(
        `abap2UI5: fix all ${all.findings} finding(s) in this file`,
        FIX_ALL
      );
      action.edit = all.edit;
      actions.push(action);
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

      if (!isXmlDoc(doc)) {
        const reasoned = new vscode.CodeAction(
          `abap2UI5: suppress ${rule} on this line, with a reason`,
          vscode.CodeActionKind.QuickFix
        );
        reasoned.edit = new vscode.WorkspaceEdit();
        reasoned.edit.set(doc.uri, [
          suppressionWithReason(doc, diagnostic.range.start.line, rule),
        ]);
        reasoned.diagnostics = [diagnostic];
        actions.push(reasoned);
      }

      /* --- switch the rule off everywhere ---------------------------------
       *
       * The setting exists, but a rule id is not something anybody knows by
       * heart - and the moment you want a rule gone is the moment you are
       * looking at one of its findings. This writes the id into
       * `viewCheck.rules` for you, at workspace scope: the project this rule
       * is noisy in, not every project you open. */
      const offAction = new vscode.CodeAction(
        `abap2UI5: turn off ${rule} in this workspace`,
        vscode.CodeActionKind.QuickFix
      );
      offAction.command = {
        command: "abap2ui5.disableRule",
        title: "Turn the rule off",
        arguments: [rule],
      };
      offAction.diagnostics = [diagnostic];
      actions.push(offAction);

      // --- adopt into the baseline, when the repo config names one --------
      // Only the finding on the diagnostic's own line: falling back to the
      // first finding of the same rule could baseline a DIFFERENT one - its
      // key carries control/member/value - leaving the clicked squiggle
      // standing and waiving an unrelated finding. If the buffer moved since
      // the diagnostics were published, the action is simply not offered
      // until the next check.
      if (baselineFile) {
        const finding = findings.find(
          (f) =>
            f.type === rule &&
            typeof f.line === "number" &&
            f.line - 1 === diagnostic.range.start.line
        );
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
): { edit: vscode.WorkspaceEdit; count: number; findings: number } | undefined {
  const planned = plannedFixes(findings);
  const edits = planned.map(
    (fix) =>
      new vscode.TextEdit(
        new vscode.Range(doc.positionAt(fix.start), doc.positionAt(fix.end)),
        fix.text
      )
  );
  if (!edits.length) {
    return undefined;
  }
  // A finding may carry several fix spans, so the number of edits is not the
  // number of findings - and "fix all 3 finding(s)" for one finding with
  // three spans is a count of the wrong thing.
  const applied = new Set(planned);
  const covered = findings.filter((finding) =>
    (finding.fixes ?? []).some((fix) => applied.has(fix))
  ).length;
  const edit = new vscode.WorkspaceEdit();
  edit.set(doc.uri, edits);
  return { edit, count: edits.length, findings: covered };
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
          // the memo is keyed on mtime, and this write may land in the same
          // second as the read that filled it
          clearBaselineCache(baselineFile);
          recheckOpenDocuments();
        } catch (err) {
          vscode.window.showWarningMessage(
            `abap2UI5: could not update ${baselineFile} - ${String(err)}`
          );
        }
      }
    ),
    vscode.commands.registerCommand("abap2ui5.disableRule", async (rule: string) => {
      if (!rule) {
        return;
      }
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const rules = { ...(cfg.get<Record<string, unknown>>("viewCheck.rules") ?? {}) };
      rules[rule] = false;
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      try {
        await cfg.update("viewCheck.rules", rules, target);
      } catch (err) {
        // no workspace to write to, a read-only settings file, a policy
        vscode.window.showWarningMessage(
          `abap2UI5: could not turn ${rule} off - ${String(err)}`
        );
        return;
      }
      log(`quick-fix: ${rule} switched off in the settings`);
      const undo = "Undo";
      const picked = await vscode.window.showInformationMessage(
        `abap2UI5: ${rule} is off. A repository's abap2ui5lint.jsonc still ` +
          "wins for the rules it names.",
        undo
      );
      if (picked === undo) {
        delete rules[rule];
        await cfg.update(
          "viewCheck.rules",
          Object.keys(rules).length ? rules : undefined,
          target
        );
      }
    }),

    vscode.commands.registerCommand("abap2ui5.fixAll", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("abap2UI5: no file open to fix.");
        return;
      }
      let findings: PropertyFinding[];
      try {
        findings = findingsNow(editor.document);
      } catch (err) {
        // the gate throws on an unparsable buffer mid-edit - the other
        // callers guard it, and a raw exception toast helps nobody
        vscode.window.showWarningMessage(
          `abap2UI5: this file cannot be checked right now - ${String(err)}`
        );
        return;
      }
      const all = applyAll(
        editor.document,
        findings.filter((f) => f.fixes?.length)
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
