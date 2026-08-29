import * as vscode from "vscode";
import * as path from "path";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { DIAG_SOURCE, RULES_PAGE, ruleOf } from "./diagnostics";

import { labelOf } from "./abapsources";
import { addToBaseline } from "./baselinefile";
import { clearBaselineCache } from "./lintconfig";
import { baselineFileFor, findingsNow, recheckOpenDocuments } from "./viewcheck";
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
  private groups: RuleGroup[] = [];

  /** One walk feeds both the tree and the badge - `collect` runs once per
   *  refresh, not once per consumer. */
  setEntries(entries: readonly RuleEntry[]): void {
    this.groups = groupByRule(entries);
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      return this.groups;
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
  const apply = () => {
    const entries = collect();
    provider.setEntries(entries);
    lastTotal = entries.length;
    view.badge = entries.length
      ? { value: entries.length, tooltip: `${entries.length} abap2UI5 finding(s)` }
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
      apply();
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
    }),
    /*
     * "Add All Findings of This Rule to the Baseline" - the context-menu
     * action on a rule group. The grouped tree is where a dozen findings of
     * one rule become ONE decision, and baselining them one squiggle at a
     * time (the quick fix) is the wrong size for it. Same machinery as the
     * quick fix: `baselineFileFor` decides whether the repo config names a
     * baseline for the file, `addToBaseline` writes the entry, and the
     * finding matched per line so a buffer that moved since the diagnostics
     * were published is skipped rather than baselined wrongly.
     */
    vscode.commands.registerCommand(
      "abap2ui5.baselineRule",
      async (node: Node) => {
        if (!node || !isGroup(node)) {
          return;
        }
        const rule = node.rule;
        let added = 0;
        let noBaseline = 0;
        let missed = 0;
        const touchedBaselines = new Set<string>();
        const files = [...new Set(node.entries.map((entry) => entry.file))];
        for (const file of files) {
          let doc: vscode.TextDocument;
          try {
            doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(file));
          } catch {
            missed++;
            continue; // deleted or unreachable since the tree was filled
          }
          const baselineFile = baselineFileFor(doc);
          if (!baselineFile) {
            noBaseline++;
            continue;
          }
          const lines = new Set(
            node.entries
              .filter((entry) => entry.file === file)
              .map((entry) => entry.line)
          );
          let findings: PropertyFinding[];
          try {
            findings = findingsNow(doc);
          } catch {
            missed++;
            continue; // an unparsable buffer mid-edit
          }
          for (const finding of findings) {
            if (
              finding.type !== rule ||
              typeof finding.line !== "number" ||
              !lines.has(finding.line - 1)
            ) {
              continue;
            }
            try {
              addToBaseline(baselineFile, doc.uri.fsPath, finding);
              added++;
              touchedBaselines.add(baselineFile);
            } catch (err) {
              vscode.window.showWarningMessage(
                `abap2UI5: could not update ${baselineFile} - ${String(err)}`
              );
              return;
            }
          }
        }
        for (const baselineFile of touchedBaselines) {
          // the memo is keyed on mtime, and these writes may land in the
          // same second as the read that filled it
          clearBaselineCache(baselineFile);
        }
        if (added) {
          recheckOpenDocuments();
        }
        const names = [...touchedBaselines]
          .map((file) => path.basename(file))
          .join(", ");
        vscode.window.showInformationMessage(
          added
            ? `abap2UI5: added ${added} ${rule} finding(s) to ${names}.` +
                (noBaseline
                  ? ` ${noBaseline} file(s) skipped - no baseline is configured for them.`
                  : "")
            : noBaseline
              ? "abap2UI5: nothing baselined - no abap2ui5lint.jsonc names a " +
                "baseline file for these files."
              : `abap2UI5: nothing to baseline - the ${rule} findings ` +
                (missed
                  ? "could not be re-read (files moved or buffers changed). "
                  : "moved since the tree was filled. ") +
                "Run the check again."
        );
      }
    )
  );
  apply();
}
