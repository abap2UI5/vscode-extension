import * as vscode from "vscode";
import { ControlCall, controlCallAt } from "./context";
import { removeAttributeEdit, setAttributeEdit } from "./propedit";
import { createNonce, propertyEditorHtml } from "./webview";
import { memberInfo, membersOf, Snapshot, valuesFor, deprecationText } from "./metadata";
import { snapshot } from "./snapshot";
import { usesBuilder } from "./abap";

/*
 * The "Control Properties" view: the control under the cursor as a form.
 *
 * Inspect already answers "which builder call wrote this control"; this view
 * answers the next question - "and what may it have?" - editably. The rows
 * are the attributes the chain writes (enum properties as dropdowns, the
 * UI5 metadata supplying the values), expressions like `client->_bind( )`
 * shown read-only, and the add-row offers every member the control accepts
 * but the chain does not set yet. Every change is an ordinary text edit of
 * the class - `propedit.ts` computes it, undo works, the linter re-checks.
 */

const VIEW_ID = "abap2ui5.properties";

/** Members offered for adding: what a literal value can express. Events
 *  want `client->_event( )` and aggregations wants children - both are the
 *  editor's business, not a form field's. */
const ADDABLE_SECTIONS = new Set(["properties", "associations"]);

interface Shown {
  uri: vscode.Uri;
  tokenStart: number;
}

/** How far around the cursor a builder call has to appear for a full scan to
 *  be worth it. A chain writes one call per line, so a cursor inside a
 *  control block always has one nearby - a cursor in ordinary ABAP does not,
 *  and used to pay a whole-file `controlCallAt` every 200ms anyway. */
const CALL_WINDOW = 10000;

const NEARBY_CALL = /->\s*(?:ele|tag|a)\s*\(/i;

export class PropertyEditorProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private shown?: Shown;
  /** The last scan, keyed by uri, version and cursor offset - visibility
   *  toggles and debounced duplicate events re-render without re-scanning. */
  private lastScan?: { key: string; call: ControlCall | undefined };

  constructor(private readonly log: (m: string) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = propertyEditorHtml(createNonce());
    view.webview.onDidReceiveMessage((msg) => {
      // The form writes a WorkspaceEdit back into the class. A rejection here
      // had nowhere to land, so an edit that did not apply looked exactly
      // like one that did - the field showed the new value and the source
      // still said the old one.
      this.onMessage(msg).catch((err: unknown) => {
        vscode.window.showWarningMessage(
          `abap2UI5: the property could not be changed - ${String(err)}`
        );
      });
    });
    view.onDidChangeVisibility(() => this.refresh());
    this.refresh();
  }

  /** Recomputes the control under the active editor's cursor and renders. */
  refresh(): void {
    const view = this.view;
    if (!view || !view.visible) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const text = editor?.document.getText();
    if (
      !editor ||
      editor.document.languageId !== "abap" ||
      !text ||
      !usesBuilder(text)
    ) {
      this.shown = undefined;
      void view.webview.postMessage({
        type: "none",
        reason:
          "Open an ABAP class that builds views with z2ui5_cl_ui5_view_builder - the " +
          "control under the cursor appears here.",
      });
      return;
    }
    const offset = editor.document.offsetAt(editor.selection.active);
    const key = `${editor.document.uri.toString()}@${editor.document.version}:${offset}`;
    let call: ControlCall | undefined;
    if (this.lastScan?.key === key) {
      call = this.lastScan.call;
    } else {
      const nearby = text.slice(
        Math.max(0, offset - CALL_WINDOW),
        offset + CALL_WINDOW
      );
      call = NEARBY_CALL.test(nearby) ? controlCallAt(text, offset) : undefined;
      this.lastScan = { key, call };
    }
    if (!call) {
      this.shown = undefined;
      void view.webview.postMessage({
        type: "none",
        reason:
          "Place the cursor on an ele( ) / tag( ) builder call - its " +
          "control's properties appear here.",
      });
      return;
    }
    this.shown = { uri: editor.document.uri, tokenStart: call.tokenStart };
    void view.webview.postMessage(controlMessage(snapshot(), call));
  }

  private async onMessage(msg: unknown): Promise<void> {
    const message = msg as {
      type?: string;
      name?: string;
      value?: string;
    };
    const shown = this.shown;
    if (!shown) {
      return;
    }
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.toString() === shown.uri.toString()
    );
    if (!doc) {
      return;
    }
    if (message.type === "reveal") {
      await vscode.window.showTextDocument(doc, {
        selection: new vscode.Range(
          doc.positionAt(shown.tokenStart),
          doc.positionAt(shown.tokenStart)
        ),
      });
      return;
    }
    if (message.type !== "set" && message.type !== "remove") {
      return;
    }
    // The document may have changed since the render - re-derive the call
    // from its anchor before computing the edit.
    const text = doc.getText();
    const call = controlCallAt(text, shown.tokenStart);
    if (!call || call.tokenStart !== shown.tokenStart) {
      this.refresh();
      return;
    }
    const name = String(message.name ?? "");
    const edit =
      message.type === "set"
        ? setAttributeEdit(text, call, name, String(message.value ?? ""))
        : removeAttributeEdit(text, call, name);
    if (!edit) {
      vscode.window.showInformationMessage(
        `abap2UI5: ${name} cannot be edited here - it carries an expression ` +
          "or the chain layout is unusual. Edit the a( ) call directly."
      );
      return;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
      edit.text
    );
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    this.log(
      `properties: ${message.type} ${name} on ${call.label} ` +
        (applied ? "applied" : "FAILED")
    );
    this.refresh();
  }
}

/** The message that fills the form: written attributes as editable rows,
 *  everything else the control accepts as add-offers. */
function controlMessage(data: Snapshot, call: ControlCall): unknown {
  const control = call.control;
  const written = new Set(call.attrs.map((a) => a.name.toLowerCase()));
  const rows = call.attrs.map((attr) => {
    const info = control ? memberInfo(data, control, attr.name) : undefined;
    return {
      name: attr.name,
      value: attr.value,
      literal: attr.literal,
      type: info?.type,
      values: control ? valuesFor(data, control, attr.name) : undefined,
      deprecated: !!(info && deprecationText(info.deprecated)),
    };
  });
  const addable = control
    ? membersOf(data, control)
        .filter(
          (m) =>
            ADDABLE_SECTIONS.has(m.section) &&
            !written.has(m.name.toLowerCase()) &&
            !deprecationText(m.deprecated)
        )
        .map((m) => ({
          name: m.name,
          type: m.type,
          values: valuesFor(data, control, m.name),
        }))
    : [];
  return {
    type: "control",
    label: call.label,
    control,
    canAppend: call.appendAt >= 0,
    rows,
    addable,
  };
}

export function registerPropertyEditor(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): PropertyEditorProvider {
  const provider = new PropertyEditorProvider(log);
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => provider.refresh(), 200);
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider),
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === vscode.window.activeTextEditor?.document) {
        schedule();
      }
    }),
    { dispose: () => timer && clearTimeout(timer) }
  );
  log("properties: control property editor registered");
  return provider;
}
