/*
 * The ABAP call scan under the position analysis: which call the cursor is
 * in, which literal, and how a call's arguments are read (named, positional,
 * doubled quotes, commented-out lines).
 *
 * Split out of `context.ts` - the layer `contextchain.ts` (builder chains)
 * and `contextevents.ts` (events and bindings) both read. Nothing here is
 * part of the module's public face: `context.ts` re-exports none of it.
 * `vscode`-free.
 */

import { abapSpans, blankComments } from "./abapscan";

// ---------------------------------------------------------------------------
// ABAP: a one-pass scan that knows about literals, comments and call nesting
// ---------------------------------------------------------------------------

export interface Call {
  name: string;
  /** Offset of the `(`. */
  open: number;
  /** Offset of the matching `)`, or undefined while still open. */
  close?: number;
}

export interface Literal {
  /** Content span, i.e. between the quotes. */
  start: number;
  end: number;
}

export interface AbapScan {
  /** Call stack at the cursor, innermost last. */
  stack: Call[];
  /** Every call that started before the cursor, in source order. */
  calls: Call[];
  /** The literal the cursor sits in, if any. */
  literal?: Literal;
}

/**
 * Walks the source once, over the literal/comment/template spans `abapscan.ts`
 * found and the parenthesis nesting on top of them. Everything the context
 * analysis needs comes out of this: a `tag(` inside a comment or a string
 * never becomes a control, which is exactly the confusion a plain backwards
 * regex search would produce.
 */
/*
 * One completion asks twice: `abapBindingContextAt` first (is a binding being
 * written?) and `abapContextAt` after it, both over the whole document and
 * both from scratch. Space is a trigger character, so that ran on essentially
 * every space typed in any ABAP file. The two calls are always the same text
 * at the same offset, so remembering the last answer is enough to halve it -
 * and the comparison hits the identical string, which is a pointer compare.
 *
 * The scan's Call objects are read, never written, by the callers - so handing
 * the same ones out twice is safe.
 *
 * What this memo covers since `abapscan.ts` grew one of its own is the
 * PARENTHESIS walk, not the lex: the spans come back shared now, but building
 * the call list still means a pass over the whole source, and it is keyed on
 * the offset as well, so a completion at a new cursor position misses it.
 */
const SCAN_MEMO_SLOTS = 4;
const scanMemo: Array<{ source: string; offset: number; scan: AbapScan }> = [];

export function scanAbap(source: string, offset: number): AbapScan {
  for (let i = 0; i < scanMemo.length; i++) {
    const entry = scanMemo[i];
    if (entry.offset === offset && entry.source === source) {
      scanMemo.splice(i, 1);
      scanMemo.unshift(entry);
      return entry.scan;
    }
  }
  const scan = scanAbapUncached(source, offset);
  scanMemo.unshift({ source, offset, scan });
  if (scanMemo.length > SCAN_MEMO_SLOTS) {
    scanMemo.pop();
  }
  return scan;
}

function scanAbapUncached(source: string, offset: number): AbapScan {
  const stack: Call[] = [];
  const calls: Call[] = [];
  let literal: Literal | undefined;
  let stackAtCursor: Call[] | undefined;

  const snapshot = () => {
    if (stackAtCursor === undefined) {
      stackAtCursor = [...stack];
    }
  };

  // The spans come out in order, so one index walks along with the scan.
  const spans = abapSpans(source);
  let nextSpan = 0;

  let i = 0;
  while (i < source.length) {
    if (stackAtCursor === undefined && i > offset) {
      snapshot();
    }

    while (nextSpan < spans.length && spans[nextSpan].to <= i) {
      nextSpan++;
    }
    const span = spans[nextSpan];
    if (span && span.from === i) {
      // The literal the cursor sits in is the one thing the scan keeps -
      // completion offers values inside it. Comments and templates are only
      // skipped: what matters is that their content is not read as code.
      if (
        span.kind === "literal" &&
        offset >= span.start &&
        offset <= span.end
      ) {
        literal = { start: span.start, end: span.end };
        snapshot();
      }
      i = Math.max(span.to, i + 1);
      continue;
    }

    const c = source[i];
    if (c === "(") {
      // The method name is the identifier run right in front of the paren.
      let k = i;
      while (k > 0 && /[A-Za-z0-9_~]/.test(source[k - 1])) {
        k--;
      }
      const call: Call = { name: source.slice(k, i), open: i };
      if (i < offset) {
        calls.push(call);
      }
      stack.push(call);
      i++;
      continue;
    }
    if (c === ")") {
      const call = stack.pop();
      if (call) {
        call.close = i;
      }
      i++;
      continue;
    }
    i++;
  }
  return { stack: stackAtCursor ?? [...stack], calls, literal };
}

/**
 * The argument text of a call - up to its `)`, or to the end when it is the
 * call still being written, with COMMENTS blanked out.
 *
 * Blanked, not stripped: every reader below reports offsets into this slice
 * and they are translated straight back into source offsets, so the length
 * has to be preserved exactly.
 *
 * The blanking is the point. In the line-per-argument style the corpus uses,
 * a commented-out argument sits INSIDE the call's parentheses:
 *
 *     view->tag(
 *        " n = `Button` was wrong
 *        n = `Text`
 *     )->a( … ).
 *
 * and every reader here takes the FIRST match, so the dead line won: the
 * control was read as sap.m.Button, and completion, hover, the property
 * editor and the aggregation resolution all inherited it. `abapscan.ts`
 * already knows where the comments are - this is the same "identifier in a
 * comment" class the lexer was written for, one layer further in.
 */
export function argsOf(source: string, call: Call): string {
  const from = call.open + 1;
  const to = call.close ?? source.length;
  return blankComments(source.slice(from, to));
}

/*
 * A quoted literal, doubled quotes included.
 *
 * ABAP escapes a quote by doubling it, so `` `it``s fine` `` is ONE literal
 * whose value is `it`s fine`. Reading it as `` [^`]* `` stopped at the first
 * half of the pair: the property editor showed "it", and writing a new value
 * replaced only that much - leaving `` `hello``s fine` `` behind in the
 * source. `abapscan.ts` has always handled the doubling; these regexes did
 * not.
 */
// Never across a line break: an ABAP literal ends at the end of its line
// (`abapscan.ts` stops there), and a pattern that read on to the next quote
// turned an unterminated value and the line below it into one "literal".
export const LITERAL_ALTERNATIVES =
  "(?:`((?:[^`\\n]|``)*)`|'((?:[^'\\n]|'')*)'|\"((?:[^\"\\n]|\"\")*)\")";

/** The written form of a literal turned into its value: a doubled quote is
 *  one quote. */
export function unescapeLiteral(raw: string, quote: string): string {
  return raw.split(quote + quote).join(quote);
}

/** The literal value of a named argument, e.g. `n` in `a( n = \`text\` … )`. */
export function argValue(args: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*[\`'"]([^\`'"]*)[\`'"]`, "i").exec(
    args
  );
  return m ? m[1] : undefined;
}

/** Which named argument the cursor's literal belongs to: the last `name =`
 *  in front of it inside the same call. */
export function argNameBefore(source: string, from: number, to: number): string | undefined {
  const before = source.slice(from, to);
  const m = /\b(\w+)\s*=\s*[`'"]?[^`'"=]*$/.exec(before);
  return m ? m[1].toLowerCase() : undefined;
}

/** A lone literal written as the FIRST argument, with no `name =` in front of
 *  it. */
const POSITIONAL_LITERAL = new RegExp("^\\s*" + LITERAL_ALTERNATIVES);

/**
 * The name an `ele( )` / `tag( )` call writes, in either of the two shapes the
 * corpus uses:
 *
 *     tag( n = `Button` )     named
 *     tag( `Button` )         positional
 *
 * The positional one is not an exotic spelling: it is what the extension's own
 * XML converter emits, because a lone `n =` trips abaplint's
 * omit_parameter_name. Reading only the named form is why completion, hover
 * and the outline used to go silent on generated code - the outline even
 * labelled every such element "?".
 */
export function writtenName(args: string): string | undefined {
  return (
    argLiteral(args, "n") ??
    POSITIONAL_LITERAL.exec(args)
      ?.slice(1)
      .find((value) => value !== undefined)
  );
}

/** A named argument's literal value, whichever quote it uses - unlike
 *  {@link argValue} it survives the other quote characters INSIDE the
 *  literal, which a complex binding (`{path: 'X'}` in a backtick literal)
 *  always has. */
export function argLiteral(args: string, name: string): string | undefined {
  const m = new RegExp("\\b" + name + "\\s*=\\s*" + LITERAL_ALTERNATIVES, "i").exec(
    args
  );
  if (!m) {
    return undefined;
  }
  const raw = m[1] ?? m[2] ?? m[3];
  const quote = m[1] !== undefined ? "`" : m[2] !== undefined ? "'" : '"';
  return unescapeLiteral(raw, quote);
}
