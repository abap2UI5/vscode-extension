/*
 * renamewires - what an id and what a bound attribute are called, everywhere
 * the class says it.
 *
 * abap2UI5 wires two halves of an app together with strings. A control gets
 * `a( n = `id` v = `TABLE` )` in the view; ABAP addresses it as a literal in a
 * CONTROL_BY_ID / SET_FOCUS / SCROLL_TO / SCROLL_INTO_VIEW /
 * KEYBOARD_SET_MODE wire, or as `popover_display( by_id = `TABLE` )`. An
 * attribute is `DATA mv_title` in the class and `{/MV_TITLE}` in the view.
 *
 * Neither half is a symbol any ABAP tooling can follow: to the compiler the
 * string is a string. So renaming an id today means grep, and forgetting one
 * end produces the defect the linter has a rule for - a wire that addresses
 * nothing and silently does nothing at runtime, with no error anywhere.
 *
 * This module finds both ends. `vscode`-free, because the finding is the hard
 * part and the WorkspaceEdit around it is not.
 */

import {
  abapSpans,
  abapStatements,
  blankComments,
  blankNonCode,
  declaredNames,
  type AbapStatement,
} from "./abapscan";

import type { NamedSpan } from "./context";

/** The frontend actions whose first argument is a control id. Same set the
 *  linter's `frontend-action-unknown-id` judges - a wire naming an id no view
 *  declares does nothing at all, not even a console line. */
const ID_ACTIONS = [
  "control_by_id",
  "set_focus",
  "scroll_to",
  "scroll_into_view",
  "keyboard_set_mode",
];

/** Markers after which the FIRST literal is a control id. */
const ID_MARKERS = new RegExp(
  String.raw`(?:\b(?:${ID_ACTIONS.join("|")})\b|\bby_id\s*=|\bn\s*=\s*['\`]id['\`])`,
  "gi"
);

/** How far after a marker the id may sit. A wire spans a `VALUE #( ( … ) )`
 *  table, so it is not the next few characters - but it is never a screen. */
const MARKER_REACH = 400;

interface Literal {
  start: number;
  end: number;
  text: string;
}

/**
 * Everything the detectors read out of one source, derived on demand.
 *
 * The lexing used to happen per detector per call - one F2 walks
 * `eventNameAt`, `idAt`, `attributeAt` and then the span collectors, and
 * each of them re-lexed the whole class.
 *
 * `abapscan.ts` now memoises the lex itself, so the spans and the two blanked
 * copies are shared with every other feature in the window rather than only
 * with the next detector here. What is left for this cache is the DERIVED
 * shapes - the literal list, the comment ranges, the statements, the names a
 * declaration statement introduces - and each of them is built the first time
 * it is asked for, so a detector that only wants the literals no longer pays
 * for the statement split as well.
 */
class Lexed {
  private literalList?: Literal[];
  private commentList?: Array<[number, number]>;
  private statementList?: AbapStatement[];
  /** `declaredNames` per statement index - `declares( )` walks every
   *  statement, and every walk used to re-blank and re-parse each one. */
  private readonly names = new Map<number, ReturnType<typeof declaredNames>>();

  constructor(readonly source: string) {}

  /** Every string literal with its content span, from the shared lexer.
   *
   *  This used to be its own scan, and it read a `'` inside a `" comment` as
   *  the start of a literal - one apostrophe in one comment ("that's the
   *  wire") then swallowed the rest of the file, and F2 found no wires at
   *  all. Silently: the rename went through on the id alone and the binding
   *  it belonged to kept pointing at the old name, which is the exact defect
   *  this module exists to prevent. */
  get literals(): Literal[] {
    if (!this.literalList) {
      this.literalList = abapSpans(this.source)
        .filter((span) => span.kind === "literal")
        .map((span) => ({
          start: span.start,
          end: span.end,
          text: this.source.slice(span.start, span.end),
        }));
    }
    return this.literalList;
  }

  /** Comment spans, `[from, to)`. */
  get comments(): Array<[number, number]> {
    if (!this.commentList) {
      this.commentList = abapSpans(this.source)
        .filter((span) => span.kind === "comment")
        .map((span) => [span.from, span.to] as [number, number]);
    }
    return this.commentList;
  }

  /** The source with only comments blanked. */
  get code(): string {
    return blankComments(this.source);
  }

  /** The source with everything non-code blanked. */
  get blanked(): string {
    return blankNonCode(this.source);
  }

  get statements(): AbapStatement[] {
    if (!this.statementList) {
      this.statementList = abapStatements(this.source);
    }
    return this.statementList;
  }

  /** The names the statement at `index` declares. */
  declaredIn(index: number): ReturnType<typeof declaredNames> {
    let out = this.names.get(index);
    if (!out) {
      out = declaredNames(this.statements[index].text);
      this.names.set(index, out);
    }
    return out;
  }
}

let cached: Lexed | undefined;

function lex(source: string): Lexed {
  if (cached && cached.source === source) {
    return cached;
  }
  cached = new Lexed(source);
  return cached;
}

/** The first literal starting after `from`, within reach AND before `limit`.
 *  Binary search - the literals are in source order. */
function literalAfter(
  all: readonly Literal[],
  from: number,
  limit: number
): Literal | undefined {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].start > from) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const hit = all[lo];
  return hit && hit.start - from <= MARKER_REACH && hit.start < limit
    ? hit
    : undefined;
}

/** One past the `.` that ends the statement `at` belongs to. A marker whose
 *  own statement carries no literal (`set_focus( lv_id )`) must not reach
 *  forward into the NEXT statement and bless whatever it says first. */
function statementEnd(statements: readonly AbapStatement[], at: number): number {
  let lo = 0;
  let hi = statements.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const statement = statements[mid];
    if (at < statement.start + statement.text.length) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  const statement = statements[lo];
  return statement
    ? statement.start + statement.text.length
    : Number.MAX_SAFE_INTEGER;
}

/**
 * Every literal in the source that IS a control id - the `a( n = `id` v = … )`
 * that declares one and every wire that addresses one.
 *
 * Position decides, never the text: a literal is an id because it follows the
 * marker that makes it one. A `t_arg` whose second entry happens to read the
 * same as the id (`setValue`, say) is not one, and renaming it would break the
 * wire it belongs to.
 */
export function idLiterals(source: string): IdLiteral[] {
  return idLiteralScan(source, false);
}

/** Which end of a wire an id literal is: the `a( n = \`id\` v = … )` that
 *  DECLARES the id on a control, or an ABAP wire that addresses one. */
export type IdRole = "declaration" | "wire";

export interface IdLiteral extends NamedSpan {
  role: IdRole;
}

/** The marker that declares an id, as opposed to the ones that address one -
 *  see {@link ID_MARKERS}, whose first alternative this is. */
const DECLARING_MARKER = /^n\s*=/i;

function idLiteralScan(source: string, includeEmpty: boolean): IdLiteral[] {
  /*
   * The markers are looked for in CODE, not in the raw text. Read raw, a
   * comment mentioning one ("TODO use control_by_id here") armed the scan,
   * and the next literal - the toast text on the line below - was recorded as
   * a control id. F2 then offered to rename it, and renaming a real id whose
   * text happened to match rewrote it too, because the other end is found by
   * text. `blankComments` keeps every offset - and keeps the literals, which
   * one of the markers reads (`n = \`id\``).
   */
  const { literals, code, statements } = lex(source);
  const out: IdLiteral[] = [];
  const seen = new Set<number>();
  for (const marker of code.matchAll(ID_MARKERS)) {
    const at = (marker.index ?? 0) + marker[0].length;
    const literal = literalAfter(literals, at, statementEnd(statements, at));
    if (!literal || seen.has(literal.start)) {
      continue;
    }
    // An EMPTY literal is nobody's id, so the readers skip it - but it is
    // exactly where somebody is about to type one, which is what the
    // completion below asks for.
    if (!literal.text && !includeEmpty) {
      continue;
    }
    seen.add(literal.start);
    out.push({
      name: literal.text,
      start: literal.start,
      end: literal.end,
      role: DECLARING_MARKER.test(marker[0]) ? "declaration" : "wire",
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The ids this class DECLARES: the `a( n = \`id\` v = \`TABLE\` )` written on
 * a control, in source order and without duplicates.
 *
 * The other half of the wire - `set_focus( \`TABLE\` )`, `by_id = \`TABLE\``,
 * `control_by_id` - is judged against exactly this list by the linter's
 * `frontend-action-unknown-id`, and a wire naming an id no view declares does
 * nothing at all at runtime, not even a console line.
 */
export function declaredIds(source: string): string[] {
  const out: string[] = [];
  for (const literal of idLiterals(source)) {
    if (literal.role === "declaration" && !out.includes(literal.name)) {
      out.push(literal.name);
    }
  }
  return out;
}

/** An id being written in a wire, with what may go there. */
export interface IdCompletion {
  /** What is already typed inside the literal. */
  prefix: string;
  /** The literal's content span - the range a completion replaces. */
  start: number;
  end: number;
  /** The ids the class declares, in source order. */
  ids: string[];
}

/**
 * The id-taking literal the cursor sits in, with the ids the class declares -
 * or undefined when the cursor is somewhere else.
 *
 * Only the WIRE end is completed. A typo there is the silent defect this
 * module exists around: the wire addresses nothing and does nothing, with no
 * error anywhere. The declaring `a( n = \`id\` … )` is the source of truth for
 * what an id is called and has nothing to be completed from.
 */
export function idCompletionAt(
  source: string,
  offset: number
): IdCompletion | undefined {
  const wire = idLiteralScan(source, true).find(
    (span) =>
      span.role === "wire" && offset >= span.start && offset <= span.end
  );
  if (!wire) {
    return undefined;
  }
  const ids = declaredIds(source);
  return ids.length
    ? {
        prefix: source.slice(wire.start, Math.max(wire.start, offset)),
        start: wire.start,
        end: wire.end,
        ids,
      }
    : undefined;
}

/** The id the cursor is on, if it is on one. */
export function idAt(source: string, offset: number): NamedSpan | undefined {
  return idLiterals(source).find(
    (span) => offset >= span.start && offset <= span.end
  );
}

/** Every place this id is written - what a rename has to replace together. */
export function idSpans(source: string, id: string): NamedSpan[] {
  return idLiterals(source).filter((span) => span.name === id);
}

// ---------------------------------------------------------------------------
// Bound attributes: the ABAP name and the binding path
// ---------------------------------------------------------------------------

/** `{/MV_TITLE}`, `${/MV_TITLE}`, `path: '/MV_TITLE'` - a ROOT path segment
 *  inside a view literal: the `/` opening the path, not one between two
 *  segments. `{/MT_TAB/COLUMN}`'s COLUMN is a field of the row type, not the
 *  attribute - matching every `/SEG` used to rewrite it whenever a declared
 *  name happened to read the same (and `sap-icon://…` URLs with it). */
const ROOT_PATH_SEGMENT = /(^|[^\w/])\/([A-Z_][A-Z0-9_]*)/gi;

/** Statements that declare a CLASS ATTRIBUTE - what a binding path can
 *  resolve to. `TYPES` deliberately does not count: a structure field is
 *  addressed by RELATIVE paths (`{TITLE}`) this module does not track, so
 *  offering to rename one would rewrite the declaration and leave the
 *  binding behind - the half-renamed wire this module exists to prevent. */
const DECLARING = /^\s*(?:CLASS-DATA|DATA|CONSTANTS)\b/i;

/** An ABAP declaration of the attribute, which is what makes it a rename
 *  target rather than a coincidence: only a name the class DECLARES may be
 *  renamed, so a binding path into a nested structure is left alone. */
function declares(lexed: Lexed, name: string): boolean {
  // The name has to stand where a declaration puts the thing it introduces.
  // Any word inside the statement used to count, so `TYPE`, `string` and
  // `LENGTH` all looked declared - and F2 on the `string` in
  // `DATA mv_x TYPE string.` offered a rename that would have rewritten every
  // TYPE clause in the class.
  const blanked = lexed.blanked;
  const wanted = name.toUpperCase();
  return lexed.statements.some((statement, index) => {
    if (
      !DECLARING.test(
        blanked.slice(statement.start, statement.start + statement.text.length)
      )
    ) {
      return false;
    }
    // A component of a `BEGIN OF … END OF` structure is not an attribute
    // either: its path segment is nested (`{/MS_DATA/TITLE}`), which the
    // root-segment pattern below deliberately leaves alone - so accepting the
    // name here renamed the declaration and every same-named field elsewhere,
    // and left the binding behind.
    return lexed
      .declaredIn(index)
      .some(
        (declared) =>
          !declared.component && declared.name.toUpperCase() === wanted
      );
  });
}

/** Is this offset inside one of the source's string literals? */
function insideLiteral(all: readonly Literal[], offset: number): boolean {
  return all.some((literal) => offset >= literal.start && offset < literal.end);
}

/** The two spellings of one attribute: the ABAP identifier as the class
 *  writes it, and the root segment of a binding path, which the framework
 *  derives from the identifier UPPER-cased. */
export type AttributeSpanKind = "identifier" | "path";

export interface AttributeSpan extends NamedSpan {
  kind: AttributeSpanKind;
}

/** A span F2 writes into. Event names and control ids are strings written
 *  exactly as typed; an attribute span carries which spelling it takes. */
export type RenameSpan = NamedSpan & { kind?: AttributeSpanKind };

/**
 * What a rename WRITES into one span. abap2UI5 derives a model path from the
 * attribute's name upper-cased (`mv_title` -> `{/MV_TITLE}`), so the typed
 * new name goes into a path span upper-cased too. Writing it as typed put
 * `{/mv_header}` into the view - an unknown binding path, which is the
 * silently empty wire the rename exists to prevent.
 */
export function renameSpelling(span: RenameSpan, newName: string): string {
  return span.kind === "path" ? newName.toUpperCase() : newName;
}

/**
 * Every place a public attribute's NAME is written: the ABAP identifier and
 * the binding paths that resolve to it.
 *
 * The two are one name with two spellings - `mv_title` in the class,
 * `{/MV_TITLE}` in the view - and nothing in either language connects them,
 * which is why renaming one and not the other is so easy and so silent: the
 * binding resolves to nothing and the control renders empty, with no error.
 *
 * Scope is this class, deliberately. An app class owns its model, the paths
 * are derived from its own declarations, and a rename that reached across a
 * repository on the strength of a regex would be a worse offer than a
 * confident local one.
 */
export function attributeSpans(source: string, name: string): AttributeSpan[] {
  const lexed = lex(source);
  if (!declares(lexed, name)) {
    return [];
  }
  const inComment = (at: number) =>
    lexed.comments.some(([from, to]) => at >= from && at < to);
  const out: AttributeSpan[] = [];

  // the ABAP identifier, outside literals and comments
  const identifier = new RegExp(String.raw`\b${name}\b`, "gi");
  for (const match of source.matchAll(identifier)) {
    const at = match.index ?? 0;
    if (insideLiteral(lexed.literals, at) || inComment(at)) {
      continue;
    }
    out.push({
      name: match[0],
      start: at,
      end: at + match[0].length,
      kind: "identifier",
    });
  }

  // the binding paths inside view literals, where the ROOT segment is the name
  for (const literal of lexed.literals) {
    if (!literal.text.includes("{") && !literal.text.includes("/")) {
      continue;
    }
    for (const segment of literal.text.matchAll(ROOT_PATH_SEGMENT)) {
      if (segment[2].toUpperCase() !== name.toUpperCase()) {
        continue;
      }
      const at =
        literal.start + (segment.index ?? 0) + segment[1].length + 1;
      out.push({
        name: segment[2],
        start: at,
        end: at + segment[2].length,
        kind: "path",
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The attribute the cursor is on - as the ABAP identifier or as a path
 *  segment - provided the class declares it. */
export function attributeAt(source: string, offset: number): NamedSpan | undefined {
  const word = wordAt(source, offset);
  if (!word) {
    return undefined;
  }
  // `attributeSpans` runs the same `declares( )` check as its first line and
  // answers with nothing when the class does not declare the name - asking
  // here as well walked every statement of the class a second time, and F2
  // (which calls this and then the span collector) paid for four walks.
  return attributeSpans(source, word.name).find(
    (span) => offset >= span.start && offset <= span.end
  );
}

// ---------------------------------------------------------------------------
// What a renamed wire may be called
// ---------------------------------------------------------------------------

/** The three things F2 renames here. They do not share a spelling rule,
 *  because only two of them are strings. */
export type RenameKind = "event" | "id" | "attribute";

/**
 * An event name and a control id are STRINGS - the framework compares them
 * with what the view wrote and nothing else reads them, so `-` is as good a
 * character as any and the corpus uses it.
 */
const WIRE_NAME = /^[\w-]+$/;

/**
 * An attribute is an ABAP IDENTIFIER, and the permissive string test used to
 * serve it as well: renaming `mv_title` to `mv-title` passed validation, and
 * the rename then rewrote the DATA declaration and every use into a component
 * selector that does not compile - silently, since nothing here reads ABAP
 * syntax. A declared name starts with a letter or an underscore, holds
 * letters, digits and underscores, and is at most 30 characters long.
 */
const ATTRIBUTE_NAME = /^[A-Za-z_]\w*$/;
const ATTRIBUTE_MAX_LENGTH = 30;

/** Why this new name cannot be used for this kind of target, or undefined
 *  when it can. */
export function renameNameError(
  kind: RenameKind,
  newName: string
): string | undefined {
  if (kind === "attribute") {
    if (!ATTRIBUTE_NAME.test(newName)) {
      return (
        "An attribute name starts with a letter or _ and may only contain " +
        "letters, digits and _ - a '-' would make it a component selector."
      );
    }
    return newName.length > ATTRIBUTE_MAX_LENGTH
      ? `An attribute name may be at most ${ATTRIBUTE_MAX_LENGTH} characters long.`
      : undefined;
  }
  return WIRE_NAME.test(newName)
    ? undefined
    : `${
        kind === "event" ? "An event name" : "A control id"
      } may only contain letters, digits, _ and -.`;
}

/** The identifier-ish word around an offset, in code and inside a binding
 *  path alike. */
function wordAt(source: string, offset: number): NamedSpan | undefined {
  let start = offset;
  let end = offset;
  const isWord = (ch: string) => /[\w]/.test(ch);
  while (start > 0 && isWord(source[start - 1])) {
    start--;
  }
  while (end < source.length && isWord(source[end])) {
    end++;
  }
  const name = source.slice(start, end);
  return name && /^[A-Za-z_]/.test(name) ? { name, start, end } : undefined;
}
