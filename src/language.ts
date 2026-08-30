import * as vscode from "vscode";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import { AbapSource, abapSources, watchAbapSources } from "./abapsources";
import { blankNonCode } from "./abapscan";
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
  apiReferenceUrl,
  clientCallAt,
  clientCallSpanAt,
  clientMethod,
  clientMethods,
  clientSignatureContext,
  isClientCompletion,
  signatureHead,
  signatureParameters,
} from "./clientapi";
import { chainFormatEdits } from "./chainformat";
import { membersOf } from "./metadata";
import {
  CompletionEntry,
  CompletionKind,
  completionAt,
  hoverAt,
  isColorMember,
  isXmlView,
} from "./languagecore";
import { abapColorSpans, cssColorPresentations, xmlColorSpans } from "./colors";
import { snapshot } from "./snapshot";
import { CONFIG_SECTION } from "./settings";
import { VIEW_SELECTOR } from "./selector";
import {
  attributeAt,
  attributeSpans,
  idAt,
  idCompletionAt,
  idSpans,
  renameNameError,
  type RenameKind,
} from "./renamewires";
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

type Prep = ReturnType<typeof prepareAbap>;

/**
 * The linter's reconstruction of a class, memoised on the document version -
 * deriving it walks the whole source, and completion asks on keystrokes. The
 * inline annotations read the same reconstruction (`nodes`, `model`), so one
 * parse per version serves both instead of each paying its own.
 *
 * Per document, not one global slot: with an app and its detail class open
 * side by side, alternating requests evicted each other and every switch paid
 * the full derivation again. Entries of closed documents are dropped so the
 * map cannot outgrow what is open.
 */
const prepMemo = new Map<string, { version: number; prep: Prep | undefined }>();

export function preparedAbapOf(doc: vscode.TextDocument): Prep | undefined {
  const key = doc.uri.toString();
  const cached = prepMemo.get(key);
  if (cached && cached.version === doc.version) {
    return cached.prep;
  }
  let prep: Prep | undefined;
  try {
    prep = prepareAbap(doc.getText());
  } catch {
    prep = undefined; // an unparsable buffer mid-edit answers with nothing
  }
  prepMemo.set(key, { version: doc.version, prep });
  return prep;
}

function modelShapeOf(doc: vscode.TextDocument): unknown {
  const prep = preparedAbapOf(doc);
  return prep?.usesBuilder ? prep.modelShape : undefined;
}

/** Called when a document closes - see `prepMemo`. */
function forgetModelShape(uri: vscode.Uri): void {
  prepMemo.delete(uri.toString());
}

/** The core entry behind each offered item, for `resolveCompletionItem` -
 *  the documentation is a lazy getter there, and reading it for every entry
 *  of a several-hundred-item list on the keystroke is what this avoids. */
const completionEntries = new WeakMap<vscode.CompletionItem, CompletionEntry>();

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
      completionEntries.set(item, entry);
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

  resolveCompletionItem(item: vscode.CompletionItem): vscode.CompletionItem {
    const documentation = completionEntries.get(item)?.documentation;
    if (documentation) {
      item.documentation = markdown(documentation);
    }
    return item;
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
    // More than one spelling, so clicking the picker's label cycles formats
    // the way it does in a CSS file. The first is what accepting writes.
    return cssColorPresentations({
      red: color.red,
      green: color.green,
      blue: color.blue,
      alpha: color.alpha,
    }).map((label) => {
      const presentation = new vscode.ColorPresentation(label);
      presentation.textEdit = vscode.TextEdit.replace(context.range, label);
      return presentation;
    });
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

/** The line as the LEXER sees it: comments and literal content blanked, so a
 *  `client->` quoted in either stays quiet. The raw line is tested first -
 *  blanking the whole document for a line that plainly has no client call
 *  would be work for nothing. */
function blankedLineOf(
  doc: vscode.TextDocument,
  position: vscode.Position
): string {
  const line = doc.lineAt(position.line);
  const start = doc.offsetAt(line.range.start);
  return blankNonCode(doc.getText()).slice(start, start + line.text.length);
}

class ClientApiHover implements vscode.HoverProvider {
  provideHover(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const line = doc.lineAt(position.line).text;
    if (!clientCallAt(line, position.character)) {
      return undefined;
    }
    const span = clientCallSpanAt(
      blankedLineOf(doc, position),
      position.character
    );
    if (!span) {
      return undefined; // a comment or a literal quoting the call
    }
    const method = clientMethod(span.name);
    if (!method) {
      return undefined;
    }
    const md = new vscode.MarkdownString();
    md.isTrusted = false;
    if (method.obsolete) {
      // "see the note below" only when the abapdoc actually carries one
      md.appendMarkdown(
        method.doc
          ? `⚠ **obsolete** — see the note below.\n\n`
          : `⚠ **obsolete**\n\n`
      );
    }
    md.appendCodeblock(method.signature, "abap");
    if (method.doc) {
      md.appendMarkdown(`\n${method.doc}`);
    }
    md.appendMarkdown(
      `\n\n[Client API Reference](${apiReferenceUrl(method.name)})`
    );
    // the exact name span, so the editor highlights the method rather than
    // guessing a word around the cursor
    return new vscode.Hover(
      md,
      new vscode.Range(position.line, span.start, position.line, span.end)
    );
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
    if (
      !isClientCompletion(
        blankedLineOf(doc, position).slice(0, position.character)
      )
    ) {
      return []; // the arrow stands in a comment or a literal
    }
    // replace the partial member already typed, so accepting an item never
    // doubles what stands there - and with the cursor mid-word, the tail of
    // the word too, or `view_di‸splay` would keep its `splay`
    const typed = /(\w*)$/.exec(upToCursor)![1];
    const trailing = /^\w*/.exec(
      doc.lineAt(position.line).text.slice(position.character)
    )![0];
    const range = {
      inserting: new vscode.Range(
        position.line,
        position.character - typed.length,
        position.line,
        position.character
      ),
      replacing: new vscode.Range(
        position.line,
        position.character - typed.length,
        position.line,
        position.character + trailing.length
      ),
    };
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
      // typing the opening paren accepts the method and flows straight into
      // the signature help that `(` triggers
      item.commitCharacters = ["("];
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

/** How far back signature help reads for the open `client->…(` - the corpus
 *  writes one argument per line, so the call the cursor is in regularly
 *  opened lines above, and a single-line prefix went silent on every
 *  continuation line. A client call longer than this is not a real one. */
const SIGNATURE_LOOKBACK = 500;

/**
 * Signature help inside a `client->…( )` call: the parameters from the
 * bundled interface, the one being written highlighted. The context comes
 * from blanked source, so an `=` inside a literal argument does not pass
 * for a parameter assignment and a call quoted in a comment offers nothing.
 */
class ClientApiSignatureHelp implements vscode.SignatureHelpProvider {
  provideSignatureHelp(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.SignatureHelp | undefined {
    const offset = doc.offsetAt(position);
    const text = doc.getText();
    const from = Math.max(0, offset - SIGNATURE_LOOKBACK);
    // The raw window first - the same pattern `blankedLineOf` documents. `(`
    // and `,` are trigger characters, so this ran on every one of them typed
    // anywhere in any ABAP file and blanked the whole class to read the last
    // 500 characters of it. Blanking only ever replaces characters with
    // spaces, so a window with no `client->` in the raw text has none in the
    // blanked one either, and the context below would answer nothing.
    if (!/client->/i.test(text.slice(from, offset))) {
      return undefined;
    }
    const prefix = blankNonCode(text).slice(from, offset);
    const context = clientSignatureContext(prefix);
    if (!context) {
      return undefined;
    }
    const { method, parameter } = context;
    const params = signatureParameters(method);
    const labels = params.map((name) => `${name} = …`);
    const head = `${method.name}( `;
    const signature = new vscode.SignatureInformation(
      `${head}${labels.join("  ")} )`
    );
    // each label as its offsets into the signature string - a substring
    // match would bold `val = …` inside a longer `check_val = …` label
    const spans: Array<[number, number]> = [];
    let cursor = head.length;
    for (const label of labels) {
      spans.push([cursor, cursor + label.length]);
      cursor += label.length + 2; // the join's two spaces
    }
    const lines = method.signature.split("\n");
    signature.parameters = params.map((name, ix) => {
      const info = new vscode.ParameterInformation(spans[ix]);
      const declared = lines.find((line) =>
        new RegExp(`^\\s+${name}\\s+TYPE\\b`).test(line)
      );
      if (declared) {
        info.documentation = declared.trim();
      }
      return info;
    });
    if (method.doc) {
      signature.documentation = markdown(method.doc);
    }
    const help = new vscode.SignatureHelp();
    help.signatures = [signature];
    help.activeSignature = 0;
    const active = parameter
      ? params.findIndex((name) => name.toLowerCase() === parameter)
      : -1;
    // a written name that matches nothing (a typo) highlights NO parameter
    // rather than implying the first one is being filled
    help.activeParameter = active >= 0 ? active : parameter ? params.length : 0;
    return help;
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
    // Character spans, because that is what the linter's layout fixes are:
    // they normalise the whitespace BETWEEN chain segments, newline included,
    // not just a line's indent.
    return chainFormatEdits(text).map((edit) =>
      vscode.TextEdit.replace(
        new vscode.Range(doc.positionAt(edit.start), doc.positionAt(edit.end)),
        edit.text
      )
    );
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

/*
 * The symbol picker re-queries on every keystroke, and `abapSources` reads
 * every file from disk each time - so one typed word cost hundreds of reads
 * per letter. A few seconds of staleness is invisible in a picker; the
 * per-file method lists are memoised on the text, which the source cache
 * hands back unchanged between refreshes.
 */
const SYMBOL_CACHE_MS = 5000;
const SYMBOL_CACHE_DROP_MS = 30000;
/** The RUN, not its result: the cache used to be filled only once the sweep
 *  had resolved, so the three or four keystrokes typed while the first one was
 *  still reading each started a full sweep of their own and none of them saw
 *  the others. Remembering the promise makes overlapping callers await the
 *  same one. */
let symbolSources:
  | { at: number; promise: Promise<AbapSource[]> }
  | undefined;
let symbolCacheDrop: NodeJS.Timeout | undefined;
const methodMemo = new Map<
  string,
  { text: string; methods: ReturnType<typeof methodImplementations> }
>();

/** The picker is a burst: cache hard while it types, let go of the texts
 *  soon after it closes. */
function scheduleSymbolCacheDrop(): void {
  if (symbolCacheDrop) {
    clearTimeout(symbolCacheDrop);
  }
  symbolCacheDrop = setTimeout(() => {
    symbolCacheDrop = undefined;
    symbolSources = undefined;
    methodMemo.clear();
  }, SYMBOL_CACHE_DROP_MS);
}

/*
 * Deliberately NOT threaded with the caller's CancellationToken: the sweep is
 * shared between the overlapping calls one typed word produces, and VS Code
 * cancels the previous call on every keystroke. A token honoured inside the
 * scan would let a cancelled caller leave a HALF-READ workspace in the cache
 * for the keystroke that replaced it, which is a wrong answer rather than a
 * slow one. The reads themselves are served from `abapsources`' shared cache
 * now, so the sweep this guards is a glob plus the files that changed.
 */
async function symbolSourcesCached(): Promise<AbapSource[]> {
  scheduleSymbolCacheDrop();
  const now = Date.now();
  if (symbolSources && now - symbolSources.at < SYMBOL_CACHE_MS) {
    return symbolSources.promise;
  }
  const promise = abapSources(SYMBOL_FILE_CAP).then((sources) => {
    const known = new Set(sources.map((source) => source.uri.toString()));
    for (const key of [...methodMemo.keys()]) {
      if (!known.has(key)) {
        methodMemo.delete(key);
      }
    }
    return sources;
  });
  const entry = { at: now, promise };
  symbolSources = entry;
  try {
    return await promise;
  } catch (err) {
    // a failed sweep must not be served to the next keystroke as if it were
    // an answer
    if (symbolSources === entry) {
      symbolSources = undefined;
    }
    throw err;
  }
}

function methodsOf(uri: vscode.Uri, text: string) {
  const key = uri.toString();
  const cached = methodMemo.get(key);
  if (cached && cached.text === text) {
    return cached.methods;
  }
  const methods = methodImplementations(text);
  methodMemo.set(key, { text, methods });
  return methods;
}

class MethodWorkspaceSymbols implements vscode.WorkspaceSymbolProvider {
  async provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken
  ): Promise<vscode.SymbolInformation[]> {
    if (query.length < 2) {
      return []; // a one-letter query would match half of every file
    }
    // files and open documents, so the methods of a class opened through ADT
    // are reachable from Ctrl+T like any other
    const sources = await symbolSourcesCached();
    if (token.isCancellationRequested) {
      return [];
    }
    const needle = query.toLowerCase();
    const symbols: vscode.SymbolInformation[] = [];
    for (const { uri, text } of sources) {
      if (token.isCancellationRequested) {
        break;
      }
      /*
       * line/character from the offset without opening a TextDocument -
       * opening hundreds of documents is what would make this slow.
       *
       * Counted forward with the matches, which come out in ascending offset
       * order: it used to slice the whole prefix of the file per hit and run
       * a `/\n/g` match over it, so a query matching thirty methods in a
       * 100 KB class copied and scanned three megabytes - per keystroke, per
       * file. Same pattern as `examples.findControlUses`.
       */
      let line = 0;
      let lineStart = 0;
      let counted = 0;
      for (const m of methodsOf(uri, text)) {
        if (!m.name.toLowerCase().includes(needle)) {
          continue;
        }
        for (let i = counted; i < m.start; i++) {
          if (text.charCodeAt(i) === 10) {
            line++;
            lineStart = i + 1;
          }
        }
        counted = m.start;
        const col = m.start - lineStart;
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

interface RenameTarget {
  kind: RenameKind;
  span: NamedSpan;
}

/**
 * What the cursor is on, in the order the three can be told apart: an event
 * name (a literal in `_event( )` or `WHEN`), a control id (a literal in an
 * `id` attribute or an id-taking wire), or an attribute the class declares.
 */
function renameTargetAt(text: string, offset: number): RenameTarget | undefined {
  const event = eventNameAt(text, offset) ?? whenNameAt(text, offset);
  if (event) {
    return { kind: "event", span: event };
  }
  const id = idAt(text, offset);
  if (id) {
    return { kind: "id", span: id };
  }
  const attribute = attributeAt(text, offset);
  return attribute ? { kind: "attribute", span: attribute } : undefined;
}

/** Everywhere that name is written - by the kind already resolved, so the
 *  thing decided in prepareRename is the thing replaced. */
function renameSpans(
  text: string,
  target: RenameTarget,
  name: string
): NamedSpan[] {
  if (target.kind === "event") {
    return eventNameSpans(text, name);
  }
  if (target.kind === "id") {
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
    const target = renameTargetAt(text, doc.offsetAt(position));
    if (!target) {
      throw new Error(
        "Only event names, control ids and bound attributes can be renamed here."
      );
    }
    return {
      range: new vscode.Range(
        doc.positionAt(target.span.start),
        doc.positionAt(target.span.end)
      ),
      placeholder: target.span.name,
    };
  }

  provideRenameEdits(
    doc: vscode.TextDocument,
    position: vscode.Position,
    newName: string
  ): vscode.WorkspaceEdit {
    const text = doc.getText();
    const offset = doc.offsetAt(position);
    // The KIND first: the three do not share a spelling rule, and one
    // permissive test for all of them let an attribute be renamed to
    // something that is not an ABAP identifier at all.
    const target = renameTargetAt(text, offset);
    if (!target) {
      throw new Error(
        "Only event names, control ids and bound attributes can be renamed here."
      );
    }
    const invalid = renameNameError(target.kind, newName);
    if (invalid) {
      throw new Error(invalid);
    }
    const span = target.span;
    const edit = new vscode.WorkspaceEdit();
    /* Every place the class writes this name, whichever half of the app
     * writes it. The strings are what tie an abap2UI5 app together and
     * nothing in ABAP or UI5 connects the two ends, so renaming one end and
     * missing the other is silent: a wire that addresses nothing does
     * nothing at runtime, and a binding path that resolves to nothing
     * renders empty. Neither reports a thing. */
    const targets = renameSpans(text, target, span.name);
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
          .getConfiguration(CONFIG_SECTION)
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
// The wiring loop: complete a control id where a wire addresses one, and light
// up both ends of the wire the cursor is on
// ---------------------------------------------------------------------------

/**
 * The ids the view declares, offered inside `set_focus( '…' )`,
 * `by_id = '…'` and the other id-taking wires.
 *
 * The extension already knows every id both ends of a wire use - the rename
 * and the CodeLens are built on it - and a typo in the ABAP end is exactly
 * the defect that produces nothing at runtime: no error, no console line, the
 * wire simply addresses nothing. Offering the declared names is the cheapest
 * possible place to prevent it.
 */
class ControlIdCompletion implements vscode.CompletionItemProvider {
  provideCompletionItems(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] {
    const offer = idCompletionAt(doc.getText(), doc.offsetAt(position));
    if (!offer) {
      return [];
    }
    const range = new vscode.Range(
      doc.positionAt(offer.start),
      doc.positionAt(offer.end)
    );
    return offer.ids.map((id) => {
      const item = new vscode.CompletionItem(
        id,
        vscode.CompletionItemKind.Value
      );
      item.detail = "declared in this view";
      item.range = range;
      return item;
    });
  }
}

/**
 * The other ends of the wire the cursor is on: every `_event( )` and `WHEN`
 * naming the same event, every place the same control id is written.
 *
 * Nothing in ABAP or UI5 connects those strings, so an editor that highlights
 * them is the only thing in the window that shows a wire as one thing.
 *
 * Events and ids only. A bound attribute is renameable too, but finding its
 * spans means a regex over the whole source per identifier, and a highlight
 * provider runs on every cursor movement.
 */
class WireHighlights implements vscode.DocumentHighlightProvider {
  provideDocumentHighlights(
    doc: vscode.TextDocument,
    position: vscode.Position
  ): vscode.DocumentHighlight[] {
    const text = doc.getText();
    const offset = doc.offsetAt(position);
    const event = eventNameAt(text, offset) ?? whenNameAt(text, offset);
    const spans = event
      ? eventNameSpans(text, event.name)
      : (() => {
          const id = idAt(text, offset);
          return id ? idSpans(text, id.name) : [];
        })();
    return spans.map(
      (span) =>
        new vscode.DocumentHighlight(
          new vscode.Range(
            doc.positionAt(span.start),
            doc.positionAt(span.end)
          ),
          vscode.DocumentHighlightKind.Text
        )
    );
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
  // The workspace symbol search reads the window's ABAP; the shared watcher is
  // what keeps its cache honest. Idempotent - the apps tree and the app-class
  // index ask for the same one, and in the web host this is the only caller.
  watchAbapSources(context);

  /*
   * Warm the metadata snapshot.
   *
   * `snapshot( )` is lazy, and parsing the several-MB properties.json blocks
   * the extension host. In a window where no view check has run yet, that bill
   * was paid by whichever completion, hover or colour request came first -
   * i.e. in the middle of typing. Doing it right after activation instead
   * costs nothing anybody is waiting for.
   *
   * `setTimeout` rather than `setImmediate`: this module is in the WEB bundle
   * too, and a browser extension host has no `setImmediate`. A missing or
   * broken snapshot is not an error here - `snapshot( )` swallows it and
   * `snapshotError( )` is what reports it, once, where it is read.
   */
  setTimeout(() => {
    try {
      snapshot();
    } catch {
      // snapshot() handles its own failure; this is belt and braces
    }
  }, 0);

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (symbolCacheDrop) {
        clearTimeout(symbolCacheDrop);
        symbolCacheDrop = undefined;
      }
    }),
    vscode.languages.registerCompletionItemProvider(
      VIEW_SELECTOR,
      new ViewCompletion(),
      // The quotes are where a control, a member or a value starts in the
      // builder; `<` and the space are the same positions in raw XML. `{`
      // and `/` are where a binding path starts and descends. `:` finishes
      // a namespace prefix (`f:` in either syntax), and re-querying there is
      // what swaps the list from sap.m to the prefixed library.
      "`",
      "'",
      '"',
      "<",
      " ",
      "{",
      "/",
      ":"
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
    // The ids a wire may address - the quotes are where one starts, in either
    // spelling the corpus uses.
    vscode.languages.registerCompletionItemProvider(
      ABAP_SELECTOR,
      new ControlIdCompletion(),
      "`",
      "'"
    ),
    // both ends of the wire under the cursor, lit up together
    vscode.languages.registerDocumentHighlightProvider(
      ABAP_SELECTOR,
      new WireHighlights()
    ),
    // the parameters of the call being written, from the same bundled
    // interface the hover reads
    vscode.languages.registerSignatureHelpProvider(
      ABAP_SELECTOR,
      new ClientApiSignatureHelp(),
      "(",
      ","
    ),
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
      "method navigation, wire completion and highlights, and view outline registered"
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
    title: "abap2UI5: Extract to View Method",
    prompt: "Name for the new method - it takes the builder and returns it",
    value: "render_section",
    validateInput: (value) =>
      /^[a-z][a-z0-9_]{0,29}$/i.test(value)
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
  /* Marked with refactor metadata so VS Code can show what the extraction
   * does per edit - the labels come from the plan itself, which knows which
   * edit cuts the chain and which one adds the method. */
  for (const e of plan.edits) {
    edit.replace(
      doc.uri,
      new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
      e.text,
      { needsConfirmation: true, label: e.label }
    );
  }
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
   * statement is open and the expansion continues it.
   *
   * Which period, though, is a lexical question - `lastIndexOf(".")` found one
   * inside a comment or a literal just as happily (`view->ele( \`Page\`  " main
   * page.`), cut the statement short, decided it was not a continuation, and
   * inserted a whole new `DATA(view) = …factory( ).` statement into the middle
   * of an open chain. `blankNonCode` keeps the offsets, so the index still
   * points into the real text. */
  const before = doc.getText(new vscode.Range(new vscode.Position(0, 0), range.start));
  const statement = before.slice(blankNonCode(before).lastIndexOf(".") + 1);
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
