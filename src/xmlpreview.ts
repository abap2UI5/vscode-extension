import * as vscode from "vscode";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { classNameOf, usesBuilder } from "./abap";
import { formatDocument, lineForOffset } from "./xmlformat";

/*
 * "Show Reconstructed XML View" - the linter's view of the class, for people.
 *
 * abap2UI5 views are strings assembled by builder calls, so what actually
 * reaches `XMLView.create` is never visible in the source. The linter
 * reconstructs exactly that for its checks; this module opens the same
 * reconstruction as a read-only XML document next to the class.
 *
 * There is ONE preview and it follows the editor, the way the Markdown
 * preview does: switch to another view-building class and the XML swaps to
 * that class; edit the class and the XML re-renders shortly after each
 * pause. A class that builds no views does not blank the preview - the last
 * reconstruction stays until the next builder class takes over.
 *
 * The reconstruction records which builder call wrote each node and
 * attribute, so the XML is not just readable but navigable: Go to Definition
 * on a line jumps to its `ele( )` / `tag( )` / `a( )` in the class, and the
 * view check's findings are mirrored onto the XML lines they concern.
 */

export const XML_PREVIEW_SCHEME = "abap2ui5-xml";

/** The one preview document. The name deliberately does not end in
 *  `.view.xml`: the view check would treat that as a checkable view file
 *  and double-report everything the class already gets. */
const PREVIEW_URI = vscode.Uri.from({
  scheme: XML_PREVIEW_SCHEME,
  path: "/abap2UI5.reconstructed.xml",
});

/** How long after the last keystroke the XML refreshes - same rhythm as the
 *  live view check, for the same reason. */
const REFRESH_DEBOUNCE_MS = 400;

/** The class the preview currently renders. */
let activeSource: vscode.Uri | undefined;

/** True while the preview document is open in some tab - only then is it
 *  worth re-rendering or following the active editor. */
let previewOpen = false;

/** Last rendered state, for the definition provider and the survivors of a
 *  closed source. */
let lastContent: string | undefined;
let lastOffsets: Array<number | undefined> | undefined;
/** The source `lastOffsets` was computed from. Following another class
 *  changes what the preview is ABOUT before the debounced re-render lands,
 *  and until it did, a jump used the previous class's offsets against the new
 *  source - landing somewhere arbitrary in it rather than on the call. */
let lastOffsetsFor: string | undefined;
/** Source uri + version of the last render - `prepareAbap` over an
 *  unchanged buffer (tab switches, provider re-fires) is pure cost. */
let lastRenderKey: string | undefined;

/** A source the preview can follow: an ABAP buffer that builds views. */
function isFollowable(doc: vscode.TextDocument): boolean {
  if (doc.languageId !== "abap" && !/\.abap$/i.test(doc.fileName)) {
    return false;
  }
  return usesBuilder(doc.getText());
}

function activeSourceDoc(): vscode.TextDocument | undefined {
  if (!activeSource) {
    return undefined;
  }
  const key = activeSource.toString();
  return vscode.workspace.textDocuments.find(
    (doc) => doc.uri.toString() === key
  );
}

const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  hint: vscode.DiagnosticSeverity.Information,
} as const;

export function registerXmlPreview(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  /** The view check's findings for a source document - injected so this
   *  module stays free of the checker plumbing (the web build has none). */
  findingsFor?: (doc: vscode.TextDocument) => PropertyFinding[]
): void {
  let timer: NodeJS.Timeout | undefined;
  const diagnostics =
    vscode.languages.createDiagnosticCollection("abap2ui5-xml-preview");

  /** Mirrors the source's findings onto the XML lines their calls render. */
  function mirrorFindings(
    source: vscode.TextDocument,
    offsets: Array<number | undefined>,
    lines: string[]
  ): void {
    if (!findingsFor) {
      return;
    }
    let findings: PropertyFinding[];
    try {
      findings = findingsFor(source);
    } catch {
      // An unparsable buffer mid-edit is not worth reporting - but leaving
      // the previous run's findings up is worse than showing none: the XML
      // around them has just been re-rendered, so they now point at lines
      // that no longer say what they were about.
      diagnostics.delete(PREVIEW_URI);
      return;
    }
    const out: vscode.Diagnostic[] = [];
    for (const f of findings) {
      if (typeof f.offset !== "number") {
        continue;
      }
      const line = lineForOffset(offsets, f.offset);
      if (line === undefined) {
        continue;
      }
      const text = lines[line] ?? "";
      const start = text.length - text.trimStart().length;
      const d = new vscode.Diagnostic(
        new vscode.Range(line, start, line, text.length),
        f.message ?? f.type,
        SEVERITY[f.severity ?? "warning"]
      );
      d.source = "abap2UI5-linter";
      d.code = f.type;
      out.push(d);
    }
    diagnostics.set(PREVIEW_URI, out);
  }

  function render(source: vscode.TextDocument): string {
    const key = `${source.uri.toString()}@${source.version}`;
    if (key === lastRenderKey && lastContent !== undefined) {
      // same buffer, same version - re-mirror (the findings may be newer),
      // but do not reconstruct again
      if (lastOffsets && lastOffsetsFor === source.uri.toString()) {
        mirrorFindings(source, lastOffsets, lastContent.split("\n"));
      }
      return lastContent;
    }
    const prep = prepareAbap(source.getText());
    const className =
      classNameOf(source.getText(), source.fileName).toUpperCase() ||
      "this class";
    if (!prep.nodes.length) {
      const empty =
        `<!-- ${className}: no view could be reconstructed - the class calls ` +
        `z2ui5_cl_ui5_view_builder=>factory( ) but nothing checkable came out of the ` +
        `builder chain. -->\n`;
      lastContent = empty;
      lastOffsets = undefined;
      lastOffsetsFor = undefined;
      lastRenderKey = key;
      diagnostics.delete(PREVIEW_URI);
      return empty;
    }
    const formatted = formatDocument(prep.nodes, className);
    lastContent = formatted.text;
    lastOffsets = formatted.lineOffsets;
    lastOffsetsFor = source.uri.toString();
    lastRenderKey = key;
    mirrorFindings(source, formatted.lineOffsets, formatted.text.split("\n"));
    return formatted.text;
  }

  const provider = new (class implements vscode.TextDocumentContentProvider {
    readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.onDidChangeEmitter.event;

    provideTextDocumentContent(): string {
      const source = activeSourceDoc();
      if (!source) {
        return (
          lastContent ??
          "<!-- Open an ABAP class that builds views with z2ui5_cl_ui5_view_builder " +
            "- the preview follows the class you are editing. -->\n"
        );
      }
      return render(source);
    }
  })();

  const refresh = (delay: number) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      provider.onDidChangeEmitter.fire(PREVIEW_URI);
    }, delay);
  };

  /** The reverse of Go to Definition: the XML line whose builder call the
   *  ABAP cursor sits on, highlighted and scrolled into view. */
  const syncHighlight = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("editor.rangeHighlightBackground"),
    isWholeLine: true,
  });

  const syncPreviewToCursor = (e: vscode.TextEditorSelectionChangeEvent) => {
    if (!previewOpen) {
      return;
    }
    const doc = e.textEditor.document;
    if (
      doc.uri.toString() !== activeSource?.toString() ||
      !lastOffsets ||
      lastOffsetsFor !== doc.uri.toString()
    ) {
      return;
    }
    const active = e.selections[0]?.active ?? e.textEditor.selection.active;
    const line = lineForOffset(lastOffsets, doc.offsetAt(active));
    const previewKey = PREVIEW_URI.toString();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== previewKey) {
        continue;
      }
      if (line === undefined || line >= editor.document.lineCount) {
        editor.setDecorations(syncHighlight, []);
        continue;
      }
      const range = editor.document.lineAt(line).range;
      editor.setDecorations(syncHighlight, [range]);
      editor.revealRange(
        range,
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
    }
  };

  /** Points the preview at a class; re-renders when it is a new one. */
  const follow = (doc: vscode.TextDocument) => {
    const changed = activeSource?.toString() !== doc.uri.toString();
    activeSource = doc.uri;
    if (changed) {
      log(`xml-preview: following ${doc.fileName}`);
      refresh(0);
    }
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      XML_PREVIEW_SCHEME,
      provider
    ),
    diagnostics,
    syncHighlight,
    {
      dispose: () => {
        if (timer) {
          clearTimeout(timer);
        }
      },
    },

    // The preview follows the cursor within the class, not just the class.
    vscode.window.onDidChangeTextEditorSelection(syncPreviewToCursor),

    // A line of the XML knows the builder call that wrote it.
    vscode.languages.registerDefinitionProvider(
      { scheme: XML_PREVIEW_SCHEME },
      {
        provideDefinition(_doc, position) {
          const source = activeSourceDoc();
          const offset = lastOffsets?.[position.line];
          if (!source || offset === undefined) {
            return undefined;
          }
          // the render this line came from has to be the render of THIS
          // source, or the offset means nothing in it
          if (lastOffsetsFor !== source.uri.toString()) {
            return undefined;
          }
          const at = source.positionAt(
            Math.min(offset, source.getText().length)
          );
          return new vscode.Location(source.uri, source.lineAt(at.line).range);
        },
      }
    ),

    vscode.commands.registerCommand("abap2ui5.showReconstructedXml", async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc || !isFollowable(doc)) {
        // an ABAP class without builder calls is a different situation from
        // no ABAP at all - say which one this is
        const isAbap =
          !!doc && (doc.languageId === "abap" || /\.abap$/i.test(doc.fileName));
        vscode.window.showInformationMessage(
          isAbap
            ? "abap2UI5: this class builds no views with " +
                "z2ui5_cl_ui5_view_builder - there is nothing to reconstruct."
            : "abap2UI5: open an ABAP class that builds views with " +
                "z2ui5_cl_ui5_view_builder to see its reconstructed XML."
        );
        return;
      }
      follow(doc);
      const virtual = await vscode.workspace.openTextDocument(PREVIEW_URI);
      await vscode.languages.setTextDocumentLanguage(virtual, "xml");
      previewOpen = true;
      await vscode.window.showTextDocument(virtual, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
        preview: false,
      });
      refresh(0);
    }),

    // The preview follows the editor: switching to another view-building
    // class swaps the XML to that class. Anything else (the preview itself,
    // a helper class, the settings) leaves the last reconstruction standing.
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!previewOpen || !editor) {
        return;
      }
      if (isFollowable(editor.document)) {
        follow(editor.document);
      }
    }),

    // The reconstruction follows the class's edits, shortly after each pause.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!previewOpen || !e.contentChanges.length) {
        return;
      }
      if (e.document.uri.toString() === activeSource?.toString()) {
        refresh(REFRESH_DEBOUNCE_MS);
      }
    }),

    // A closed preview tab does not need following any more.
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.toString() === PREVIEW_URI.toString()) {
        previewOpen = false;
        diagnostics.delete(PREVIEW_URI);
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      }
    })
  );
}
