/*
 * Indentation for z2ui5_cl_ai_xml builder chains.
 *
 * The chain IS the view hierarchy, so its indentation is not taste but
 * structure: a child sits one step (4 spaces) deeper than the element that
 * contains it, an attribute one step deeper than its element, a shut( ) back
 * on the level it closes. The reconstruction knows that nesting exactly;
 * this module turns it into per-line indents so Format Document repairs a
 * chain instead of a human counting parentheses.
 *
 * Deliberately conservative: only lines that BEGIN a builder verb
 * (`)->open/leaf/a/shut`) inside a chain statement are touched. Continuation
 * lines of a multi-line value, comments, and everything outside a chain keep
 * their bytes - a formatter that touches code it does not understand is how
 * formatters lose trust. The canonical shape is the samples-controls corpus style,
 * which a formatted file round-trips unchanged.
 *
 * `vscode`-free: pure text -> edits, tested headless.
 */

export interface IndentEdit {
  /** 0-based line number. */
  line: number;
  /** The leading whitespace the line should have. */
  indent: string;
}

const STEP = 4;

/** All builder verbs on one line, in order - `view->open(` at the chain
 *  start counts like a `)->open(`. */
function verbsOn(line: string): string[] {
  return [...line.matchAll(/(?:\)|\b\w+)->\s*(open|leaf|a|shut)\s*\(/g)].map((m) => m[1]);
}

/** Paren balance of a line with backtick literals and |…| templates blanked,
 *  so a parenthesis inside a string never counts. */
function parenDelta(line: string): number {
  let depth = 0;
  let str: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str === "`") {
      if (c === "`") str = null;
      continue;
    }
    if (str === "|") {
      if (c === "\\") i++;
      else if (c === "|") str = null;
      continue;
    }
    if (c === "`" || c === "|") {
      str = c;
      continue;
    }
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
  const edits: IndentEdit[] = [];

  let inChain = false;
  let base = "";
  let depth = 0; // element nesting inside the current chain
  let lastLeaf = false;
  let parens = 0; // raw paren balance of the chain statement

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    if (!inChain) {
      // a chain statement starts where a handle opens the root element
      const start = /^(\s*)(?:DATA\(\w+\)\s*=\s*)?\w+->open\(/.exec(line);
      if (!start) {
        continue;
      }
      inChain = true;
      base = start[1];
      depth = 0;
      lastLeaf = false;
      parens = 0;
      // fall through - the first line carries the first open( )
    }

    const trimmed = line.trimStart();
    const startsWithVerb = /^\)->\s*(open|leaf|a|shut)\b/.exec(trimmed);
    const verbs = verbsOn(line);

    if (startsWithVerb && verbs.length) {
      // the indent is decided by the FIRST verb on the line
      const verb = verbs[0];
      let level: number;
      if (verb === "open" || verb === "leaf") {
        level = depth;
      } else if (verb === "a") {
        level = depth + (lastLeaf ? 1 : 0);
      } else {
        level = Math.max(0, depth - 1); // shut closes the level it sits on
      }
      const want = base + " ".repeat(STEP * level);
      const have = line.slice(0, line.length - trimmed.length);
      if (have !== want) {
        edits.push({ line: lineNo, indent: want });
      }
    }

    // bookkeeping AFTER deciding the line's own indent
    for (const verb of verbs) {
      if (verb === "open") {
        depth++;
        lastLeaf = false;
      } else if (verb === "leaf") {
        lastLeaf = true;
      } else if (verb === "shut") {
        depth = Math.max(0, depth - 1);
        lastLeaf = false;
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
