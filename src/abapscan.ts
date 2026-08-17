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
      const start = i + 1;
      let j = start;
      // a literal does not survive a line break - an unclosed one ends there,
      // rather than running on and eating the rest of the file
      while (j < source.length && source[j] !== "\n") {
        if (source[j] === c) {
          if (source[j + 1] === c) {
            j += 2; // doubled quote: an escaped one, the literal goes on
            continue;
          }
          break;
        }
        j++;
      }
      const closed = source[j] === c;
      spans.push({
        kind: "literal",
        from: i,
        to: closed ? j + 1 : j,
        start,
        end: j,
        quote: c,
      });
      i = closed ? j + 1 : j;
      continue;
    }
    if (c === "|") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "|") {
          break;
        }
        j++;
      }
      const closed = source[j] === "|";
      spans.push({
        kind: "template",
        from: i,
        to: closed ? j + 1 : j,
        start: i + 1,
        end: j,
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
  const out = source.split("");
  for (const span of abapSpans(source)) {
    for (let i = span.from; i < span.to; i++) {
      if (out[i] !== "\n") {
        out[i] = " "; // a template may span lines, and those have to stay
      }
    }
  }
  return out.join("");
}

/** Whether an offset sits inside a literal's content. */
export function insideLiteral(source: string, at: number): boolean {
  return abapSpans(source).some(
    (s) => s.kind === "literal" && at > s.from && at <= s.end
  );
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
 */
export function declaredNames(
  statement: string
): Array<{ name: string; at: number }> {
  const code = blankNonCode(statement);
  const keyword = /^\s*(CLASS-DATA|DATA|CONSTANTS|TYPES)\b\s*(:)?/i.exec(code);
  if (!keyword) {
    return [];
  }
  const out: Array<{ name: string; at: number }> = [];
  const chained = keyword[2] === ":";
  let at = keyword[0].length;
  for (const part of (chained ? code.slice(at).split(",") : [code.slice(at)])) {
    const declared = /^\s*([A-Za-z_]\w*)/.exec(part);
    if (declared) {
      out.push({
        name: declared[1],
        at: at + declared[0].length - declared[1].length,
      });
    }
    at += part.length + 1; // the comma the split ate
  }
  return out;
}
