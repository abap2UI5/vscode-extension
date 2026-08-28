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
 * The layout corrections for every builder chain in `text`, in order and
 * without overlaps. A chain already written canonically produces none.
 */
export function chainFormatEdits(text: string): ChainEdit[] {
  const edits: ChainEdit[] = [];
  for (const finding of checkAbapRules(text, { rules: LAYOUT_RULES })) {
    if (finding.type !== "chain-house-layout") {
      continue;
    }
    for (const fix of (finding as { fixes?: ChainEdit[] }).fixes ?? []) {
      if (
        typeof fix?.start === "number" &&
        typeof fix?.end === "number" &&
        typeof fix?.text === "string" &&
        fix.start <= fix.end &&
        fix.end <= text.length &&
        text.slice(fix.start, fix.end) !== fix.text
      ) {
        edits.push({ start: fix.start, end: fix.end, text: fix.text });
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
