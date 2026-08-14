import * as vscode from "vscode";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { classNameOf, usesBuilder } from "./abap";
import { formatDocument } from "./xmlformat";

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

/** The XML line a source offset renders on: the exact line when one carries
 *  that offset, otherwise the nearest line whose call starts before it - a
 *  finding recorded inside an argument list still lands on its element. */
function lineForOffset(
  offsets: Array<number | undefined>,
  target: number
): number | undefined {
  let best: number | undefined;
  let bestOffset = -1;
  for (let line = 0; line < offsets.length; line++) {
    const offset = offsets[line];
    if (offset === undefined || offset > target) {
      continue;
    }
    if (offset === target) {
      return line;
    }
    if (offset >= bestOffset) {
      bestOffset = offset;
      best = line;
    }
  }
  return best;
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
      return; // an unparsable buffer mid-edit is not worth reporting
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
      diagnostics.delete(PREVIEW_URI);
      return empty;
    }
    const formatted = formatDocument(prep.nodes, className);
    lastContent = formatted.text;
    lastOffsets = formatted.lineOffsets;
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
    {
      dispose: () => {
        if (timer) {
          clearTimeout(timer);
        }
      },
    },

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
        vscode.window.showInformationMessage(
          "abap2UI5: open an ABAP class that builds views with " +
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
