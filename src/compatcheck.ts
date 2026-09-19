import * as vscode from "vscode";
import { compatFinding, CompatRecord } from "./compat";
import { DIAG_SOURCE } from "./diagnostics";

/*
 * The framework-pin check: a warning on the `branch` line of an open
 * `abaplint.jsonc` whose abap2UI5 pin is below the release the bundled
 * linter assumes. The decision is `compat.ts`'s (`compatFinding`); this is
 * the plumbing that runs it when such a file is opened or saved and publishes
 * the one diagnostic.
 *
 * The diagnostic carries the view check's source, so it sits with the other
 * abap2UI5 entries in the Problems panel - and no code: a code is a rule id
 * the findings tree links to the linter's rule page, and this is not a rule
 * that page documents.
 */

/** The abaplint config - `.json` too, which abaplint reads just the same. */
const PIN_FILE_RE = /(^|[\\/])abaplint\.jsonc?$/i;

export function isPinFile(doc: vscode.TextDocument): boolean {
  return PIN_FILE_RE.test(doc.fileName);
}

export function registerCompatCheck(
  context: vscode.ExtensionContext,
  compat: CompatRecord | null,
  log: (m: string) => void
): void {
  if (!compat) {
    // nothing to compare against - the activation line already said so
    return;
  }
  const diagnostics = vscode.languages.createDiagnosticCollection("abap2ui5-compat");
  const reported = new Set<string>();

  const check = (doc: vscode.TextDocument) => {
    if (!isPinFile(doc)) {
      return;
    }
    const finding = compatFinding(compat, doc.getText());
    if (!finding) {
      diagnostics.delete(doc.uri);
      reported.delete(doc.uri.toString());
      return;
    }
    const range = new vscode.Range(
      doc.positionAt(finding.offset),
      doc.positionAt(finding.offset + finding.length)
    );
    const d = new vscode.Diagnostic(range, finding.message, vscode.DiagnosticSeverity.Warning);
    d.source = DIAG_SOURCE;
    diagnostics.set(doc.uri, [d]);
    // once per file, not once per save - the message does not change until
    // the pin does, and then the diagnostic goes away with it
    if (!reported.has(doc.uri.toString())) {
      reported.add(doc.uri.toString());
      log(`compat: ${doc.fileName} - ${finding.message}`);
    }
  };

  context.subscriptions.push(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidSaveTextDocument(check),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      reported.delete(doc.uri.toString());
    })
  );
  for (const doc of vscode.workspace.textDocuments) {
    check(doc);
  }
}
