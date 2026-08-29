/*
 * examples - finding a control in the abap2UI5 sample catalogues.
 *
 * The question this answers is the one every UI5 API reference leaves open:
 * not "what properties does sap.m.Table have" (the metadata snapshot answers
 * that, in completion and hover) but "what does a working one look like in an
 * abap2UI5 class". There are three repositories full of the answer - samples,
 * samples-controls (416 ports of the official demo kit), samples-stack - and
 * until now the only thing in this window that could read them was the MCP
 * server, on behalf of an agent.
 *
 * `vscode`-free: the walking and the search are plain string work, so both are
 * testable without an editor. The command in `exampleview.ts` adds the
 * QuickPick and the file opening.
 */

import { blankComments } from "./abapscan";

/** One builder call naming the searched control, with its chain around it. */
export interface ExampleHit {
  /** Absolute path of the class the hit is in. */
  file: string;
  /** Catalogue the file came from, e.g. `samples-controls`. */
  catalogue: string;
  /** 1-based line of the `ele( )` / `tag( )` call. */
  line: number;
  /** The call's own line, trimmed - what the pick shows. */
  text: string;
  /** Attributes written on the control, as a rough measure of how much this
   *  example demonstrates. */
  attributes: number;
}

/**
 * Every way the corpus writes `ele( )` / `tag( )` for one control, in any of
 * the quote forms the builder accepts and with an optional namespace prefix:
 *
 *     tag( n = `Button` )     named
 *     tag( `Button` )         positional
 *
 * Reading only the named form is the mistake `context.ts` documents at length
 * and had already fixed for completion, hover and the outline - and this
 * module never got. The positional form is not an exotic spelling: it is what
 * this extension's own XML converter emits (a lone `n =` trips abaplint's
 * omit_parameter_name) and it outnumbers the named one in the sample
 * catalogues, so "Show Examples for This Control" quietly reported a fraction
 * of the hits - none at all for the common sap.m controls - and then ranked
 * that fraction by attribute count as if it were the corpus.
 */
function callRe(control: string): RegExp {
  const local = control.includes(".") ? control.slice(control.lastIndexOf(".") + 1) : control;
  const name = local.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = String.raw`[\`'|]\s*(?:\w+:)?${name}\s*[\`'|]`;
  return new RegExp(
    String.raw`\b(?:ele|tag)\s*\(\s*(?:n\s*=\s*)?${quoted}`,
    "gi"
  );
}

/**
 * Every place a source builds the given control.
 *
 * Counting the attributes that follow is what makes the result useful rather
 * than merely correct: a catalogue has hundreds of `Button`s, and the one
 * worth reading first is the one that actually configures something. The
 * count stops at the next structural call, so it is this control's attributes
 * and not the rest of the chain's.
 */
export function findControlUses(
  source: string,
  control: string,
  where: { file: string; catalogue: string }
): ExampleHit[] {
  const hits: ExampleHit[] = [];
  // Comments blanked, literals kept: the control name lives INSIDE a literal,
  // so `blankNonCode` would take away the very text this matches on - but a
  // commented-out chain must not be offered as a working example, nor may its
  // dead `a( )` calls inflate the ranking.
  const code = blankComments(source);
  const re = callRe(control);
  let line = 1;
  let counted = 0;
  for (const match of code.matchAll(re)) {
    const at = match.index ?? 0;
    for (let i = counted; i < at; i++) {
      if (code.charCodeAt(i) === 10) {
        line++;
      }
    }
    counted = at;
    const lineStart = source.lastIndexOf("\n", at) + 1;
    const lineEnd = source.indexOf("\n", at);
    hits.push({
      file: where.file,
      catalogue: where.catalogue,
      line,
      text: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd).trim(),
      attributes: attributesAfter(code, at + match[0].length),
    });
  }
  return hits;
}

/** How many `a( )` calls follow before the chain moves on to another element
 *  - the attributes of this control. */
function attributesAfter(source: string, from: number): number {
  const rest = source.slice(from, from + 4000);
  let count = 0;
  for (const call of rest.matchAll(/\)->\s*(\w+)\s*\(/g)) {
    if (call[1].toLowerCase() === "a") {
      count++;
      continue;
    }
    break; // ele/tag/end/shut - this control's attributes are over
  }
  return count;
}

/**
 * Order the hits the way someone reading them wants them: the richest example
 * of the control first, and never twenty from the same file before one from
 * anywhere else - a catalogue where one app happens to use `Text` forty times
 * would otherwise be the entire answer.
 */
export function rankExamples(hits: readonly ExampleHit[], perFile = 2): ExampleHit[] {
  const sorted = [...hits].sort(
    (a, b) => b.attributes - a.attributes || a.file.localeCompare(b.file) || a.line - b.line
  );
  const seen = new Map<string, number>();
  const out: ExampleHit[] = [];
  for (const hit of sorted) {
    const taken = seen.get(hit.file) ?? 0;
    if (taken >= perFile) {
      continue;
    }
    seen.set(hit.file, taken + 1);
    out.push(hit);
  }
  return out;
}
