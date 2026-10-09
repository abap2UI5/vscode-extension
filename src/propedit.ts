/*
 * The edits behind the property editor: set, add and remove one attribute of
 * a builder control call - as plain text spans, so the panel's form writes
 * real `a( )` calls instead of owning a parallel representation.
 *
 * `vscode`-free: `controlCallAt( )`'s result and the source in, one span
 * edit out - covered by the test suite.
 */

import { blankComments, lineStartAt } from "./abapscan";
import { ChainAttribute, ControlCall } from "./context";

export interface SpanEdit {
  start: number;
  end: number;
  text: string;
}

/** ABAP's hard line limit - a longer line fails abapGit import/activation.
 *  An edit that would cross it is refused rather than written: splitting the
 *  value into `&&`-joined literals would turn the attribute into an
 *  expression the form can no longer edit. */
const MAX_LINE = 255;

/** Doubles the quote character inside an ABAP literal. */
function escapeLiteral(value: string, quote: string): string {
  return value.split(quote).join(quote + quote);
}

function findAttr(
  call: ControlCall,
  name: string
): ChainAttribute | undefined {
  return call.attrs.find(
    (attr) => attr.name.toLowerCase() === name.toLowerCase()
  );
}

/**
 * The edit that gives `name` the value `value`: an in-place rewrite of the
 * literal when the attribute is already written, an appended `)->a( … )`
 * line when it is not. Undefined when the value cannot be written safely -
 * an expression-valued attribute, or a chain style appending would break.
 */
export function setAttributeEdit(
  source: string,
  call: ControlCall,
  name: string,
  value: string
): SpanEdit | undefined {
  const existing = findAttr(call, name);
  if (existing) {
    if (
      !existing.literal ||
      existing.valueStart === undefined ||
      existing.valueEnd === undefined
    ) {
      return undefined; // a `client->_bind( … )` is not the form's to rewrite
    }
    const quote = source[existing.valueStart - 1] ?? "`";
    const escaped = escapeLiteral(value, quote);
    const lineStart = source.lastIndexOf("\n", existing.valueStart) + 1;
    const lineEnd = source.indexOf("\n", existing.valueEnd);
    const lineLength =
      existing.valueStart -
      lineStart +
      escaped.length +
      (lineEnd < 0 ? source.length : lineEnd) -
      existing.valueEnd;
    if (lineLength > MAX_LINE) {
      return undefined;
    }
    return {
      start: existing.valueStart,
      end: existing.valueEnd,
      text: escaped,
    };
  }
  if (call.appendAt < 0) {
    return undefined;
  }
  const text = `\n${call.appendIndent})->a( n = \`${escapeLiteral(
    name,
    "`"
  )}\` v = \`${escapeLiteral(value, "`")}\``;
  if (text.length - 1 > MAX_LINE) {
    return undefined;
  }
  return { start: call.appendAt, end: call.appendAt, text };
}

/**
 * The edit that removes an attribute: its whole chain line (or lines, for a
 * multi-line value) when the a-call opens its line - the leading `)` of its
 * line closes the previous call, and the closing `)` on the following line
 * takes over that job, so dropping the full lines keeps the chain balanced.
 * A later a-call on a line shared with another call is cut out between the
 * `)` in front of it and its own `)`. Undefined when the layout is anything
 * else.
 */
export function removeAttributeEdit(
  source: string,
  call: ControlCall,
  name: string
): SpanEdit | undefined {
  const attr = findAttr(call, name);
  if (!attr || attr.aClose === undefined) {
    return undefined;
  }
  const lineStart = source.lastIndexOf("\n", attr.aOpen) + 1;
  const lineEnd = source.indexOf("\n", lineStart);
  const line = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
  const opener = /^\s*\)->\s*a\s*\(/.exec(line);
  if (!opener) {
    return undefined; // a line that does not start with an a-call - keep hands off
  }
  const closeLineStart = source.lastIndexOf("\n", attr.aClose) + 1;
  if (lineStart + opener[0].length - 1 !== attr.aOpen) {
    /*
     * The line opens with an a-call, but not with THIS one:
     * `)->a( n = \`text\` … )->a( n = \`type\` … `. The guard used to check
     * only that the line started with an a-call, so removing `type` cut the
     * whole line and took `text` with it. What can go is the `)->a( … )`
     * of this call alone: from the `)` closing the call in front of it, so
     * that the `)` opening the next line (or this call's own, when it closes
     * on the same line) takes over closing that one.
     */
    const chained = /\)\s*->\s*a\s*\($/.exec(source.slice(lineStart, attr.aOpen + 1));
    if (!chained) {
      return undefined;
    }
    const previousClose = lineStart + chained.index;
    if (closeLineStart > lineStart) {
      if (source.slice(closeLineStart, attr.aClose).trim()) {
        return undefined; // its `)` does not open the next line either
      }
      // the blank in front of the `)` goes too, or the line ends in one
      let start = previousClose;
      while (start > lineStart && /[ \t]/.test(source[start - 1])) {
        start--;
      }
      return { start, end: closeLineStart - 1, text: "" };
    }
    return { start: previousClose + 1, end: attr.aClose + 1, text: "" };
  }
  if (closeLineStart > lineStart && !source.slice(closeLineStart, attr.aClose).trim()) {
    // the usual chain shape: the call's own `)` opens the next line, so the
    // whole line (or lines, for a multi-line value) can go - but not a blank
    // line between it and that `)`: that one separates two parts of the
    // chain (the namespaces from the first control, say), and removing the
    // attribute above it is no reason to close the gap
    let end = closeLineStart;
    for (;;) {
      // the line before the one starting at `end` (whose `\n` is end - 1)
      const prevStart = lineStartAt(source, end - 1);
      if (prevStart <= lineStart || source.slice(prevStart, end).trim()) {
        break;
      }
      end = prevStart;
    }
    return { start: lineStart, end, text: "" };
  }
  /*
   * The call closes on its own line - which is what the LAST attribute of
   * every chain statement looks like (`)->a( n = \`x\` v = \`y\` ).`), so
   * refusing here refused the final attribute of every chain rather than an
   * exotic layout. The leading `)` still has to close the previous call and
   * whatever follows (`->end( ).`, the period) still has to run, so only the
   * `->a( … )` between them is cut out.
   *
   * The same holds when its arguments wrap and the `)` ends the wrapped line
   * (`v = \`…\` ).`) instead of opening one: dropping the lines in front of
   * it took the first line alone and left the `v = …` dangling in the chain.
   */
  const afterParen = lineStart + opener[0].indexOf(")") + 1;
  const joined = joinOntoPreviousLine(source, lineStart, attr.aClose + 1);
  return joined ?? { start: afterParen, end: attr.aClose + 1, text: "" };
}

/**
 * The removal of a call that closes its own line, written so the `)` that is
 * left over does not stand alone: `)->a( n = \`x\` v = \`y\` ).` cut down to
 * its `)` left a line holding nothing but `).`, where the house layout (and
 * every hand-written chain) closes on the line of the last call:
 * `)->tag( \`Input\` ).`. So when nothing but the statement's end follows the
 * cut - the period, or a comma of a chained statement - the `)` moves up to
 * the end of the previous line.
 *
 * Not when that line ends in a comment (the `)` would be commented out) or is
 * blank or a whole-line comment; the caller then keeps the plain cut.
 */
function joinOntoPreviousLine(
  source: string,
  lineStart: number,
  cutEnd: number
): SpanEdit | undefined {
  const lineEnd = source.indexOf("\n", cutEnd);
  const rest = source.slice(cutEnd, lineEnd < 0 ? source.length : lineEnd);
  if (!/^\s*[.,]?\s*$/.test(rest) || lineStart === 0) {
    return undefined;
  }
  const prevStart = lineStartAt(source, lineStart - 1);
  const prevRaw = source.slice(prevStart, lineStart - 1).replace(/\r$/, "");
  const content = prevRaw.replace(/[ \t]+$/, "");
  if (!content.trim() || content.startsWith("*")) {
    return undefined;
  }
  // a `"` comment at the end of that line: what blanking comments removes
  const blanked = blankComments(source.slice(prevStart, lineStart - 1)).replace(/\r$/, "");
  if (blanked.replace(/[ \t]+$/, "").length !== content.length) {
    return undefined;
  }
  return { start: prevStart + content.length, end: cutEnd, text: " )" };
}
