/*
 * Indentation for z2ui5_cl_ui5_view_builder chains.
 *
 * The chain IS the view hierarchy, so its indentation is not taste but
 * structure: a child sits one step (4 spaces) deeper than the element that
 * contains it, an attribute one step deeper than its element, an end( ) back
 * on the level it closes. The reconstruction knows that nesting exactly;
 * this module turns it into per-line indents so Format Document repairs a
 * chain instead of a human counting parentheses.
 *
 * Deliberately conservative: only lines that BEGIN a builder verb
 * (`)->ele/tag/a/end`) inside a chain statement are touched. Continuation
 * lines of a multi-line value, comments, and everything outside a chain keep
 * their bytes - a formatter that touches code it does not understand is how
 * formatters lose trust. The canonical shape is the samples-controls corpus style,
 * which a formatted file round-trips unchanged.
 *
 * `vscode`-free: pure text -> edits, tested headless.
 */

import { blankNonCode } from "./abapscan";

export interface IndentEdit {
  /** 0-based line number. */
  line: number;
  /** The leading whitespace the line should have. */
  indent: string;
}

const STEP = 4;

/** All builder verbs on one line, in order - `view->ele(` at the chain
 *  start counts like a `)->ele(`. */
function verbsOn(line: string): string[] {
  return [...line.matchAll(/(?:\)|\b\w+)->\s*(ele|tag|a|end)\s*\(/g)].map((m) => m[1]);
}

/** Paren balance of a line that has already been blanked, so a parenthesis
 *  inside a literal, a template or a comment never counts. */
function parenDelta(line: string): number {
  let depth = 0;
  for (const c of line) {
    if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return depth;
}

/**
 * The indent corrections for every builder-verb line of every chain in
 * `text`. Lines already indented canonically produce no edit.
 */
export function chainIndentEdits(text: string): IndentEdit[] {
  const lines = text.split("\n");
  /*
   * Every decision below is made on the BLANKED source (see `abapscan.ts`):
   * same offsets and same leading whitespace, with literals, templates and
   * comments emptied out. A commented-out `)->end( ).` used to be counted as
   * a real one, so the chain left a level it had never entered and every line
   * after it was "corrected" to the wrong indent; an unbalanced `(` inside a
   * `'...'` literal or a trailing `" note (` kept the statement open forever,
   * and lines far below were then formatted against a chain that had ended.
   */
  const codeLines = blankNonCode(text).split("\n");
  const edits: IndentEdit[] = [];

  let inChain = false;
  let base = "";
  let depth = 0; // element nesting inside the current chain
  let lastTag = false;
  let parens = 0; // raw paren balance of the chain statement

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = codeLines[lineNo] ?? "";
    if (!inChain) {
      // a chain statement starts where a handle opens the root element
      const start = /^(\s*)(?:DATA\(\w+\)\s*=\s*)?\w+->ele\(/.exec(line);
      if (!start) {
        continue;
      }
      inChain = true;
      base = start[1];
      depth = 0;
      lastTag = false;
      parens = 0;
      // fall through - the first line carries the first ele( )
    }

    const trimmed = line.trimStart();
    const startsWithVerb = /^\)->\s*(ele|tag|a|end)\b/.exec(trimmed);
    const verbs = verbsOn(line);

    if (startsWithVerb && verbs.length) {
      // the indent is decided by the FIRST verb on the line
      const verb = verbs[0];
      let level: number;
      if (verb === "ele" || verb === "tag") {
        level = depth;
      } else if (verb === "a") {
        level = depth + (lastTag ? 1 : 0);
      } else {
        level = Math.max(0, depth - 1); // end closes the level it sits on
      }
      const want = base + " ".repeat(STEP * level);
      const have = line.slice(0, line.length - trimmed.length);
      if (have !== want) {
        edits.push({ line: lineNo, indent: want });
      }
    }

    // bookkeeping AFTER deciding the line's own indent
    for (const verb of verbs) {
      if (verb === "ele") {
        depth++;
        lastTag = false;
      } else if (verb === "tag") {
        lastTag = true;
      } else if (verb === "end") {
        depth = Math.max(0, depth - 1);
        lastTag = false;
      }
    }

    parens += parenDelta(line);
    // the statement ends when the parens balance and the line closes with `.`
    if (parens <= 0 && /\.\s*$/.test(line)) {
      inChain = false;
    }
  }
  return edits;
}
