import * as vscode from "vscode";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import {
  abapBindingContextAt,
  eventNameAt,
  eventNameSpans,
  eventUsagesOf,
  NamedSpan,
  OutlineNode,
  viewOutline,
  whenBranchOf,
  whenNameAt,
} from "./context";
import { declarationSpan, methodImplementations, usesBuilder } from "./abap";
import {
  clientCallAt,
  clientMethod,
  clientMethods,
  isClientCompletion,
  signatureHead,
} from "./clientapi";
import { chainIndentEdits } from "./chainformat";
import { membersOf } from "./metadata";
import {
  CompletionKind,
  completionAt,
  hoverAt,
  isColorMember,
  isXmlView,
} from "./languagecore";
import { abapColorSpans, formatCssColor, xmlColorSpans } from "./colors";
import { snapshot } from "./snapshot";
import { VIEW_SELECTOR } from "./selector";
import { attributeAt, attributeSpans, idAt, idSpans } from "./renamewires";
import { planExtract } from "./extractview";
import { expandAbbreviation } from "./abbreviation";

/*
 * Completion and hover from the bundled UI5 metadata.
 *
 * The snapshot the property gate validates against is a complete UI5 API
 * reference - every control with its parent chain, every declared member with
 * its type, `@since` and `@deprecated`, plus the enum tables. It already ships
 * next to the bundle, so offering it while the view is being written costs no
 * dependency, no network and no SAP system: the same knowledge that reports a
 * typo afterwards can prevent it.
 *
 * `languagecore.ts` decides WHAT is offered (it combines `context.ts` -
 * where the cursor is - with `metadata.ts` - what may go there); this module
 * is only the VS Code plumbing around it.
 */

/** Completion kinds that read right in the list: a control is a class, an
 *  event is an event, an aggregation is a slot to put things in. */
const COMPLETION_KIND: Record<CompletionKind, vscode.CompletionItemKind> = {
  control: vscode.CompletionItemKind.Class,
  properties: vscode.CompletionItemKind.Property,
  aggregations: vscode.CompletionItemKind.Field,
  associations: vscode.CompletionItemKind.Reference,
  events: vscode.CompletionItemKind.Event,
  value: vscode.CompletionItemKind.EnumMember,
  namespace: vscode.CompletionItemKind.Module,
  "binding-path": vscode.CompletionItemKind.Field,
  "binding-table": vscode.CompletionItemKind.Struct,
};

function markdown(text: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(text);
  md.isTrusted = false;
  return md;
}

// ---------------------------------------------------------------------------
// Binding paths - offered from the model shape the linter derives
// ---------------------------------------------------------------------------

/**
 * The derived model shape of a class, memoised on the document version -
 * deriving it walks the whole source, and completion asks on keystrokes.
 *
 * Per document, not one global slot: with an app and its detail class open
 * side by side, alternating requests evicted each other and every switch paid
 * the full derivation again. Entries of closed documents are dropped so the
 * map cannot outgrow what is open.
 */
const shapeMemo = new Map<string, { version: number; shape: unknown }>();

function modelShapeOf(doc: vscode.TextDocument): unknown {
  const key = doc.uri.toString();
  const cached = shapeMemo.get(key);
  if (cached && cached.version === doc.version) {
    return cached.shape;
  }
  const prep = prepareAbap(doc.getText());
  const shape = prep.usesBuilder ? prep.modelShape : undefined;
  shapeMemo.set(key, { version: doc.version, shape });
  return shape;
}

/** Called when a document closes - see `shapeMemo`. */
function forgetModelShape(uri: vscode.Uri): void {
  shapeMemo.delete(uri.toString());
}

class ViewCompletion implements vscode.CompletionItemProvider {
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const offer = completionAt(
      doc.getText(),
      doc.fileName,
      doc.offsetAt(position),
      snapshot(),
      () => modelShapeOf(doc)
    );
    if (!offer) {
      return [];
    }
    const range = new vscode.Range(
      doc.positionAt(offer.start),
      doc.positionAt(offer.end)
    );
    return offer.entries.map((entry) => {
      const item = new vscode.CompletionItem(
        entry.label,
        COMPLETION_KIND[entry.kind]
      );
      if (entry.detail !== undefined) {
        item.detail = entry.detail;
      }
      if (entry.documentation !== undefined) {
        item.documentation = markdown(entry.documentation);
      }
      item.range = range;
      if (entry.sortText !== undefined) {
        item.sortText = entry.sortText;
      }
      if (entry.deprecated) {
        item.tags = [vscode.CompletionItemTag.Deprecated];
      }
      return item;
    });
  }
}

class ViewHover implements vscode.HoverProvider {
  provideHover(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const info = hoverAt(
      doc.getText(),
      doc.fileName,
      doc.offsetAt(position),
      snapshot(),
      () => modelShapeOf(doc)
    );
    if (!info) {
      return undefined;
    }
    return new vscode.Hover(
      markdown(info.text),
      new vscode.Range(doc.positionAt(info.start), doc.positionAt(info.end))
    );
  }
}

// ---------------------------------------------------------------------------
// Colour swatches on colour-typed property values
// ---------------------------------------------------------------------------

class ViewColors implements vscode.DocumentColorProvider {
  provideDocumentColors(doc: vscode.TextDocument): vscode.ColorInformation[] {
    const data = snapshot();
    const text = doc.getText();
    const isXml = isXmlView(doc.fileName, text);
    if (!isXml && !usesBuilder(text)) {
      return [];
    }
    const predicate = (control: string, member: string) =>
      isColorMember(data, control, member);
    const spans = isXml
      ? xmlColorSpans(text, predicate)
      : abapColorSpans(text, predicate);
    return spans.map(
      (span) =>
        new vscode.ColorInformation(
          new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end)),
          new vscode.Color(
            span.color.red,
            span.color.green,
            span.color.blue,
            span.color.alpha
          )
        )
    );
  }

  provideColorPresentations(
    color: vscode.Color,
    context: { range: vscode.Range }
  ): vscode.ColorPresentation[] {
    const label = formatCssColor({
      red: color.red,
      green: color.green,
      blue: color.blue,
      alpha: color.alpha,
    });
    const presentation = new vscode.ColorPresentation(label);
    presentation.textEdit = vscode.TextEdit.replace(context.range, label);
    return [presentation];
  }
}

// ---------------------------------------------------------------------------
// Events: definition jumps between _event( ) and the WHEN branch
// ---------------------------------------------------------------------------

/** ABAP sources only - events do not appear in raw view XML this way. */
const ABAP_SELECTOR: vscode.DocumentSelector = [
  { language: "abap" },
  { pattern: "**/*.abap" },
];

class EventDefinition implements vscode.DefinitionProvider {
  provideDefinition(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | vscode.LocationLink[] | undefined {
    const text = doc.getText();
    const offset = doc.offsetAt(position);

    // From the view's _event( 'NAME' ) to the WHEN 'NAME' that handles it.
    const event = eventNameAt(text, offset);
    if (event) {
      const target = whenBranchOf(text, event.name);
      if (target === undefined) {
        return undefined;
      }
      const at = doc.positionAt(target);
      return [
        {
          originSelectionRange: new vscode.Range(
            doc.positionAt(event.start),
            doc.positionAt(event.end)
          ),
          targetUri: doc.uri,
          targetRange: doc.lineAt(at.line).range,
        },
      ];
    }

    // And back: from WHEN 'NAME' to every _event( ) that raises it.
    const when = whenNameAt(text, offset);
    if (when) {
      return eventUsagesOf(text, when.name).map((usage) => {
        const at = doc.positionAt(usage);
        return new vscode.Location(doc.uri, doc.lineAt(at.line).range);
      });
    }

    // From a {…} binding path to the DATA / TYPES line declaring it.
    const data = snapshot();
    const binding = abapBindingContextAt(text, offset, (control, member) =>
      membersOf(data, control).some(
        (m) => m.name === member && m.section === "aggregations"
      )
    );
    if (binding) {
      const path = text.slice(binding.start, binding.end);
      const target = path && declarationSpan(text, path);
      if (target) {
        return [
          {
            originSelectionRange: new vscode.Range(
              doc.positionAt(binding.start),
              doc.positionAt(binding.end)
            ),
            targetUri: doc.uri,
            targetRange: new vscode.Range(
              doc.positionAt(target.start),
              doc.positionAt(target.end)
            ),
          },
        ];
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The client API: hover and completion for client-> calls
// ---------------------------------------------------------------------------

class ClientApiHover implements vscode.HoverProvider {
  provideHover(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const line = doc.lineAt(position.line).text;
    const name = clientCallAt(line, position.character);
    if (!name) {
      return undefined;
    }
    const method = clientMethod(name);
    if (!method) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    if (method.obsolete) {
      md.appendMarkdown(`⚠ **obsolete** — see the note below.\n\n`);
    }
    md.appendCodeblock(method.signature, "abap");
    if (method.doc) {
      md.appendMarkdown(`\n${method.doc}`);
    }
    return new vscode.Hover(md);
  }
}

class ClientApiCompletion implements vscode.CompletionItemProvider {
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const upToCursor = doc
      .lineAt(position.line)
      .text.slice(0, position.character);
    if (!isClientCompletion(upToCursor)) {
      return [];
    }
    // replace the partial member already typed, so accepting an item never
    // doubles what stands there
    const typed = /(\w*)$/.exec(upToCursor)![1];
    const range = new vscode.Range(
      position.line,
      position.character - typed.length,
      position.line,
      position.character
    );
    return clientMethods().map((method) => {
      const item = new vscode.CompletionItem(
        method.name,
        vscode.CompletionItemKind.Method
      );
      item.detail = signatureHead(method);
      if (method.doc) {
        item.documentation = markdown(method.doc);
      }
      item.range = range;
      // the interface's abapdoc says obsolete -> struck through and last,
      // so the list itself steers to the current API
      if (method.obsolete) {
        item.tags = [vscode.CompletionItemTag.Deprecated];
      }
      item.sortText = `${method.obsolete ? "1" : "0"}${method.name}`;
      return item;
    });
  }
}

// ---------------------------------------------------------------------------
// Format Document: builder-chain indentation
// ---------------------------------------------------------------------------

class ChainFormatting implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    doc: vscode.TextDocument
  ): vscode.TextEdit[] {
    const text = doc.getText();
    if (!usesBuilder(text)) {
      return []; // nothing to format - the chains are what this understands
    }
    return chainIndentEdits(text).map((edit) => {
      const line = doc.lineAt(edit.line);
      const leading = line.text.length - line.text.trimStart().length;
      return vscode.TextEdit.replace(
        new vscode.Range(edit.line, 0, edit.line, leading),
        edit.indent
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Methods: definition jump and workspace-wide symbol search
// ---------------------------------------------------------------------------

class MethodDefinition implements vscode.DefinitionProvider {
  provideDefinition(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Definition | undefined {
    const wordRange = doc.getWordRangeAtPosition(position, /[\w~/]+/);
    if (!wordRange) {
      return undefined;
    }
    const word = doc.getText(wordRange);
    // only a call takes the jump - a `(` right after the name; anything else
    // is left to the ABAP extension's own resolution
    const after = doc
      .lineAt(position.line)
      .text.slice(wordRange.end.character);
    if (!/^\s*\(/.test(after)) {
      return undefined;
    }
    const text = doc.getText();
    const cursor = doc.offsetAt(position);
    for (const m of methodImplementations(text)) {
      if (
        m.name.toLowerCase() === word.toLowerCase() &&
        // the implementation itself is not its own definition
        (cursor < m.start || cursor > m.end)
      ) {
        return new vscode.Location(
          doc.uri,
          new vscode.Range(doc.positionAt(m.start), doc.positionAt(m.end))
        );
      }
    }
    return undefined;
  }
}

/** How many files the workspace symbol search is willing to read - beyond
 *  this a workspace is better served by a real ABAP language server. */
const SYMBOL_FILE_CAP = 500;

class MethodWorkspaceSymbols implements vscode.WorkspaceSymbolProvider {
  async provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[]> {
    if (query.length < 2) {
      return []; // a one-letter query would match half of every file
    }
    const files = await vscode.workspace.findFiles(
      "**/*.abap",
      "**/{node_modules,.git,dist,out}/**",
      SYMBOL_FILE_CAP
    );
    const needle = query.toLowerCase();
    const symbols: vscode.SymbolInformation[] = [];
    for (const uri of files) {
      if (token.isCancellationRequested) {
        break;
      }
      let text: string;
      try {
        text = Buffer.from(
          await vscode.workspace.fs.readFile(uri)
        ).toString("utf8");
      } catch {
        continue;
      }
      for (const m of methodImplementations(text)) {
        if (!m.name.toLowerCase().includes(needle)) {
          continue;
        }
        // line/character from the offset without opening a TextDocument -
        // opening hundreds of documents is what would make this slow
        const before = text.slice(0, m.start);
        const line = (before.match(/\n/g) ?? []).length;
        const col = m.start - (before.lastIndexOf("\n") + 1);
        symbols.push(
          new vscode.SymbolInformation(
            m.name,
            vscode.SymbolKind.Method,
            uri.path.split("/").pop() ?? "",
            new vscode.Location(
              uri,
              new vscode.Range(line, col, line, col + m.name.length)
            )
          )
        );
      }
    }
    return symbols;
  }
}

// ---------------------------------------------------------------------------
// Rename: a name an abap2UI5 app ties itself together with, everywhere it
// appears - an event, a control id, a bound attribute
// ---------------------------------------------------------------------------

/**
 * What the cursor is on, in the order the three can be told apart: an event
 * name (a literal in `_event( )` or `WHEN`), a control id (a literal in an
 * `id` attribute or an id-taking wire), or an attribute the class declares.
 */
function renameTargetAt(text: string, offset: number): NamedSpan | undefined {
  return (
    eventNameAt(text, offset) ??
    whenNameAt(text, offset) ??
    idAt(text, offset) ??
    attributeAt(text, offset)
  );
}

/** Everywhere that name is written - resolved by the same order, so the kind
 *  of thing decided in prepareRename is the kind of thing replaced. */
function renameSpans(text: string, offset: number, name: string): NamedSpan[] {
  if (eventNameAt(text, offset) ?? whenNameAt(text, offset)) {
    return eventNameSpans(text, name);
  }
  if (idAt(text, offset)) {
    return idSpans(text, name);
  }
  return attributeSpans(text, name);
}

class WireRename implements vscode.RenameProvider {
  /** Only the three names above are renameable here - anything else defers
   *  to other providers by throwing, which is the protocol for "not mine". */
  prepareRename(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): { range: vscode.Range; placeholder: string } {
    const text = doc.getText();
    const span = renameTargetAt(text, doc.offsetAt(position));
    if (!span) {
      throw new Error(
        "Only event names, control ids and bound attributes can be renamed here."
      );
    }
    return {
      range: new vscode.Range(
        doc.positionAt(span.start),
        doc.positionAt(span.end)
      ),
      placeholder: span.name,
    };
  }

  provideRenameEdits(
    doc: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): vscode.WorkspaceEdit {
    if (!/^[\w-]+$/.test(newName)) {
      throw new Error(
        "An event name, id or attribute may only contain letters, digits, _ and -."
      );
    }
    const text = doc.getText();
    const offset = doc.offsetAt(position);
    const span = renameTargetAt(text, offset);
    if (!span) {
      throw new Error(
        "Only event names, control ids and bound attributes can be renamed here."
      );
    }
    const edit = new vscode.WorkspaceEdit();
    /* Every place the class writes this name, whichever half of the app
     * writes it. The strings are what tie an abap2UI5 app together and
     * nothing in ABAP or UI5 connects the two ends, so renaming one end and
     * missing the other is silent: a wire that addresses nothing does
     * nothing at runtime, and a binding path that resolves to nothing
     * renders empty. Neither reports a thing. */
    const targets = renameSpans(text, offset, span.name);
    for (const [index, target] of targets.entries()) {
      const range = new vscode.Range(
        doc.positionAt(target.start),
        doc.positionAt(target.end)
      );
      /* Marking the edits as needing confirmation is what makes VS Code open
       * the refactor PREVIEW instead of applying straight away - worth it for
       * a rename that crosses from ABAP into view literals on the strength of
       * where a string stands, and switchable for anyone who would rather
       * just rename (the preview stays reachable with Ctrl+Shift+Enter, and
       * the labels below are what it reads). */
      edit.replace(doc.uri, range, newName, {
        needsConfirmation: vscode.workspace
          .getConfiguration("abap2ui5")
          .get<boolean>("renamePreview", true),
        label:
          index === 0
            ? `Rename ${span.name} to ${newName} - ${targets.length} occurrence${
                targets.length === 1 ? "" : "s"
              }`
            : `${span.name} -> ${newName}`,
        description: doc.lineAt(range.start.line).text.trim(),
      });
    }
    return edit;
  }
}

// ---------------------------------------------------------------------------
// Outline: the view hierarchy as symbols
// ---------------------------------------------------------------------------

class ViewOutlineSymbols implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(doc: vscode.TextDocument): vscode.DocumentSymbol[] {
    const text = doc.getText();
    if (/^\s*</.test(text) || !usesBuilder(text)) {
      return []; // raw XML has outlines of its own; non-builder classes too
    }
    const clamp = (offset: number) => Math.min(offset, text.length);
    const toSymbol = (node: OutlineNode): vscode.DocumentSymbol => {
      const symbol = new vscode.DocumentSymbol(
        node.label,
        node.id ? `#${node.id}` : "",
        node.container
          ? vscode.SymbolKind.Object
          : vscode.SymbolKind.Field,
        new vscode.Range(
          doc.positionAt(clamp(node.start)),
          doc.positionAt(clamp(node.end + 1))
        ),
        new vscode.Range(
          doc.positionAt(clamp(node.selStart)),
          doc.positionAt(clamp(node.selEnd))
        )
      );
      symbol.children = node.children.map(toSymbol);
      return symbol;
    };
    return viewOutline(text).map(toSymbol);
  }
}

export function registerLanguageFeatures(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      VIEW_SELECTOR,
      new ViewCompletion(),
      // The quotes are where a control, a member or a value starts in the
      // builder; `<` and the space are the same positions in raw XML. `{`
      // and `/` are where a binding path starts and descends.
      "`",
      "'",
      '"',
      "<",
      " ",
      "{",
      "/"
    ),
    vscode.languages.registerHoverProvider(VIEW_SELECTOR, new ViewHover()),
    vscode.languages.registerColorProvider(VIEW_SELECTOR, new ViewColors()),
    vscode.languages.registerDefinitionProvider(
      ABAP_SELECTOR,
      new EventDefinition()
    ),
    vscode.languages.registerRenameProvider(ABAP_SELECTOR, new WireRename()),
    vscode.workspace.onDidCloseTextDocument((doc) => forgetModelShape(doc.uri)),

    vscode.commands.registerCommand("abap2ui5.extractViewMethod", () =>
      extractViewMethod(log)
    ),

    vscode.commands.registerCommand("abap2ui5.expandAbbreviation", () =>
      expandChainAbbreviation(log)
    ),
    // The label keeps this outline apart from the ABAP extension's own.
    vscode.languages.registerDocumentSymbolProvider(
      ABAP_SELECTOR,
      new ViewOutlineSymbols(),
      { label: "abap2UI5 view" }
    ),
    // `>` is the last character of `client->` - the completion opens right
    // when the arrow is finished.
    vscode.languages.registerCompletionItemProvider(
      ABAP_SELECTOR,
      new ClientApiCompletion(),
      ">"
    ),
    vscode.languages.registerHoverProvider(ABAP_SELECTOR, new ClientApiHover()),
    vscode.languages.registerDocumentFormattingEditProvider(
      ABAP_SELECTOR,
      new ChainFormatting()
    ),
    vscode.languages.registerDefinitionProvider(
      ABAP_SELECTOR,
      new MethodDefinition()
    ),
    vscode.languages.registerWorkspaceSymbolProvider(
      new MethodWorkspaceSymbols()
    )
  );
  log(
    "language: completion, hover, client API, chain formatting, " +
      "method navigation and view outline registered"
  );
}

// ---------------------------------------------------------------------------
// Extract a chain section into a view method
// ---------------------------------------------------------------------------

/**
 * "Extract to View Method": the tail of the chain under the cursor moves into
 * a method of its own, taking the builder as a handle.
 *
 * The idiom is abap2UI5's own - a helper `IMPORTING box RETURNING result`,
 * both `TYPE REF TO z2ui5_cl_ui5_view_builder` - and the linter follows it, so
 * the extracted view is still reconstructed and still checked. Doing it by
 * hand means splitting one statement without breaking its parenthesis balance
 * and remembering the declaration; `extractview.ts` computes both.
 */
async function extractViewMethod(
  log: (m: string) => void
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "abap") {
    vscode.window.showInformationMessage(
      "abap2UI5: open an ABAP class and put the cursor on the chain call to extract."
    );
    return;
  }
  const name = await vscode.window.showInputBox({
    title: "abap2UI5: extract to view method",
    prompt: "Name for the new method - it takes the builder and returns it",
    value: "render_section",
    validateInput: (value) =>
      /^[a-z][a-z0-9_]{0,28}$/i.test(value)
        ? undefined
        : "A method name starts with a letter and holds letters, digits and _.",
  });
  if (!name) {
    return;
  }
  const doc = editor.document;
  const plan = planExtract(
    doc.getText(),
    doc.offsetAt(editor.selection.start),
    name
  );
  if ("error" in plan) {
    vscode.window.showWarningMessage(`abap2UI5: ${plan.error}`);
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.set(
    doc.uri,
    plan.edits.map(
      (e) =>
        new vscode.TextEdit(
          new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
          e.text
        )
    )
  );
  await vscode.workspace.applyEdit(edit);
  log(`extract: ${name}( ${plan.handle} ) created`);
  vscode.window.showInformationMessage(
    `abap2UI5: extracted into ${name}( ${plan.handle} ).`
  );
}

// ---------------------------------------------------------------------------
// Emmet for chains
// ---------------------------------------------------------------------------

/**
 * "Expand Abbreviation": the word under the cursor - `Page>content>Button*3` -
 * becomes the chain that builds it.
 *
 * Whether it scaffolds a whole view or continues the chain it is standing in
 * is decided here, from the statement around the cursor: inside one, the
 * expansion has to hang off the previous call and must not carry a factory or
 * a `view_display( )`. Both shapes come out of `abbreviation.ts`; this reads
 * the line and puts the result back.
 */
async function expandChainAbbreviation(log: (m: string) => void): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "abap") {
    vscode.window.showInformationMessage(
      "abap2UI5: write an abbreviation like Page>content>Button*3 in an ABAP file first."
    );
    return;
  }
  const doc = editor.document;
  const selection = editor.selection;
  const line = doc.lineAt(selection.start.line);
  const source = selection.isEmpty ? line.text.trim() : doc.getText(selection);
  const range = selection.isEmpty
    ? new vscode.Range(
        line.range.start.translate(0, /^\s*/.exec(line.text)?.[0].length ?? 0),
        line.range.end
      )
    : selection;

  /* A chain is one statement, so "am I inside one" is answered by the text
   * from the previous period to here: a builder call in it means the
   * statement is open and the expansion continues it. */
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), range.start));
  const statement = before.slice(before.lastIndexOf(".") + 1);
  const continuation = /->\s*(?:ele|tag|a)\s*\(/i.test(statement);
  const indent = /^[ \t]*/.exec(line.text)?.[0] ?? "";

  const { abap, error } = expandAbbreviation(source, indent, continuation);
  if (error) {
    vscode.window.showWarningMessage(`abap2UI5: ${error}`);
    return;
  }
  await editor.edit((builder) => builder.replace(range, abap.trimStart()));
  log(`abbreviation: expanded "${source}"${continuation ? " into the open chain" : ""}`);
}
