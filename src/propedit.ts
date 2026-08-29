/*
 * The edits behind the property editor: set, add and remove one attribute of
 * a builder control call - as plain text spans, so the panel's form writes
 * real `a( )` calls instead of owning a parallel representation.
 *
 * `vscode`-free: `controlCallAt( )`'s result and the source in, one span
 * edit out - covered by the test suite.
 */

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
 * multi-line value). Only offered when the a-call sits on lines of its own -
 * the leading `)` of its line closes the previous call, and the closing `)`
 * on the following line takes over that job, so dropping the full lines
 * keeps the chain balanced. Undefined when the layout is anything else.
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
    return undefined; // shares its line with another call - keep hands off
  }
  const closeLineStart = source.lastIndexOf("\n", attr.aClose) + 1;
  if (closeLineStart > lineStart) {
    // the usual chain shape: the call's own `)` opens the next line, so the
    // whole line (or lines, for a multi-line value) can go
    return { start: lineStart, end: closeLineStart, text: "" };
  }
  /*
   * The call closes on its own line - which is what the LAST attribute of
   * every chain statement looks like (`)->a( n = \`x\` v = \`y\` ).`), so
   * refusing here refused the final attribute of every chain rather than an
   * exotic layout. The leading `)` still has to close the previous call and
   * whatever follows (`->end( ).`, the period) still has to run, so only the
   * `->a( … )` between them is cut out.
   */
  const afterParen = lineStart + opener[0].indexOf(")") + 1;
  return { start: afterParen, end: attr.aClose + 1, text: "" };
}
