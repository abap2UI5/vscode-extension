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
 * Every ABAP string literal with its content span. Both quote forms, both
 * escapes (`''` and ` `` `), and `|…|` templates are skipped rather than
 * parsed: a template is not where an id or a binding path is written, and
 * half-understanding one would be worse than leaving it alone.
 */
function literals(source: string): Literal[] {
  const out: Literal[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch !== "'" && ch !== "`") {
      continue;
    }
    const start = i + 1;
    let j = start;
    for (; j < source.length; j++) {
      if (source[j] !== ch) {
        continue;
      }
      if (source[j + 1] === ch) {
        j++; // an escaped quote, still inside the literal
        continue;
      }
      break;
    }
    out.push({ start, end: j, text: source.slice(start, j) });
    i = j;
  }
  return out;
}

/** The first literal starting after `from`, within reach. */
function literalAfter(all: readonly Literal[], from: number): Literal | undefined {
  const hit = all.find((literal) => literal.start > from);
  return hit && hit.start - from <= MARKER_REACH ? hit : undefined;
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
export function idLiterals(source: string): NamedSpan[] {
  const all = literals(source);
  const out: NamedSpan[] = [];
  const seen = new Set<number>();
  for (const marker of source.matchAll(ID_MARKERS)) {
    const at = (marker.index ?? 0) + marker[0].length;
    const literal = literalAfter(all, at);
    if (!literal || !literal.text || seen.has(literal.start)) {
      continue;
    }
    seen.add(literal.start);
    out.push({ name: literal.text, start: literal.start, end: literal.end });
  }
  return out.sort((a, b) => a.start - b.start);
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

/** `{/MV_TITLE}`, `{/MT_TAB/COLUMN}`, `${/MV_TITLE}`, `path: '/MV_TITLE'` -
 *  a root path segment inside a view literal. */
const ROOT_PATH_SEGMENT = /\/([A-Z_][A-Z0-9_]*)/gi;

/** An ABAP declaration of the attribute, which is what makes it a rename
 *  target rather than a coincidence: only a name the class DECLARES may be
 *  renamed, so a binding path into a nested structure is left alone. */
function declares(source: string, name: string): boolean {
  return new RegExp(
    String.raw`\b(?:DATA|CLASS-DATA|CONSTANTS)\s*:?\s*(?:[\w,\s]*\b)?${name}\b`,
    "i"
  ).test(source);
}

/** Is this offset inside one of the source's string literals? */
function insideLiteral(all: readonly Literal[], offset: number): boolean {
  return all.some((literal) => offset >= literal.start && offset < literal.end);
}

/** The comment lines of an ABAP source - `*` in column one, and everything
 *  after a `"` that is not inside a literal. */
function commentRanges(source: string, all: readonly Literal[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let lineStart = 0;
  for (const line of source.split("\n")) {
    if (/^\s*\*/.test(line)) {
      out.push([lineStart, lineStart + line.length]);
    } else {
      const quote = line.indexOf('"');
      if (quote >= 0 && !insideLiteral(all, lineStart + quote)) {
        out.push([lineStart + quote, lineStart + line.length]);
      }
    }
    lineStart += line.length + 1;
  }
  return out;
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
export function attributeSpans(source: string, name: string): NamedSpan[] {
  if (!declares(source, name)) {
    return [];
  }
  const all = literals(source);
  const comments = commentRanges(source, all);
  const inComment = (at: number) =>
    comments.some(([from, to]) => at >= from && at < to);
  const out: NamedSpan[] = [];

  // the ABAP identifier, outside literals and comments
  const identifier = new RegExp(String.raw`\b${name}\b`, "gi");
  for (const match of source.matchAll(identifier)) {
    const at = match.index ?? 0;
    if (insideLiteral(all, at) || inComment(at)) {
      continue;
    }
    out.push({ name: match[0], start: at, end: at + match[0].length });
  }

  // the binding paths inside view literals, where a segment is the name
  for (const literal of all) {
    if (!literal.text.includes("{") && !literal.text.includes("/")) {
      continue;
    }
    for (const segment of literal.text.matchAll(ROOT_PATH_SEGMENT)) {
      if (segment[1].toUpperCase() !== name.toUpperCase()) {
        continue;
      }
      const at = literal.start + (segment.index ?? 0) + 1;
      out.push({ name: segment[1], start: at, end: at + segment[1].length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The attribute the cursor is on - as the ABAP identifier or as a path
 *  segment - provided the class declares it. */
export function attributeAt(source: string, offset: number): NamedSpan | undefined {
  const word = wordAt(source, offset);
  if (!word || !declares(source, word.name)) {
    return undefined;
  }
  return attributeSpans(source, word.name).find(
    (span) => offset >= span.start && offset <= span.end
  );
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
