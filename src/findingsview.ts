import * as vscode from "vscode";
import { DIAG_SOURCE, RULES_PAGE, ruleOf } from "./diagnostics";

import { labelOf } from "./abapsources";
import {
  FindingSeverity,
  groupByRule,
  RuleEntry,
  RuleGroup,
  ruleSummary,
} from "./checkcore";

/*
 * The abap2UI5 findings, grouped by the rule that produced them.
 *
 * The Problems panel already lists them - per file, mixed in with what every
 * other contributor reports. That answers "what is wrong in this file". The
 * question this view is for is the other one: "what is wrong with this
 * repository". Twelve `unknown-binding-path` spread over three classes are ONE
 * decision - fix them, waive them, put them in the baseline - and per file it
 * looks like twelve unrelated problems.
 *
 * It reads the published diagnostics rather than running a gate of its own, so
 * it costs nothing and always agrees with the squiggles: what fills it is
 * whatever has been checked - the open files, and the whole repository after
 * "Check All Views in the Workspace".
 */


type Node = RuleGroup | RuleEntry;

function isGroup(node: Node): node is RuleGroup {
  return (node as RuleGroup).entries !== undefined;
}

function severityOf(diagnostic: vscode.Diagnostic): FindingSeverity {
  if (diagnostic.severity === vscode.DiagnosticSeverity.Error) {
    return "error";
  }
  return diagnostic.severity === vscode.DiagnosticSeverity.Warning
    ? "warning"
    : "hint";
}


const ICON: Record<FindingSeverity, vscode.ThemeIcon> = {
  error: new vscode.ThemeIcon("error", new vscode.ThemeColor("problemsErrorIcon.foreground")),
  warning: new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground")),
  hint: new vscode.ThemeIcon("info", new vscode.ThemeColor("problemsInfoIcon.foreground")),
};

class FindingsTree implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return groupByRule(collect());
    }
    return isGroup(node) ? node.entries : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (isGroup(node)) {
      const item = new vscode.TreeItem(
        node.rule,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = ruleSummary(node);
      item.iconPath = ICON[node.severity];
      item.contextValue = "abap2ui5.rule";
      // the rule's own page - every id has one, and it is the difference
      // between a finding and an instruction
      item.tooltip = new vscode.MarkdownString(
        `[${node.rule}](${RULES_PAGE}#${node.rule}) - ${ruleSummary(node)}`
      );
      item.resourceUri = vscode.Uri.parse(`abap2ui5-rule:${node.rule}`);
      return item;
    }
    const uri = vscode.Uri.parse(node.file);
    const item = new vscode.TreeItem(
      `${labelOf(uri)}:${node.line + 1}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = node.message;
    item.tooltip = node.message;
    item.command = {
      title: "Open the finding",
      command: "vscode.open",
      arguments: [
        uri,
        { selection: new vscode.Range(node.line, 0, node.line, 0) },
      ],
    };
    return item;
  }
}

/** Every abap2UI5 finding the window currently holds, as plain entries. */
function collect(): RuleEntry[] {
  const out: RuleEntry[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    for (const diagnostic of diagnostics) {
      const rule = diagnostic.source === DIAG_SOURCE ? ruleOf(diagnostic) : undefined;
      if (!rule) {
        continue;
      }
      out.push({
        rule,
        severity: severityOf(diagnostic),
        // the uri, not the path: a class opened through ADT has no path, and
        // dropping those was why this tree stayed empty for anyone working
        // straight against a system
        file: uri.toString(),
        line: diagnostic.range.start.line,
        message: diagnostic.message,
      });
    }
  }
  return out;
}

export function registerFindingsView(context: vscode.ExtensionContext): void {
  const provider = new FindingsTree();
  const view = vscode.window.createTreeView("abap2ui5.findings", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  let lastTotal = 0;
  const updateBadge = () => {
    const total = collect().length;
    lastTotal = total;
    view.badge = total
      ? { value: total, tooltip: `${total} abap2UI5 finding(s)` }
      : undefined;
  };
  /*
   * onDidChangeDiagnostics fires for every provider in the window - the ABAP
   * extension, the XML server, ESLint in a JS folder - and each firing walked
   * every diagnostic in the workspace twice, once for the tree and once for
   * the badge. Neither answer changes unless one of OUR diagnostics did, and
   * a burst of them (a workspace sweep, a language server starting up) is
   * exactly when the walk is most expensive.
   */
  let pending: NodeJS.Timeout | undefined;
  const refreshSoon = (e: vscode.DiagnosticChangeEvent) => {
    const ours = e.uris.some((uri) =>
      vscode.languages
        .getDiagnostics(uri)
        .some((d) => d.source === DIAG_SOURCE)
    );
    // nothing of ours in the changed files, and nothing of ours on display -
    // then this event cannot have changed what the tree says
    if (!ours && lastTotal === 0) {
      return;
    }
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => {
      pending = undefined;
      provider.refresh();
      updateBadge();
    }, 150);
  };

  context.subscriptions.push(
    provider,
    view,
    vscode.languages.onDidChangeDiagnostics(refreshSoon),
    new vscode.Disposable(() => pending && clearTimeout(pending)),
    vscode.commands.registerCommand("abap2ui5.openRuleDocs", (node: Node) => {
      if (node && isGroup(node)) {
        void vscode.env.openExternal(
          vscode.Uri.parse(`${RULES_PAGE}#${node.rule}`)
        );
      }
    })
  );
  updateBadge();
}
