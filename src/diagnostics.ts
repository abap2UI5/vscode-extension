import * as vscode from "vscode";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { describe, RENDER_RULE, RULES, severityOf } from "@abap2ui5/linter/findings";
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

/** The slice of `vscode.TextDocument` the ranges are computed from - so a
 *  workspace sweep can place findings in a file it already read, without
 *  opening every clean file as a document. */
export interface FindingSource {
  lineCount: number;
  getText(): string;
  lineAt(line: number): { text: string; range: vscode.Range };
  positionAt(offset: number): vscode.Position;
}

/** A `FindingSource` over plain text - line starts computed once, positions
 *  by binary search, exactly as a `TextDocument` would answer. */
export function textSource(text: string): FindingSource {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      starts.push(i + 1);
    }
  }
  const lineText = (line: number): string => {
    const end = line + 1 < starts.length ? starts[line + 1] : text.length;
    return text.slice(starts[line], end).replace(/\r?\n$/, "");
  };
  return {
    lineCount: starts.length,
    getText: () => text,
    lineAt: (line) => {
      const t = lineText(line);
      return { text: t, range: new vscode.Range(line, 0, line, t.length) };
    },
    positionAt: (offset) => {
      const at = Math.max(0, Math.min(offset, text.length));
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= at) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return new vscode.Position(lo, at - starts[lo]);
    },
  };
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
  doc: FindingSource,
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

/** The rules whose subject really is deprecated or removed API - VS Code
 *  strikes the underlined text through for them, which says "stop using
 *  this" better than any wording. Presentation only: which rules exist and
 *  what they mean stays the linter's. */
const DEPRECATION_RULES = new Set([
  "control-deprecated",
  "member-deprecated",
  "obsolete-binder",
  "obsolete-model-update",
  "obsolete-frontend-event",
  "icon-removed",
  "get-viewname-removed",
]);

/** The rules whose subject does nothing - VS Code fades the range for them,
 *  which is exactly what "this has no effect" looks like. */
const UNNECESSARY_RULES = new Set([
  "unused-public-attribute",
  "trailing-empty-event-arg",
]);

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
  doc: FindingSource,
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
    } else if (UNNECESSARY_RULES.has(f.type)) {
      d.tags = [vscode.DiagnosticTag.Unnecessary];
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
    d.code = RENDER_RULE;
    diagnostics.push(d);
  }
  return diagnostics;
}

/**
 * A message that says "see the Problems panel", with the button that opens
 * it - the reader should not have to find the panel the message points at.
 * Shared by the desktop and web checks, which show the same messages.
 */
export function showProblemsMessage(message: string, warn: boolean): void {
  const open = "Show Problems";
  const shown = warn
    ? vscode.window.showWarningMessage(message, open)
    : vscode.window.showInformationMessage(message, open);
  void shown.then((pick) => {
    if (pick === open) {
      void vscode.commands.executeCommand("workbench.actions.view.problems");
    }
  });
}
