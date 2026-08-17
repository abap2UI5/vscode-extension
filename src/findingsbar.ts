import * as vscode from "vscode";
import { DIAG_SOURCE } from "./diagnostics";

import { findingsBarText, findingsBarTooltip, FindingCounts } from "./checkcore";
import { fixableCount } from "./quickfix";
import { isCheckable } from "./viewcheck";

/*
 * The view check's own line in the status bar.
 *
 * The findings are in the Problems panel already - next to whatever the ABAP
 * extension, the XML language server and every other contributor puts there.
 * That is the reason for this: "is the file I am looking at clean?" should not
 * require opening a panel and reading past other people's entries.
 *
 * The counts come from the published diagnostics rather than from another gate
 * run: they are the same findings, already computed, and following them means
 * the line changes exactly when the check has something new to say.
 */


function countsFor(doc: vscode.TextDocument): FindingCounts {
  const counts: FindingCounts = { errors: 0, warnings: 0, hints: 0, fixable: 0 };
  for (const diagnostic of vscode.languages.getDiagnostics(doc.uri)) {
    if (diagnostic.source !== DIAG_SOURCE) {
      continue;
    }
    if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
      counts.errors++;
    } else if (diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
      counts.warnings++;
    } else {
      counts.hints++;
    }
  }
  counts.fixable = fixableCount(doc);
  return counts;
}

export function registerFindingsBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(
    "abap2ui5.findings",
    vscode.StatusBarAlignment.Left,
    48 // left of the UI5 version, which is left of the running app
  );
  item.name = "abap2UI5 View Check";

  const update = () => {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !isCheckable(doc)) {
      // a file the check has no opinion about gets no verdict - an old count
      // left standing next to an unrelated file is worse than no count
      item.hide();
      return;
    }
    const counts = countsFor(doc);
    item.text = findingsBarText(counts);
    item.tooltip = findingsBarTooltip(counts);
    item.backgroundColor = counts.errors
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : counts.warnings
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    /* Clicking opens the list the numbers came from. The one thing it must
     * NOT do is change the file: an autofix behind a status-bar click is a
     * silent edit of everything the number covers. */
    item.command = {
      title: "Show the findings",
      command: "workbench.actions.view.problems",
    };
    item.show();
  };

  context.subscriptions.push(
    item,
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.languages.onDidChangeDiagnostics((e) => {
      const active = vscode.window.activeTextEditor?.document.uri.toString();
      if (active && e.uris.some((uri) => uri.toString() === active)) {
        update();
      }
    })
  );
  update();
}
