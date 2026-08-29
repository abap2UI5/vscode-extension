import * as vscode from "vscode";
import { mockFileFor } from "./viewpreview";
import { CONFIG_SECTION } from "./settings";
import { DIAG_SOURCE } from "./diagnostics";

import * as fs from "fs";
import { deprecationText, memberInfo, controlInfo } from "./metadata";
import { snapshot } from "./snapshot";
import { abapNsMap } from "./context";
import {
  Annotation,
  costAnnotations,
  deprecationAnnotations,
  sinceAnnotations,
} from "./annotations";
import { usesBuilder } from "./abap";
import { VIEW_XML_RE } from "./languagecore";
import { preparedAbapOf } from "./language";

/*
 * What the editor says about a line without being asked - the three inline
 * annotations, in one decoration pass.
 *
 *   findings   the view check's message at the end of its own line, so a
 *              defect does not need the Problems panel to be read (the
 *              Error Lens pattern). In a forty-line chain the squiggle is
 *              exactly where you are looking and the message is not.
 *
 *   since      the UI5 version a control or attribute arrived in, warned when
 *              it is above the configured floor (the Version Lens pattern).
 *              "Does my system have this yet?" is the permanent abap2UI5
 *              question, and the answer already ships in the metadata.
 *
 *   cost       what a PUBLIC attribute adds to every roundtrip (the Import
 *              Cost pattern) - abap2UI5 serializes all of them, every time.
 *
 * One pass, because they are the same mechanism and because three passes over
 * the same buffer on every keystroke would be three times the cost of the one
 * thing that has to stay cheap.
 */


/** How far a decoration may sit from the end of the line - a chain line is
 *  long, and pushing the annotation past the viewport helps nobody. */
const MAX_TEXT = 120;

type Mode = "off" | "problems" | "all";

function decoration(color: string): vscode.TextEditorDecorationType {
  return vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor(color),
      margin: "0 0 0 2em",
      fontStyle: "italic",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

export function registerInlineAnnotations(
  context: vscode.ExtensionContext,
  log: (m: string) => void
): void {
  /* One decoration type per COLOUR, not one per source: warning-severity
   * findings and warn-worthy annotations render identically and share a type
   * (and one setDecorations call). Information/Hint findings get the editor's
   * own info colour - the colour of the squiggle they explain - while the
   * quiet annotations keep CodeLens grey: a version or a size is
   * information, not a problem. */
  const styles = {
    error: decoration("editorError.foreground"),
    warning: decoration("editorWarning.foreground"),
    info: decoration("editorInfo.foreground"),
    meta: decoration("editorCodeLens.foreground"),
  };

  const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);

  /** The finding messages, from the published diagnostics - the same text the
   *  Problems panel shows, so the two cannot disagree. */
  const findingLines = (
    doc: vscode.TextDocument,
    mode: Mode
  ): Map<vscode.DiagnosticSeverity, vscode.DecorationOptions[]> => {
    const out = new Map<vscode.DiagnosticSeverity, vscode.DecorationOptions[]>();
    if (mode === "off") {
      return out;
    }
    for (const diagnostic of vscode.languages.getDiagnostics(doc.uri)) {
      if (diagnostic.source !== DIAG_SOURCE) {
        continue;
      }
      if (
        mode === "problems" &&
        diagnostic.severity !== vscode.DiagnosticSeverity.Error &&
        diagnostic.severity !== vscode.DiagnosticSeverity.Warning
      ) {
        continue;
      }
      // Diagnostics are published as they were computed, and a document that
      // has shrunk since (deleting the last lines) still carries them - so the
      // line may be past its end, where lineAt throws and the whole paint dies
      // with the previous decorations left standing.
      const line = Math.min(diagnostic.range.start.line, doc.lineCount - 1);
      const list = out.get(diagnostic.severity) ?? [];
      list.push({
        range: doc.lineAt(line).range,
        renderOptions: { after: { contentText: trim(diagnostic.message) } },
      });
      out.set(diagnostic.severity, list);
    }
    return out;
  };

  /** The deprecation, `@since` and roundtrip-cost annotations of one
   *  document. The reconstruction comes out of the language features'
   *  version-keyed memo, so a paint after a completion (or of a second
   *  editor on the same document) does not parse the class again. */
  const metadataLines = (doc: vscode.TextDocument): Annotation[] => {
    const text = doc.getText();
    if (!usesBuilder(text)) {
      return [];
    }
    const data = snapshot();
    const floor = config().get<string>("viewCheck.minUi5", "1.71");
    const out: Annotation[] = [];
    const prep = preparedAbapOf(doc);
    if (!prep) {
      return []; // an unparsable buffer mid-edit is not worth reporting
    }
    const showDeprecated = config().get<boolean>("inlineDeprecated", true);
    const showSince = config().get<boolean>("inlineSince", true);
    if (data && (showDeprecated || showSince)) {
      const ns = abapNsMap(text);
      // deprecations first - where a line carries both, the deprecation is
      // the one worth the line's single annotation
      if (showDeprecated) {
        out.push(
          ...deprecationAnnotations(prep.nodes, ns, {
            control: (control) =>
              deprecationText(controlInfo(data, control)?.deprecated),
            member: (control, member) =>
              deprecationText(memberInfo(data, control, member)?.deprecated),
          })
        );
      }
      if (showSince) {
        out.push(
          ...sinceAnnotations(prep.nodes, ns, floor, {
            control: (control) => controlInfo(data, control)?.since,
            member: (control, member) => memberInfo(data, control, member)?.since,
          })
        );
      }
    }
    if (config().get<boolean>("inlineRoundtripCost", true)) {
      const mock = mockModel(doc);
      out.push(...costAnnotations(text, mock ?? prep.model, mock !== undefined));
    }
    return out;
  };

  const paint = (editor: vscode.TextEditor | undefined) => {
    if (!editor) {
      return;
    }
    const doc = editor.document;
    const clear = () => {
      for (const style of Object.values(styles)) {
        editor.setDecorations(style, []);
      }
    };
    if (doc.languageId !== "abap" && !VIEW_XML_RE.test(doc.fileName)) {
      clear();
      return;
    }
    const mode = config().get<Mode>("inlineFindings", "problems");
    const findings = findingLines(doc, mode);
    editor.setDecorations(
      styles.error,
      findings.get(vscode.DiagnosticSeverity.Error) ?? []
    );
    editor.setDecorations(styles.info, [
      ...(findings.get(vscode.DiagnosticSeverity.Information) ?? []),
      ...(findings.get(vscode.DiagnosticSeverity.Hint) ?? []),
    ]);

    /* A line that already carries a finding gets no version or size next to
     * it: the defect is what matters there, and two annotations on one line
     * are a wall of grey text rather than an answer. */
    const taken = new Set<number>();
    for (const list of findings.values()) {
      for (const entry of list) {
        taken.add(entry.range.start.line);
      }
    }
    // Remembered so that findings DISAPPEARING still repaints: by then the
    // document no longer carries any of ours, which is indistinguishable from
    // an event that never concerned us.
    if (taken.size) {
      painted.add(doc.uri.toString());
    } else {
      painted.delete(doc.uri.toString());
    }
    const meta: vscode.DecorationOptions[] = [];
    const warn: vscode.DecorationOptions[] = [];
    for (const annotation of metadataLines(doc)) {
      const line = doc.positionAt(annotation.offset).line;
      if (taken.has(line)) {
        continue;
      }
      taken.add(line);
      (annotation.warn ? warn : meta).push({
        range: doc.lineAt(line).range,
        hoverMessage: annotation.tooltip,
        renderOptions: { after: { contentText: trim(annotation.text) } },
      });
    }
    editor.setDecorations(styles.warning, [
      ...(findings.get(vscode.DiagnosticSeverity.Warning) ?? []),
      ...warn,
    ]);
    editor.setDecorations(styles.meta, meta);
  };

  /** Documents whose visible annotations came from our findings. */
  const painted = new Set<string>();

  const paintAll = () => vscode.window.visibleTextEditors.forEach(paint);

  /*
   * Painting is not free: the `@since` and cost halves reconstruct the class
   * (`prepareAbap` over the whole source) and read the mock file next to it.
   * Doing that on the keystroke itself meant three full parses of the same
   * buffer per character - this one, the view check's and the XML preview's,
   * of which only this one was undebounced.
   */
  const PAINT_DEBOUNCE_MS = 300;
  let pending: NodeJS.Timeout | undefined;
  const paintAllSoon = () => {
    if (pending) {
      clearTimeout(pending);
    }
    pending = setTimeout(() => {
      pending = undefined;
      paintAll();
    }, PAINT_DEBOUNCE_MS);
  };

  context.subscriptions.push(
    ...Object.values(styles),
    new vscode.Disposable(() => pending && clearTimeout(pending)),
    vscode.window.onDidChangeActiveTextEditor(paint),
    vscode.window.onDidChangeVisibleTextEditors(paintAll),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (
        vscode.window.visibleTextEditors.some(
          (editor) => editor.document === e.document
        )
      ) {
        paintAllSoon();
      }
    }),
    // The findings half follows the check, exactly like the status bar does.
    // Every extension in the window fires this, so a repaint of everything
    // visible only happens when one of OUR findings moved.
    vscode.languages.onDidChangeDiagnostics((e) => {
      const ours = e.uris.some(
        (uri) =>
          painted.has(uri.toString()) ||
          vscode.languages
            .getDiagnostics(uri)
            .some((d) => d.source === DIAG_SOURCE)
      );
      if (ours) {
        paintAllSoon();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("abap2ui5.inlineFindings") ||
        e.affectsConfiguration("abap2ui5.inlineSince") ||
        e.affectsConfiguration("abap2ui5.inlineDeprecated") ||
        e.affectsConfiguration("abap2ui5.inlineRoundtripCost") ||
        e.affectsConfiguration("abap2ui5.viewCheck.minUi5")
      ) {
        paintAll();
      }
    })
  );
  paintAll();
  log("inline annotations: findings, @since and roundtrip cost registered");
}

/** Parsed mock files by path, keyed on mtime and size - the paint runs every
 *  300 ms while typing, and re-reading and re-parsing an unchanged JSON each
 *  time was the one cost in the pass that a stat can replace. Bounded by the
 *  mock files the window touches; a broken file stays uncached and is the
 *  preview's to report. */
const mockCache = new Map<
  string,
  { mtimeMs: number; size: number; model: Record<string, unknown> }
>();

/** The preview data next to a class, when there is some - the same file the
 *  systemless preview renders with, so both say the same thing about size. */
function mockModel(doc: vscode.TextDocument): Record<string, unknown> | undefined {
  // one convention, resolved in one place - the preview and this annotation
  // disagreeing about which data they describe is exactly the confusion the
  // caption on the picture exists to prevent
  const candidate = mockFileFor(doc);
  if (!candidate) {
    return undefined;
  }
  try {
    const stat = fs.statSync(candidate);
    const cached = mockCache.get(candidate);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.model;
    }
    const model = JSON.parse(
      fs.readFileSync(candidate, "utf8")
    ) as Record<string, unknown>;
    mockCache.set(candidate, { mtimeMs: stat.mtimeMs, size: stat.size, model });
    return model;
  } catch {
    mockCache.delete(candidate);
    return undefined; // a broken mock file is the preview's to report
  }
}

function trim(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > MAX_TEXT ? `${single.slice(0, MAX_TEXT - 1)}…` : single;
}
