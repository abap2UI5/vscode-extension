import * as vscode from "vscode";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { runGate, VIEW_XML_RE } from "./gate";
import { toDiagnostics } from "./diagnostics";
import { usesBuilder } from "./abap";
import type { CheckOptions } from "./lintconfig";

/*
 * The view check of the web build: exactly the in-process property gate,
 * scheduled the way `viewcheck.ts` schedules it on desktop - live while
 * typing, on save, on open, on demand.
 *
 * What the desktop wrapper adds is exactly what a browser extension host
 * cannot do: the render gate (a child process), the workspace sweep over
 * arbitrary globs, and the repo's `abap2ui5lint.jsonc` (discovered with
 * `fs`). The options therefore come from the VS Code settings alone - the
 * one editor/CI divergence the web build knowingly keeps, and the README
 * says so.
 */

const CONFIG_SECTION = "abap2ui5";
const LIVE_DEBOUNCE_MS = 400;

function options(): CheckOptions {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    minUi5: cfg.get<string>("viewCheck.minUi5", "1.71"),
    distribution: cfg.get<string>("viewCheck.distribution", "sapui5"),
    allow: cfg.get<string[]>("viewCheck.allow", []),
  };
}

function isCheckable(doc: vscode.TextDocument): boolean {
  if (VIEW_XML_RE.test(doc.fileName)) {
    return true;
  }
  if (doc.languageId !== "abap" && !/\.abap$/i.test(doc.fileName)) {
    return false;
  }
  return usesBuilder(doc.getText());
}

/** Findings of a document as it stands - memoised on its version, the same
 *  contract `viewcheck.ts` exposes on desktop (the XML preview mirrors it). */
let memo:
  | { key: string; version: number; findings: PropertyFinding[] }
  | undefined;

export function webFindingsNow(doc: vscode.TextDocument): PropertyFinding[] {
  const key = doc.uri.toString();
  if (memo && memo.key === key && memo.version === doc.version) {
    return memo.findings;
  }
  if (!isCheckable(doc)) {
    return [];
  }
  const text = doc.getText();
  const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
  const gate = runGate(text, doc.fileName, isXml, options());
  memo = { key, version: doc.version, findings: gate.findings };
  return gate.findings;
}

export function registerWebCheck(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  const diagnostics =
    vscode.languages.createDiagnosticCollection("abap2ui5-view-check");
  const timers = new Map<string, NodeJS.Timeout>();

  const check = (doc: vscode.TextDocument, announce: boolean) => {
    if (!isCheckable(doc)) {
      if (announce) {
        vscode.window.showInformationMessage(
          "abap2UI5: open an ABAP class that builds views with " +
            "z2ui5_cl_ui5_view_builder (or a *.view.xml file) to check it."
        );
      }
      return;
    }
    const text = doc.getText();
    const isXml = VIEW_XML_RE.test(doc.fileName) || /^\s*</.test(text);
    const gate = runGate(text, doc.fileName, isXml, options());
    if (gate.nothingChecked) {
      diagnostics.delete(doc.uri);
      if (announce) {
        vscode.window.showInformationMessage(
          `abap2UI5: nothing to check - ${gate.nothingChecked}.`
        );
      }
      return;
    }
    const diags = toDiagnostics(doc, gate.findings, []);
    diagnostics.set(doc.uri, diags);
    if (announce) {
      vscode.window.showInformationMessage(
        diags.length
          ? `abap2UI5: view check found ${diags.length} problem(s) - see the Problems panel.`
          : "abap2UI5: view check passed."
      );
    }
  };

  const schedule = (doc: vscode.TextDocument, delay: number) => {
    const key = doc.uri.toString();
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        check(doc, false);
      }, delay)
    );
  };

  context.subscriptions.push(
    diagnostics,
    { dispose: () => timers.forEach((t) => clearTimeout(t)) },
    vscode.commands.registerCommand("abap2ui5.checkViews", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) {
        check(doc, true);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => schedule(doc, 0)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length) {
        schedule(e.document, LIVE_DEBOUNCE_MS);
      }
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => schedule(doc, 0)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      timers.delete(doc.uri.toString());
      diagnostics.delete(doc.uri);
    })
  );

  for (const editor of vscode.window.visibleTextEditors) {
    schedule(editor.document, 0);
  }
  log("web: property gate registered (settings only, no repo config)");
}
