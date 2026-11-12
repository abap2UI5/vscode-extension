/*
 * Events and bindings in an ABAP source: the `_event( )` calls of the view,
 * the `CASE client->get_event( )` dispatch with its WHEN branches, and the
 * argument of a `client->_bind( )`.
 *
 * Split out of `context.ts`, which re-exports it - import from there.
 * `vscode`-free.
 */

import {
  abapStatements,
  blankComments,
  blankNonCode,
  declaredNames,
} from "./abapscan";
import { argNameBefore, scanAbap } from "./contextscan";

// ---------------------------------------------------------------------------
// Events: from the view's _event( ) to the WHEN branch that handles it
// ---------------------------------------------------------------------------

/** A literal with its content span - what event navigation points at. */
export interface NamedSpan {
  name: string;
  start: number;
  end: number;
}

/** The event name the cursor sits on inside a `client->_event( … )` call
 *  (any of its spellings: positional, `val =`, `_event_display`).
 *
 *  Only the NAME literal - the one `eventRaises` reads: positional or
 *  `val =`, and spelled like an event. Any literal of the call used to count,
 *  so the cursor in `arg = \`${$parameters>/value}\`` was "on an event":
 *  F2 offered to rename `${$parameters>/value}` as one and then changed
 *  nothing, the highlights lit up nothing, and an `arg` that happened to
 *  spell an event jumped to that event's WHEN. */
export function eventNameAt(
  source: string,
  offset: number
): NamedSpan | undefined {
  const { stack, literal } = scanAbap(source, offset);
  const call = stack[stack.length - 1];
  if (!literal || !call || !/^_event\w*$/i.test(call.name)) {
    return undefined;
  }
  const arg = argNameBefore(source, call.open + 1, literal.start - 1);
  if (arg !== undefined && arg !== "val") {
    return undefined;
  }
  const name = source.slice(literal.start, literal.end);
  return /^[\w-]+$/.test(name)
    ? { name, start: literal.start, end: literal.end }
    : undefined;
}

/**
 * The literal the cursor sits in when it is the EVENT NAME of a
 * `client->_event( )` call - the positional argument or `val =`, in any
 * spelling of the call - so completion can offer the names the class handles
 * while the wire is being written. `_event_client( )` raises a CLIENT action
 * and is left out; so is a literal that is some other argument of the call.
 */
export function eventLiteralAt(
  source: string,
  offset: number
): { start: number; end: number } | undefined {
  const { stack, literal } = scanAbap(source, offset);
  const call = stack[stack.length - 1];
  if (!literal || !call || !/^_event(?!_client$)\w*$/i.test(call.name)) {
    return undefined;
  }
  const arg = argNameBefore(source, call.open + 1, literal.start - 1);
  if (arg !== undefined && arg !== "val") {
    return undefined;
  }
  return { start: literal.start, end: literal.end };
}

/** The event names the class asks `check_on_event( )` about - the other
 *  way of handling one, next to a `WHEN` branch. */
export function checkedEvents(source: string): string[] {
  const out: string[] = [];
  const re = /\bcheck_on_event\s*\(\s*(?:val\s*=\s*)?(['`])([\w-]+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blankComments(source)))) {
    out.push(m[2]);
  }
  return out;
}

/** The cursor sits on the argument of a `client->_bind( )`. */
export interface BindArgument {
  /** The identifier typed so far. */
  prefix: string;
  /** Span of that identifier - the range a completion replaces. */
  start: number;
  end: number;
}

/**
 * The attribute being named in a `client->_bind( ‸ )` / `_bind_edit( )` /
 * `_bind_path( )` call - positionally or as `val =`, a `me->` in front
 * allowed - or undefined once the argument is complete (`_bind( name ‸`) or
 * the cursor is on some other argument of the call.
 */
export function bindArgumentAt(
  source: string,
  offset: number
): BindArgument | undefined {
  const { stack, literal } = scanAbap(source, offset);
  const call = stack[stack.length - 1];
  if (literal || !call || !/^_bind(?:_edit|_path)?$/i.test(call.name)) {
    return undefined;
  }
  const before = blankComments(source).slice(call.open + 1, offset);
  const m = /^\s*(?:val\s*=\s*)?(?:me->)?(\w*)$/i.exec(before);
  if (!m) {
    return undefined;
  }
  const start = offset - m[1].length;
  let end = offset;
  while (end < source.length && /\w/.test(source[end])) {
    end++;
  }
  return { prefix: m[1], start, end };
}

/** An attribute `client->_bind( )` may take. */
export interface BindableAttribute {
  name: string;
  /** True for a table - what an aggregation binds. */
  table: boolean;
}

/**
 * The attributes a `_bind( )` can address: the instance `DATA` of the
 * class's PUBLIC SECTION. That is the framework's own rule - it serializes
 * exactly those, and a `CONSTANTS`, a `CLASS-DATA` or a reference raises
 * BINDING_ERROR at runtime, so none of them is offered. Read statement by
 * statement over the lexer's spans, like `annotations.ts` reads the same
 * section for the roundtrip cost: a chained `DATA: a TYPE x, b TYPE y.`
 * declares both, and a commented-out entry declares nothing.
 */
export function bindableAttributes(source: string): BindableAttribute[] {
  const code = blankNonCode(source);
  const start = /^\s*PUBLIC\s+SECTION\s*\./im.exec(code);
  if (!start) {
    return [];
  }
  const from = start.index + start[0].length;
  const end = /^\s*(?:PROTECTED\s+SECTION|PRIVATE\s+SECTION|ENDCLASS)\s*\./im.exec(
    code.slice(from)
  );
  const section = source.slice(from, end ? from + end.index : source.length);
  const out: BindableAttribute[] = [];
  for (const statement of abapStatements(section)) {
    const text = blankNonCode(statement.text);
    if (!/^\s*DATA\b/i.test(text)) {
      continue;
    }
    for (const declared of declaredNames(statement.text)) {
      if (declared.component) {
        continue;
      }
      // the entry's own clause: up to the comma of a chained declaration
      const comma = text.indexOf(",", declared.at);
      const clause = text.slice(declared.at, comma < 0 ? text.length : comma);
      if (/\bREF\s+TO\b/i.test(clause)) {
        continue;
      }
      out.push({ name: declared.name, table: /\bTABLE\s+OF\b/i.test(clause) });
    }
  }
  return out;
}

/** The head of a CASE over the event - the same two spellings the linter's
 *  `event-without-handler` reads its handlers from. */
const CASE_OVER_EVENT_HEAD =
  /\b(CASE)\s+[^.]*?(?:get_event\s*\(\s*\)|get\s*\(\s*\)-event)[^.]*\./gi;

/** A `CASE client->get_event( )` (or `CASE client->get( )-event`) block -
 *  the dispatcher whose WHEN branches are the event handlers. */
export interface CaseRegion {
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
 * The CASE whose head was matched at `headAt` (`headLength` long), up to ITS
 * OWN ENDCASE, nested CASE blocks counted through (a status switch inside one
 * handler is not the dispatcher, and its `WHEN OTHERS` is not the
 * dispatcher's either). Undefined for an unclosed CASE mid-edit.
 */
function caseRegionFrom(
  code: string,
  headAt: number,
  headLength: number,
  keyword: string
): CaseRegion | undefined {
  const bodyAt = headAt + headLength;
  const inner: Array<[number, number]> = [];
  let depth = 1;
  let open: number | undefined;
  // only a CASE that starts a statement opens a block - the one in
  // `TO UPPER CASE` or `IGNORING CASE` is part of another statement, and
  // counting it let the dispatcher's own ENDCASE close it instead
  const re = /(?<=(?:^|[.:,])\s*)\b(CASE)\b|\b(ENDCASE)\b/gi;
  re.lastIndex = bodyAt;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    if (m[1]) {
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
          from: headAt,
          to: m.index + m[0].length,
          bodyAt,
          endcaseAt: m.index,
          inner,
          keyword,
        };
      }
    }
  }
  return undefined;
}

/**
 * Every CASE over the event in `code` - which must be the `blankNonCode`
 * copy of the source, so a CASE in a comment or a literal is not one. A
 * class may dispatch in more than one method, so this is a list; a head
 * whose block never closes (mid-edit) is left out.
 */
export function eventCaseRegions(code: string): CaseRegion[] {
  const out: CaseRegion[] = [];
  const re = new RegExp(CASE_OVER_EVENT_HEAD.source, CASE_OVER_EVENT_HEAD.flags);
  let head: RegExpExecArray | null;
  while ((head = re.exec(code))) {
    const region = caseRegionFrom(code, head.index, head[0].length, head[1]);
    if (region) {
      out.push(region);
      re.lastIndex = Math.max(re.lastIndex, region.to);
    }
  }
  return out;
}

/** The first CASE over the event (see `eventCaseRegions`) - where the
 *  handler-stub quick fix adds a branch. */
export function eventCaseRegion(code: string): CaseRegion | undefined {
  const re = new RegExp(CASE_OVER_EVENT_HEAD.source, CASE_OVER_EVENT_HEAD.flags);
  const head = re.exec(code);
  return head ? caseRegionFrom(code, head.index, head[0].length, head[1]) : undefined;
}

/** Is `offset` at the CASE's own level - inside its body, outside every
 *  nested block? */
export function ownLevel(region: CaseRegion, offset: number): boolean {
  return (
    offset >= region.bodyAt &&
    offset < region.endcaseAt &&
    !region.inner.some(([from, to]) => offset >= from && offset < to)
  );
}

/**
 * Whether a WHEN at `offset` is a branch of the event dispatch: at the own
 * level of a CASE over the event - or, when the source has no such CASE at
 * all, any WHEN (a dispatcher spelled some other way, e.g. over a local
 * `lv_event`, still gets its wires). Without that restriction a
 * `CASE mv_mode. WHEN 'EDIT'.` beside the dispatch was renamed, highlighted
 * and lensed along with the event `EDIT`.
 */
function dispatchFilter(source: string): (offset: number) => boolean {
  const regions = eventCaseRegions(blankNonCode(source));
  if (!regions.length) {
    return () => true;
  }
  return (offset) => regions.some((region) => ownLevel(region, offset));
}

/** How far back the WHEN test reads. Wide enough for any real alternative
 *  chain (`WHEN 'A' OR 'B' OR …` across lines) - the old 200 silently lost
 *  completion and rename on the last literals of a long one - and bounded so
 *  the anchored regex below never scans a whole class. */
const WHEN_LOOKBACK = 2000;

/** The literal the cursor sits in when it is a `WHEN '…'` alternative -
 *  `WHEN 'A' OR 'B'` puts every alternative in play, not only the first. */
export function whenLiteralAt(
  source: string,
  offset: number
): { start: number; end: number } | undefined {
  const { literal } = scanAbap(source, offset);
  if (!literal) {
    return undefined;
  }
  const before = source.slice(
    Math.max(0, literal.start - WHEN_LOOKBACK),
    literal.start
  );
  const when = /\bWHEN\s*(?:(['`])[\w-]+\1\s+OR\s+)*['`]$/i.exec(before);
  if (!when) {
    return undefined;
  }
  // a WHEN of another CASE (`CASE mv_mode.`) is not a branch of the dispatch
  const whenAt = literal.start - before.length + when.index;
  if (!dispatchFilter(source)(whenAt)) {
    return undefined;
  }
  return { start: literal.start, end: literal.end };
}

/** The event name the cursor sits on inside a `WHEN '…'` of the dispatch -
 *  spelled the way `whenBranches` reads one. `WHEN \`Out of Stock\` THEN`,
 *  `WHEN \`%MSG\`` or `WHEN \`/N\`` is a value, not an event, and F2 there
 *  used to offer a rename that then changed nothing. */
export function whenNameAt(
  source: string,
  offset: number
): NamedSpan | undefined {
  const span = whenLiteralAt(source, offset);
  if (!span) {
    return undefined;
  }
  const name = source.slice(span.start, span.end);
  return /^[\w-]+$/.test(name) ? { name, ...span } : undefined;
}

/*
 * The four readers below match on literal CONTENT ('SAVE'), so they cannot
 * run over `blankNonCode` - it would take away the very text they look for.
 * They run over `blankComments` instead: same offsets, literals intact, and a
 * commented-out copy of a branch or a wire out of the way.
 *
 * Without it a `* WHEN 'SAVE'.` left above a live one was a match like any
 * other: Go-to-Definition landed on the dead line (the FIRST match wins), and
 * F2 rewrote it as if it were code.
 */

/** Where `WHEN '<name>'` handles the event - the offset of the literal. */
export function whenBranchOf(source: string, name: string): number | undefined {
  return whenBranches(source).find(
    (branch) => branch.name.toUpperCase() === name.toUpperCase()
  )?.start;
}

/**
 * Every `_event…( )` call that names its event in a literal: the call's
 * offset, the event name, and where the name stands.
 *
 * The event name is the `val` argument (or the positional first literal),
 * found by walking the call's parentheses - `[^)]*?` used to stand in for
 * that walk and stopped at the `)` of a nested `VALUE #( … )`, so a raise
 * written `_event( t_arg = VALUE #( ( lv ) ) val = 'GO' )` was invisible:
 * F2 renamed the WHEN branch and silently left this end of the wire behind.
 */
export function eventRaises(
  source: string
): Array<{ name: string; at: number; nameStart: number }> {
  const code = blankNonCode(source);
  const withLiterals = blankComments(source);
  const out: Array<{ name: string; at: number; nameStart: number }> = [];
  const re = /\b_event\w*\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    let depth = 1;
    let j = open + 1;
    while (j < code.length && depth > 0) {
      if (code[j] === "(") {
        depth++;
      } else if (code[j] === ")") {
        depth--;
      }
      j++;
    }
    const args = withLiterals.slice(open + 1, depth === 0 ? j - 1 : j);
    const lit =
      /\bval\s*=\s*(['`])([\w-]+)\1/i.exec(args) ??
      /^\s*(['`])([\w-]+)\1/.exec(args);
    if (!lit) {
      continue;
    }
    const nameStart = open + 1 + lit.index + lit[0].length - 1 - lit[2].length;
    out.push({ name: lit[2], at: m.index, nameStart });
  }
  return out;
}

/** Every `_event( … '<name>' … )` writing the event - the view-side ends. */
export function eventUsagesOf(source: string, name: string): number[] {
  return eventRaises(source)
    .filter((raise) => raise.name.toUpperCase() === name.toUpperCase())
    .map((raise) => raise.at);
}

/** Every `WHEN '<name>'` of the event dispatch - what the usage lens hangs
 *  on. Each alternative of a `WHEN 'A' OR 'B'` is its own branch. Only the
 *  WHENs at the own level of a `CASE client->get_event( )` count when the
 *  class has one (a nested status switch or a `CASE mv_mode.` beside it
 *  is not the dispatch); without such a CASE, every WHEN does. */
export function whenBranches(source: string): NamedSpan[] {
  const out: NamedSpan[] = [];
  const code = blankComments(source);
  const inDispatch = dispatchFilter(source);
  const re = /\bWHEN\s+/gi;
  /* Sticky, so each literal and each `OR` is matched AT the position rather
   * than on a `code.slice(at)` copy of the rest of the class - one copy per
   * WHEN made a long dispatch quadratic in the size of the source. */
  const litRe = /(['`])([\w-]+)\1/y;
  const orRe = /\s+OR\s+/iy;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let at = m.index + m[0].length;
    const own = inDispatch(m.index);
    for (;;) {
      litRe.lastIndex = at;
      const lit = litRe.exec(code);
      if (!lit) {
        break;
      }
      if (own) {
        out.push({ name: lit[2], start: at + 1, end: at + 1 + lit[2].length });
      }
      at += lit[0].length;
      orRe.lastIndex = at;
      const or = orRe.exec(code);
      if (!or) {
        break;
      }
      at += or[0].length;
    }
    re.lastIndex = at;
  }
  return out;
}

/**
 * The content spans of every literal naming this event - in `_event( )`
 * calls and in `WHEN` branches alike. What a rename replaces: all of them
 * together, so the view and the dispatch cannot drift apart.
 */
export function eventNameSpans(source: string, name: string): NamedSpan[] {
  const out: NamedSpan[] = [];
  for (const raise of eventRaises(source)) {
    if (raise.name.toUpperCase() === name.toUpperCase()) {
      out.push({
        name: raise.name,
        start: raise.nameStart,
        end: raise.nameStart + raise.name.length,
      });
    }
  }
  for (const branch of whenBranches(source)) {
    if (branch.name.toUpperCase() === name.toUpperCase()) {
      out.push(branch);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
