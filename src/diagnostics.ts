import * as vscode from "vscode";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { describe, RULES, severityOf } from "@abap2ui5/linter/findings";
import { renderErrorOffset } from "./renderloc";

/*
 * Findings -> VS Code diagnostics, extracted from `viewcheck.ts` so the web
 * bundle (which runs only the in-process gate) shares the exact presentation:
 * the ranges, the severity mapping, the rule links.
 */

export const DIAG_SOURCE = "abap2UI5-linter";

/** The published rule reference - one anchor per rule id, which is what makes
 *  every diagnostic's code clickable. */
export const RULES_PAGE = "https://abap2ui5.github.io/linter/";

/** The rule id behind a diagnostic, whether or not it carries a docs link.
 *  Lives here with the code that PUTS the id there - three modules had their
 *  own copy of the unwrapping, next to their own copy of DIAG_SOURCE, so a
 *  rename of either would have broken the status bar, the tree and the quick
 *  fixes without a single failing type. */
export function ruleOf(diagnostic: vscode.Diagnostic): string | undefined {
  const code = diagnostic.code;
  if (typeof code === "string") {
    return code;
  }
  if (code && typeof code === "object" && "value" in code) {
    return String(code.value);
  }
  return undefined;
}

/** What to underline: the member name, the control's local name, or - for
 *  the findings that are about a value rather than a member - that value. */
function needleOf(f: PropertyFinding): string {
  if (f.type === "unknown-binding-path" || f.type === "event-without-handler") {
    return String(f.value ?? "").replace(/^\//, "");
  }
  return f.member || (f.control ?? "").split(".").pop() || "";
}

/** The linter records where each finding came from, so the diagnostic goes
 *  exactly there: the recorded line, and on it the first occurrence of the
 *  name at or after the recorded column - the a( ) call carries the name a
 *  few characters further right than the token the gate matched. Findings
 *  the linter could not place (a view part inlined from a helper method)
 *  keep the old best-effort search: the first textual match in the file. */
export function findingRange(
  doc: vscode.TextDocument,
  f: PropertyFinding
): vscode.Range {
  const needle = needleOf(f);
  if (typeof f.line === "number" && f.line >= 1 && f.line <= doc.lineCount) {
    const lineNo = f.line - 1;
    const line = doc.lineAt(lineNo);
    const col = Math.max(0, Math.min((f.column ?? 1) - 1, line.text.length));
    const ix = needle ? line.text.indexOf(needle, col) : -1;
    if (ix >= 0) {
      return new vscode.Range(lineNo, ix, lineNo, ix + needle.length);
    }
    return new vscode.Range(new vscode.Position(lineNo, col), line.range.end);
  }
  if (needle) {
    const text = doc.getText();
    const ix = text.search(
      new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
    );
    if (ix >= 0) {
      const start = doc.positionAt(ix);
      return new vscode.Range(start, doc.positionAt(ix + needle.length));
    }
  }
  return doc.lineAt(0).range;
}

/* The linter owns the severity of every finding type and the wording that
 * goes with it (@abap2ui5/linter/findings) - both used to be kept a second
 * time here, which is how the two drifted apart. `hint` becomes
 * Information rather than DiagnosticSeverity.Hint: Hint diagnostics stay
 * out of the Problems panel, and a finding nobody can see is not a hint. */
export const DIAGNOSTIC_SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  hint: vscode.DiagnosticSeverity.Information,
} as const;

/** The rules whose subject really is a deprecation - VS Code strikes the
 *  underlined text through for them, which says it better than any wording. */
const DEPRECATION_RULES = new Set(["control-deprecated", "member-deprecated"]);

/** The diagnostic code: the rule id, linked to its section on the published
 *  rule reference. Ctrl+click in the Problems panel then explains what the
 *  rule means and what the fix looks like - the paragraph that never fits in
 *  a one-line message. */
function diagnosticCode(
  type: string
): string | { value: string; target: vscode.Uri } {
  if (!RULES.includes(type)) {
    return type;
  }
  return { value: type, target: vscode.Uri.parse(`${RULES_PAGE}#${type}`) };
}

export function toDiagnostics(
  doc: vscode.TextDocument,
  findings: PropertyFinding[],
  renderErrors: string[]
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  for (const f of findings) {
    const d = new vscode.Diagnostic(
      findingRange(doc, f),
      f.message ?? describe(f),
      DIAGNOSTIC_SEVERITY[f.severity ?? severityOf(f)]
    );
    d.source = DIAG_SOURCE;
    d.code = diagnosticCode(f.type);
    if (DEPRECATION_RULES.has(f.type)) {
      d.tags = [vscode.DiagnosticTag.Deprecated];
    }
    diagnostics.push(d);
  }
  const text = renderErrors.length ? doc.getText() : "";
  for (const e of renderErrors) {
    // render errors are strings without positions - the token the message
    // quotes is the best anchor there is; line 0 only when nothing matches
    const at = renderErrorOffset(e, text);
    const range =
      at === undefined
        ? doc.lineAt(0).range
        : doc.lineAt(doc.positionAt(at).line).range;
    const d = new vscode.Diagnostic(
      range,
      `render: ${e.slice(0, 300)}`,
      vscode.DiagnosticSeverity.Error
    );
    d.source = DIAG_SOURCE;
    d.code = "render-error";
    diagnostics.push(d);
  }
  return diagnostics;
}
