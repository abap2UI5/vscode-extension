/*
 * handlerstub - where a `WHEN` branch for an unhandled event goes, and what
 * it says.
 *
 * The linter's `event-without-handler` names an event the view raises and
 * no branch of the class handles. The correction is mechanical only once the
 * class has a dispatcher to add to: a `CASE client->get_event( ).` (or its
 * struct-read spelling `CASE client->get( )-event.`) whose branches are the
 * handlers. This module finds that CASE, decides where a new branch slots
 * in - before `WHEN OTHERS.` when there is one, else before `ENDCASE.` -
 * and writes it the way its neighbours are written: same indentation, same
 * quote, same keyword case. Without such a CASE there is nothing to offer:
 * an IF-shaped dispatcher, a `check_on_event( )` ladder or a class handing
 * its events elsewhere would each need a guess about where a handler
 * belongs, and a quick fix that guesses is worse than a hint that stays.
 *
 * `vscode`-free: source in, an insertion out. The reading runs over the
 * lexer's blanked copies so a `" CASE client->get_event( )` in a comment or
 * a commented-out `* WHEN OTHERS.` cannot steer the edit.
 */

import { blankComments, blankNonCode } from "./abapscan";
import { eventRaises } from "./context";

/** One insertion: the text to put at `offset` in the source it was read from. */
export interface HandlerStub {
  offset: number;
  text: string;
  /** The event name as the branch writes it - the raise's own spelling. */
  name: string;
}

/** The head of a CASE over the event - the same two spellings the linter's
 *  `event-without-handler` reads its handlers from. */
const CASE_OVER_EVENT_HEAD =
  /\b(CASE)\s+[^.]*?(?:get_event\s*\(\s*\)|get\s*\(\s*\)-event)[^.]*\./gi;

interface CaseRegion {
  /** Offset of the `CASE` keyword. */
  from: number;
  /** One past `ENDCASE`'s last character. */
  to: number;
  /** Start of the body: one past the head's period. */
  bodyAt: number;
  /** Offset of the `ENDCASE` keyword. */
  endcaseAt: number;
  /** Nested CASE … ENDCASE blocks inside the body, as `[from, to)`. */
  inner: Array<[number, number]>;
  /** The `CASE` keyword as written - `CASE` or `case`. */
  keyword: string;
}

/**
 * The first CASE over the event in the source, up to ITS OWN ENDCASE, nested
 * CASE blocks counted through (a status switch inside one handler is not
 * the dispatcher, and its `WHEN OTHERS` is not the dispatcher's either).
 */
function eventCaseRegion(code: string): CaseRegion | undefined {
  CASE_OVER_EVENT_HEAD.lastIndex = 0;
  const head = CASE_OVER_EVENT_HEAD.exec(code);
  if (!head) {
    return undefined;
  }
  const bodyAt = head.index + head[0].length;
  const inner: Array<[number, number]> = [];
  let depth = 1;
  let open: number | undefined;
  const re = /\b(CASE|ENDCASE)\b/gi;
  re.lastIndex = bodyAt;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1].toUpperCase() === "CASE") {
      depth++;
      if (depth === 2) {
        open = m.index;
      }
    } else {
      depth--;
      if (depth === 1 && open !== undefined) {
        inner.push([open, m.index + m[0].length]);
        open = undefined;
      }
      if (depth === 0) {
        return {
          from: head.index,
          to: m.index + m[0].length,
          bodyAt,
          endcaseAt: m.index,
          inner,
          keyword: head[1],
        };
      }
    }
  }
  return undefined; // an unclosed CASE mid-edit: nothing to insert into
}

/** Is `offset` at the CASE's own level - inside its body, outside every
 *  nested block? */
function ownLevel(region: CaseRegion, offset: number): boolean {
  return (
    offset >= region.bodyAt &&
    offset < region.endcaseAt &&
    !region.inner.some(([from, to]) => offset >= from && offset < to)
  );
}

/** Start of the line `offset` is on. */
function lineStart(source: string, offset: number): number {
  return source.lastIndexOf("\n", offset - 1) + 1;
}

/** The leading whitespace of the line `offset` is on. */
function indentAt(source: string, offset: number): string {
  const start = lineStart(source, offset);
  const end = source.indexOf("\n", start);
  return /^[ \t]*/.exec(source.slice(start, end === -1 ? undefined : end))?.[0] ?? "";
}

/** One past the end of the line `offset` is on (the newline included). */
function lineEnd(source: string, offset: number): number {
  const nl = source.indexOf("\n", offset);
  return nl === -1 ? source.length : nl + 1;
}

/**
 * The WHEN branch the class should get for `eventName`, or undefined when
 * the class has no CASE over the event to put it in.
 *
 * `near` is where the finding was reported (the raise) - when several
 * raises spell one name differently up to case, the branch takes the
 * spelling of that one, because `get_event( )` compares letter for letter
 * and a branch in the wrong case is exactly the dead control the finding is
 * about. Without a raise to read, the name is written as given.
 */
export function handlerStub(
  source: string,
  eventName: string,
  near?: number
): HandlerStub | undefined {
  const code = blankNonCode(source);
  const region = eventCaseRegion(code);
  if (!region) {
    return undefined;
  }

  // the name as the view raises it
  const raises = eventRaises(source).filter(
    (raise) => raise.name.toUpperCase() === eventName.toUpperCase()
  );
  // the linter places the finding on `client->`, the raise reader on
  // `_event` - so "the raise at the finding" is the nearest one
  const spelt =
    typeof near === "number" && raises.length
      ? raises.reduce((best, raise) =>
          Math.abs(raise.at - near) < Math.abs(best.at - near) ? raise : best
        )
      : raises[0];
  const name = spelt?.name ?? eventName;

  // the neighbours: every WHEN at the CASE's own level, with its literal
  const withLiterals = blankComments(source);
  const whens: Array<{ at: number; keyword: string; quote?: string }> = [];
  const whenRe = /\bWHEN\b/gi;
  whenRe.lastIndex = region.bodyAt;
  let others: number | undefined;
  let m: RegExpExecArray | null;
  while ((m = whenRe.exec(code)) && m.index < region.endcaseAt) {
    if (!ownLevel(region, m.index)) {
      continue;
    }
    const rest = withLiterals.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (/^\s+OTHERS\b/i.test(rest)) {
      others ??= m.index;
      continue;
    }
    const quote = /^\s*(['`])/.exec(rest)?.[1];
    whens.push({ at: m.index, keyword: m[0], quote });
  }

  // where: before WHEN OTHERS, else before ENDCASE - at the line start, so
  // the new branch has lines of its own
  const anchor = others ?? region.endcaseAt;
  const offset = lineStart(source, anchor);

  // how: like the neighbours; without any, like the CASE itself, two in
  const keywordUpper = region.keyword === region.keyword.toUpperCase();
  const whenWord = whens[0]?.keyword ?? (keywordUpper ? "WHEN" : "when");
  const caseIndent = indentAt(source, region.from);
  const whenIndent = whens.length ? indentAt(source, whens[0].at) : `${caseIndent}  `;
  const quote = whens.find((w) => w.quote)?.quote ?? raiseQuote(source, spelt?.nameStart) ?? "`";
  // the body indentation: the first branch's first statement line, when the
  // branch has one deeper than itself; else one level under the WHEN
  let bodyIndent = `${whenIndent}  `;
  if (whens.length) {
    const next = lineEnd(source, whens[0].at);
    const nextIndent = indentAt(source, next);
    if (
      next < region.endcaseAt &&
      nextIndent.length > whenIndent.length &&
      source.slice(next + nextIndent.length, next + nextIndent.length + 1).trim()
    ) {
      bodyIndent = nextIndent;
    }
  }
  // A placeholder the branch is not empty with, so the class compiles the
  // moment the fix lands and the reader sees where the handler goes.
  const text =
    `${whenIndent}${whenWord} ${quote}${name}${quote}.\n` +
    `${bodyIndent}" handle ${name}\n`;
  return { offset, text, name };
}

/** The quote a raise wrote its event name with - `'`, `` ` `` or undefined
 *  for a `|template|`, which a WHEN cannot use. */
function raiseQuote(source: string, nameStart: number | undefined): string | undefined {
  if (nameStart === undefined) {
    return undefined;
  }
  const quote = source[nameStart - 1];
  return quote === "'" || quote === "`" ? quote : undefined;
}
