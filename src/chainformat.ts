/*
 * Format Document for z2ui5_cl_ui5_view_builder chains.
 *
 * The chain IS the view hierarchy, so its layout is not taste but structure:
 * a child sits one step deeper than the element that contains it, an
 * attribute one step deeper than its element, an `end( )` back on the level
 * it closes.
 *
 * This module used to work that out for itself, and that was the mistake.
 * The layout is a RULE - the linter's `chain-house-layout` - and the linter
 * carries fixes for it. Deriving the same thing here produced a second,
 * stricter opinion: measured over the 637 builder classes of
 * samples-controls, eight files the rule considers correct would have been
 * re-indented by this module, and not one file the rule flags was missed. So
 * Format Document churned linter-clean code and disagreed with CI about what
 * the house style is - the editor/CI divergence AGENTS.md says must not be
 * re-created here, in the one place it had been.
 *
 * Now the linter decides and this module only hands its fixes on. Two
 * properties of those fixes are what make that safe to apply on a keystroke:
 * they touch whitespace BETWEEN chain segments (and the indent of a
 * continuation line) only, and the rule verifies that collapsing every run of
 * code-whitespace leaves the source identical - a layout fix can never change
 * what the view builds.
 *
 * `chain-house-layout` is opt-in in the linter, because it encodes one house
 * style. It is switched on explicitly for this call: a repository that has
 * not enabled it in CI still gets Format Document, and one that has gets
 * exactly what `--fix` would write.
 *
 * `vscode`-free: pure text -> edits, tested headless.
 */

import { checkAbapRules } from "@abap2ui5/linter/abap-rules";

/** A whitespace rewrite, as character offsets into the formatted text. */
export interface ChainEdit {
  start: number;
  end: number;
  text: string;
}

/** Switches the opt-in layout rule on for this one call, whatever the
 *  repository's own config says. */
const LAYOUT_RULES = { "chain-house-layout": {} };

/**
 * The line ending the source uses, so the fixes can be written in it.
 *
 * The linter's `chain-house-layout` fixes are whitespace runs that always use
 * `\n` for the newline between chain segments, whatever the source's line
 * ending is. Applied verbatim to a CRLF document that turned every re-indented
 * chain line into a lone `\n` - mixed line endings in a file the rest of which
 * is CRLF, which abapGit and git then flag on the round-trip - and, worse, on
 * an ALREADY-canonical CRLF file the fix's `\n…` never equals the source's
 * `\r\n…`, so Format Document reported edits for a correctly formatted file and
 * stripped the `\r` off its chain lines. Matching the source's ending closes
 * both: the fix then equals the slice on a canonical file (no edit) and keeps
 * the file's own ending on a scrambled one.
 */
function eolOf(text: string): "\r\n" | "\n" {
  // CRLF only when the source is consistently CRLF - a lone `\n` (a mixed or
  // LF file) stays `\n`, the safer default that fabricates no `\r`.
  return /\r\n/.test(text) && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n";
}

/**
 * The layout corrections for every builder chain in `text`, in order and
 * without overlaps. A chain already written canonically produces none.
 *
 * `eol` is the line ending the fixes are written in, defaulting to the
 * source's own - the editor passes the document's `EndOfLine` so a CRLF file
 * is not silently rewritten to mixed endings (see `eolOf`).
 */
export function chainFormatEdits(
  text: string,
  eol: "\r\n" | "\n" = eolOf(text)
): ChainEdit[] {
  const edits: ChainEdit[] = [];
  for (const finding of checkAbapRules(text, { rules: LAYOUT_RULES })) {
    if (finding.type !== "chain-house-layout") {
      continue;
    }
    for (const fix of (finding as { fixes?: ChainEdit[] }).fixes ?? []) {
      // The rule emits `\n` for the newline in a whitespace run; rewrite it to
      // the document's ending BEFORE the equality check, so a canonical CRLF
      // file compares equal and produces no edit.
      const fixText =
        typeof fix?.text === "string" && eol === "\r\n"
          ? fix.text.replace(/\r\n|\n/g, "\r\n")
          : fix?.text;
      /* Behind a comment line the rule's whitespace run starts at the `\n`,
       * after the comment's `\r` (the comment runs to the `\n`). A fix
       * starting with the `\r\n` written over that slice would leave the
       * comment's `\r` in front of it - `\r\r\n` - so the edit starts at the
       * `\r` instead. The editor clamped the offset back to the line end and
       * hid it; `applyChainEdits` did not. */
      let start = fix?.start;
      if (
        typeof start === "number" &&
        typeof fixText === "string" &&
        fixText.startsWith("\r\n") &&
        text[start] === "\n" &&
        text[start - 1] === "\r"
      ) {
        start--;
      }
      if (
        typeof start === "number" &&
        typeof fix?.end === "number" &&
        typeof fixText === "string" &&
        start <= fix.end &&
        fix.end <= text.length &&
        text.slice(start, fix.end) !== fixText
      ) {
        edits.push({ start, end: fix.end, text: fixText });
      }
    }
  }
  edits.sort((a, b) => a.start - b.start || a.end - b.end);

  /* Overlaps would be applied by the editor in an undefined order. The rule
   * does not emit any today; dropping the later one keeps that a fact rather
   * than an assumption. */
  const kept: ChainEdit[] = [];
  for (const edit of edits) {
    if (kept.length === 0 || edit.start >= kept[kept.length - 1].end) {
      kept.push(edit);
    }
  }
  return kept;
}

/** The text with the edits applied - what the editor ends up with, and what
 *  the tests assert against. */
export function applyChainEdits(text: string, edits: readonly ChainEdit[]): string {
  let out = "";
  let at = 0;
  for (const edit of edits) {
    out += text.slice(at, edit.start) + edit.text;
    at = edit.end;
  }
  return out + text.slice(at);
}
