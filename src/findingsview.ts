import * as vscode from "vscode";
import * as path from "path";
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

const DIAG_SOURCE = "abap2UI5-linter";
const RULES_PAGE = "https://abap2ui5.github.io/linter/";

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
    const item = new vscode.TreeItem(
      `${path.basename(node.file)}:${node.line + 1}`,
      vscode.TreeItemCollapsibleState.None
    );
    item.description = node.message;
    item.tooltip = node.message;
    item.command = {
      title: "Open the finding",
      command: "vscode.open",
      arguments: [
        vscode.Uri.file(node.file),
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
    if (uri.scheme !== "file") {
      continue;
    }
    for (const diagnostic of diagnostics) {
      const rule = diagnostic.source === DIAG_SOURCE ? ruleOf(diagnostic) : undefined;
      if (!rule) {
        continue;
      }
      out.push({
        rule,
        severity: severityOf(diagnostic),
        file: uri.fsPath,
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
  const updateBadge = () => {
    const total = collect().length;
    view.badge = total
      ? { value: total, tooltip: `${total} abap2UI5 finding(s)` }
      : undefined;
  };
  context.subscriptions.push(
    provider,
    view,
    vscode.languages.onDidChangeDiagnostics(() => {
      provider.refresh();
      updateBadge();
    }),
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
