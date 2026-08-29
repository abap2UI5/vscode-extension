/*
 * The one place that knows what ABAP source looks like lexically: where its
 * literals, its comments and its string templates are.
 *
 * Every feature that reads ABAP with a regex needs this first, and each one
 * that grew its own version got it wrong in its own way - a `'` inside a
 * `" comment` opened a literal that swallowed the rest of the file (F2 rename
 * then silently found no wires at all), a commented-out `)->end( ).` was
 * counted as a real one (the formatter indented everything after it against a
 * level that had never been left), a period inside a comment ended a statement
 * that was still running. The rules are small but there are enough of them to
 * be worth writing down once:
 *
 * - `*` in column one comments out the whole line
 * - `"` starts a comment that runs to the end of the line - it is NOT a string
 *   delimiter in ABAP
 * - `'...'` and `` `...` `` are literals, a doubled quote escapes one, and
 *   neither survives a line break
 * - `|...|` is a string template, `\` escapes inside it, and it may span lines
 *
 * `context.ts` walks the source with the same rules to find the call the
 * cursor sits in; it takes the spans from here and only adds the parenthesis
 * nesting on top, so there is one lexer and not two that disagree.
 */

/** What a span of source is, when it is not code. */
export type SpanKind = "literal" | "comment" | "template";

export interface AbapSpan {
  kind: SpanKind;
  /** First character of the CONTENT - after the opening delimiter. */
  start: number;
  /** One past the last content character - the closing delimiter, or the end
   *  of the line/source for something left unclosed. */
  end: number;
  /** First character of the whole span, delimiter included. */
  from: number;
  /** One past the last character of the whole span, delimiter included. */
  to: number;
  /** The quote character, for a literal. */
  quote?: "'" | "`";
}

/**
 * One past the closing quote of a literal opened at `open`, or the end of the
 * line for an unclosed one - a literal does not survive a line break.
 */
function scanLiteral(source: string, open: number): number {
  const quote = source[open];
  let j = open + 1;
  while (j < source.length && source[j] !== "\n") {
    if (source[j] === quote) {
      if (source[j + 1] === quote) {
        j += 2; // doubled quote: an escaped one, the literal goes on
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return j;
}

/**
 * One past the `}` closing the embedded expression opened at `open`.
 *
 * What is inside `{ }` is ABAP CODE, not template text: it nests, it may hold
 * literals, and it may hold further templates. Reading it as text is what made
 * `|val { get( 'a|b' ) }|` end at the `|` inside the literal - after which the
 * stray `'` opened a literal that swallowed the rest of the line, taking the
 * next statement with it.
 */
function scanEmbedded(source: string, open: number): number {
  let j = open + 1;
  let depth = 1;
  while (j < source.length && depth > 0) {
    const c = source[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'" || c === "`") {
      j = scanLiteral(source, j);
      continue;
    }
    if (c === "|") {
      const nested = scanTemplate(source, j);
      j = nested.closed ? nested.end + 1 : nested.end;
      continue;
    }
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    }
    j++;
  }
  return j;
}

/**
 * Where the string template opened at `open` ends: the index of its closing
 * `|`, or the end of the source when it is not closed.
 *
 * A template may span lines, `\` escapes the next character (that is how a
 * literal `|`, `{` or `}` is written), and `{ … }` is an embedded expression
 * whose contents are skipped as code rather than read as text.
 */
function scanTemplate(
  source: string,
  open: number
): { end: number; closed: boolean } {
  let j = open + 1;
  while (j < source.length) {
    const c = source[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "|") {
      return { end: j, closed: true };
    }
    if (c === "{") {
      j = scanEmbedded(source, j);
      continue;
    }
    j++;
  }
  return { end: source.length, closed: false };
}

/**
 * Every literal, comment and string template in the source, in order and
 * without overlaps - the first opener wins, which is what makes a quote
 * inside a comment part of the comment rather than the start of a literal.
 */
export function abapSpans(source: string): AbapSpan[] {
  const spans: AbapSpan[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];

    // `*` in column one comments out the whole line.
    if (c === "*" && (i === 0 || source[i - 1] === "\n")) {
      const nl = source.indexOf("\n", i);
      const to = nl < 0 ? source.length : nl;
      spans.push({ kind: "comment", from: i, to, start: i + 1, end: to });
      i = to;
      continue;
    }
    // `"` comments to the end of the line.
    if (c === '"') {
      const nl = source.indexOf("\n", i);
      const to = nl < 0 ? source.length : nl;
      spans.push({ kind: "comment", from: i, to, start: i + 1, end: to });
      i = to;
      continue;
    }
    if (c === "'" || c === "`") {
      // a literal does not survive a line break - an unclosed one ends there,
      // rather than running on and eating the rest of the file
      const after = scanLiteral(source, i);
      const closed = source[after - 1] === c && after > i + 1;
      const end = closed ? after - 1 : after;
      spans.push({
        kind: "literal",
        from: i,
        to: after,
        start: i + 1,
        end,
        quote: c,
      });
      i = after;
      continue;
    }
    if (c === "|") {
      const { end: j, closed } = scanTemplate(source, i);
      spans.push({
        kind: "template",
        from: i,
        to: Math.min(closed ? j + 1 : j, source.length),
        start: i + 1,
        end: Math.min(j, source.length),
      });
      i = closed ? j + 1 : j;
      continue;
    }
    i++;
  }
  return spans;
}

/** Just the literals - what a search for written names (control ids, bound
 *  attribute names) reads. */
export function abapLiterals(source: string): AbapSpan[] {
  return abapSpans(source).filter((s) => s.kind === "literal");
}

/**
 * The source with everything that is not code blanked out: same length, same
 * line breaks, same offsets - only the content of literals, comments and
 * templates replaced by spaces. A regex run over the result finds only real
 * code, and every index it reports still points into the original.
 */
export function blankNonCode(source: string): string {
  return blank(source, () => true);
}

/**
 * The source with only its COMMENTS blanked - literals and templates stay as
 * they are, same length, same offsets.
 *
 * For the readers that have to see literal CONTENT (a marker like
 * `n = \`id\``, an argument's value) and must still not be fooled by a
 * commented-out copy of what they are looking for. `blankNonCode` is too much
 * for them: it takes away the very text they match on.
 */
export function blankComments(source: string): string {
  return blank(source, (span) => span.kind === "comment");
}

function blank(source: string, wanted: (span: AbapSpan) => boolean): string {
  const out = source.split("");
  for (const span of abapSpans(source)) {
    if (!wanted(span)) {
      continue;
    }
    for (let i = span.from; i < span.to; i++) {
      if (out[i] !== "\n") {
        out[i] = " "; // a template may span lines, and those have to stay
      }
    }
  }
  return out.join("");
}

export interface AbapStatement {
  /** The statement as written, delimiting period excluded. */
  text: string;
  /** Offset of the first character in the source it came from. */
  start: number;
}

/**
 * The statements of a source fragment: split at the periods that end one.
 *
 * Which periods those are is the whole difficulty - `VALUE '3.14'` ends
 * nothing, and neither does the one in `" done.`, whereas a chained
 * declaration runs across lines that say nothing about being a declaration.
 * The split runs over the blanked source, so only real code is read, and the
 * text handed back is the original, so what a caller finds in it can be
 * reported at an offset that still means something.
 */
export function abapStatements(source: string): AbapStatement[] {
  const code = blankNonCode(source);
  const out: AbapStatement[] = [];
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    if (code[i] !== ".") {
      continue;
    }
    out.push({ text: source.slice(start, i), start });
    start = i + 1;
  }
  if (source.slice(start).trim()) {
    out.push({ text: source.slice(start), start });
  }
  return out;
}

/**
 * The names a declaration statement introduces, with their offsets inside it.
 * Both shapes count: `DATA a TYPE x.` and the chained `DATA: a TYPE x, b TYPE
 * y.`, where every entry after the first begins on a line that says nothing
 * about being a declaration.
 *
 * Only the declared names - a statement is full of other words (`TYPE`,
 * `string`, `LENGTH`, the type itself), and treating those as declared is what
 * made F2 on the `string` in `DATA mv_x TYPE string.` offer to rewrite every
 * TYPE clause in the class.
 *
 * A `BEGIN OF … END OF` block declares the STRUCTURE, not the words `BEGIN`
 * and `END` - those two used to come back as names, and the roundtrip-cost
 * annotation labelled them as attributes the class ships. The fields inside
 * the block are declared too, but as components of the structure, and the
 * `component` flag says so - an attribute list must not count them twice.
 */
export function declaredNames(
  statement: string
): Array<{ name: string; at: number; component?: boolean }> {
  const code = blankNonCode(statement);
  const keyword = /^\s*(CLASS-DATA|DATA|CONSTANTS|TYPES)\b\s*(:)?/i.exec(code);
  if (!keyword) {
    return [];
  }
  const out: Array<{ name: string; at: number; component?: boolean }> = [];
  const chained = keyword[2] === ":";
  let at = keyword[0].length;
  let depth = 0; // BEGIN OF nesting
  for (const part of (chained ? code.slice(at).split(",") : [code.slice(at)])) {
    const begin = /^\s*BEGIN\s+OF\s+([A-Za-z_]\w*)/i.exec(part);
    const end = /^\s*END\s+OF\b/i.exec(part);
    if (begin) {
      out.push({
        name: begin[1],
        at: at + begin[0].length - begin[1].length,
        ...(depth > 0 ? { component: true } : {}),
      });
      depth++;
    } else if (end) {
      depth = Math.max(0, depth - 1);
    } else {
      const declared = /^\s*([A-Za-z_]\w*)/.exec(part);
      if (declared) {
        out.push({
          name: declared[1],
          at: at + declared[0].length - declared[1].length,
          ...(depth > 0 ? { component: true } : {}),
        });
      }
    }
    at += part.length + 1; // the comma the split ate
  }
  return out;
}
