/*
 * XML view -> z2ui5_cl_ui5_view_builder chain: the reverse of the reconstructed
 * XML view.
 *
 * The linter reconstructs the XML a class builds; this module goes the other
 * way, so a sample from the UI5 demo kit (or any existing view) can be pasted
 * and comes out as the builder chain a port writes by hand. The chain is
 * written by the linter's chain writer (`@abap2ui5/linter/chain-write`) - the
 * layout `chain-house-layout` checks, so a converted view round-trips Format
 * Document unchanged, which the test suite pins down. This module is the
 * forgiving XML parser in front of it and the wiring of handlers to events.
 *
 * `vscode`-free: XML text in, ABAP text out - covered by the test suite.
 */

import { abapLiteral, writeChain } from "@abap2ui5/linter/chain-write";
import type { ChainAttribute, ChainNode } from "@abap2ui5/linter/chain-write";
import { splitName } from "./context";

// ---------------------------------------------------------------------------
// A small, forgiving XML parser - views are machine-written XML, so the
// subset (elements, attributes, comments, CDATA, PIs) is the whole language.
// ---------------------------------------------------------------------------

export interface XmlElement {
  /** Tag name as written, prefix included (`f:Card`). */
  name: string;
  /** Attributes in document order, values entity-decoded. */
  attrs: Array<[name: string, value: string]>;
  children: XmlElement[];
}

export interface ParsedXml {
  roots: XmlElement[];
  /** Non-whitespace text content - the builder has no place for it. */
  droppedText: string[];
  /** Structural problems worth telling the user about. */
  warnings: string[];
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** A numeric entity that names no character is left as written, like an
 *  unknown named one - String.fromCodePoint THROWS above U+10FFFF, and a
 *  pasted view is not worth crashing the conversion over. */
function fromCodePoint(code: number, whole: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
    return whole;
  }
  return String.fromCodePoint(code);
}

/** Entity-decodes an attribute value or text node. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return fromCodePoint(parseInt(body.slice(2), 16), whole);
    }
    if (body.startsWith("#")) {
      return fromCodePoint(parseInt(body.slice(1), 10), whole);
    }
    return ENTITIES[body] ?? whole;
  });
}

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * An attribute value as an XML parser - UI5's included - hands it on: every
 * line break (`\r\n` as ONE) and every tab a blank (XML 1.0 §3.3.3,
 * attribute-value normalisation), BEFORE character references are expanded,
 * so a `&#10;` written on purpose survives as the line break it spells.
 *
 * Leaving it to `lit( )` replaced `\n` alone: a CRLF view whose long binding
 * value was split into `&&` chunks could have the cut fall between `\r` and
 * `\n`, and the chunk then ended in a bare `\r` - a line break inside an
 * ABAP literal for every editor and for abapGit, which refuses literals
 * across lines.
 */
function normalizeAttributeValue(raw: string): string {
  return raw.replace(/\r\n|[\r\n\t]/g, " ");
}
/** What is left of an attribute once the quoted ones are taken out: a name,
 *  an `=`, and a value with no quotes around it. */
const UNQUOTED_ATTR_RE = /([\w:.-]+)\s*=\s*([^\s"'=]+)/g;

export function parseXml(text: string): ParsedXml {
  const roots: XmlElement[] = [];
  const stack: XmlElement[] = [];
  const droppedText: string[] = [];
  const warnings: string[] = [];

  const attach = (el: XmlElement) => {
    (stack.length ? stack[stack.length - 1].children : roots).push(el);
  };

  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) {
      const tail = text.slice(i).trim();
      if (tail) {
        droppedText.push(tail);
      }
      break;
    }
    const between = text.slice(i, lt).trim();
    if (between) {
      droppedText.push(decodeEntities(between));
    }

    if (text.startsWith("<!--", lt)) {
      const end = text.indexOf("-->", lt + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", lt)) {
      const end = text.indexOf("]]>", lt + 9);
      const content = text.slice(lt + 9, end < 0 ? text.length : end).trim();
      if (content) {
        droppedText.push(content);
      }
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
      let end = text.indexOf(">", lt);
      // a DOCTYPE may carry an internal subset - `[ … ]` holding its own `>`s
      const bracket = text.indexOf("[", lt);
      if (
        text.startsWith("<!", lt) &&
        bracket >= 0 &&
        bracket < (end < 0 ? text.length : end)
      ) {
        const close = text.indexOf("]", bracket);
        end = text.indexOf(">", close < 0 ? bracket : close);
      }
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (text.startsWith("</", lt)) {
      const end = text.indexOf(">", lt);
      const name = text.slice(lt + 2, end < 0 ? text.length : end).trim();
      const open = stack.pop();
      if (!open) {
        warnings.push(`closing </${name}> without an open element`);
      } else if (open.name !== name) {
        warnings.push(`closing </${name}> does not match <${open.name}>`);
      }
      i = end < 0 ? text.length : end + 1;
      continue;
    }

    // An opening tag. Its end is the first `>` outside a quoted value.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < text.length) {
      const c = text[j];
      if (quote) {
        if (c === quote) {
          quote = null;
        }
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
      j++;
    }
    const tag = text.slice(lt + 1, j);
    const selfClosing = tag.endsWith("/");
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const name = /^[\w:.-]+/.exec(body.trim())?.[0];
    if (!name) {
      // one line: every warning becomes a `" TODO:` comment in the result,
      // and a line break in it left the rest of the tag there as code
      warnings.push(`skipped an unreadable tag: ${tag.slice(0, 40).replace(/\s+/g, " ")}`);
      i = j + 1;
      continue;
    }
    const attrs: Array<[string, string]> = [];
    const attrText = body.slice(name.length);
    for (const m of attrText.matchAll(ATTR_RE)) {
      attrs.push([m[1], decodeEntities(normalizeAttributeValue(m[2] ?? m[3] ?? ""))]);
    }
    // An unquoted value (`enabled=true`) is not XML, and a pasted snippet has
    // them. The attribute is dropped like the other unreadable pieces - and
    // said so, where it used to vanish without a word.
    for (const m of attrText.replace(ATTR_RE, " ").matchAll(UNQUOTED_ATTR_RE)) {
      warnings.push(
        `attribute ${m[1]}=${m[2]} of <${name}> has no quotes and was dropped`
      );
    }
    const el: XmlElement = { name, attrs, children: [] };
    attach(el);
    if (!selfClosing) {
      stack.push(el);
    }
    i = j + 1;
  }

  for (const open of stack) {
    warnings.push(`<${open.name}> is never closed`);
  }
  return { roots, droppedText, warnings };
}

// ---------------------------------------------------------------------------
// The emitter - the linter's chain writer
// ---------------------------------------------------------------------------

/** ABAP's hard line limit - a longer line fails abapGit import/activation. */
const MAX_LINE = 255;

/** Attribute names that are events on the controls people paste, for the
 *  case where the handler value is a bare identifier (`press="onPress"`) -
 *  a `.handler` value needs no list, its shape already says event. */
const EVENT_ATTRS = new Set([
  "press",
  "change",
  "select",
  "selectionchange",
  "livechange",
  "submit",
  "search",
  "confirm",
  "cancel",
  "close",
  "afterclose",
  "beforeopen",
  "afteropen",
  "itempress",
  "navbuttonpress",
  "updatefinished",
  "valuehelprequest",
  "selectionfinish",
  "toggle",
]);

/** A controller-handler reference: `.onPress`, `.nav.toDetail($event)`. */
const HANDLER_VALUE = /^\.[A-Za-z_][\w.]*(?:\(\s*[^)]*\))?$/;

/** The abap2UI5 event name a handler reference maps to: the last dotted
 *  segment, camelCase folded to UPPER_SNAKE (`onPress` -> `ON_PRESS`). */
function eventNameFor(value: string): string {
  const bare = value.replace(/^\./, "").replace(/\(.*\)$/, "");
  const local = bare.split(".").filter(Boolean).pop() ?? bare;
  return local.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/**
 * The parsed view as the tree the linter's chain writer takes
 * (`@abap2ui5/linter/chain-write`). What is this module's own is the reading
 * of a pasted view: a handler reference becomes the abap2UI5 event it is
 * wired to (and a warning saying so), everything else is the literal it was.
 * The layout - one call per line, the levels, the `v =` column, the blank
 * lines, a literal too long for its line cut into `&&` pieces - is the
 * writer's, the one the playground and the layout editor write with too.
 */
function chainTree(el: XmlElement, warnings: string[]): ChainNode {
  const { prefix, local } = splitName(el.name);
  const attrs: ChainAttribute[] = [];
  for (const [name, value] of el.attrs) {
    const isEvent =
      HANDLER_VALUE.test(value) ||
      (EVENT_ATTRS.has(name.toLowerCase()) && /^[A-Za-z_]\w*$/.test(value));
    if (isEvent) {
      const event = eventNameFor(value);
      attrs.push({ name, raw: `client->_event( ${abapLiteral(event)} )` });
      warnings.push(
        `event '${name}' (was: ${value}) is wired to ` +
          `client->_event( \`${event}\` ) - handle it in a WHEN branch`
      );
      continue;
    }
    // a line break that reached here was written as a character reference
    // (`&#10;`, `&#13;`) - a literal cannot hold one, so it is a blank
    attrs.push({ name, value: value.replace(/\r\n|[\r\n]/g, " ") });
  }
  return {
    name: prefix ? local : el.name,
    ns: prefix ?? "",
    attrs,
    children: el.children.map((child) => chainTree(child, warnings)),
  };
}

export interface ConvertedXml {
  /** The complete statement block, `DATA(view) = …` through `view_display`. */
  abap: string;
  warnings: string[];
}

export interface ConvertOptions {
  /**
   * Keep the `end( )` calls that close the root's containers at the end of
   * the chain. `stringify( )` closes everything still open, so a statement of
   * its own does not need them - but a chain INSERTED INTO another one does:
   * without them the caller's next call, written for the container the
   * abbreviation was expanded in, lands inside the deepest new one.
   */
  keepTrailingEnds?: boolean;
}

/**
 * One XML view (or fragment) as the builder chain that produces it.
 *
 * `stringify( )` renders from the root, so the trailing `end( )`s that only
 * walk the cursor back up are dropped - the corpus ends a chain at its
 * deepest node with a single `).`, and so does this (unless asked to keep
 * them, see {@link ConvertOptions}).
 */
export function xmlToAbap(
  text: string,
  baseIndent = "",
  options: ConvertOptions = {}
): ConvertedXml {
  const { roots, droppedText, warnings } = parseXml(text);
  if (!roots.length) {
    return {
      abap: "",
      warnings: [...warnings, "no XML element found - nothing to convert"],
    };
  }
  if (roots.length > 1) {
    const skipped = roots
      .slice(1)
      .map((root) => `<${root.name}>`)
      .join(", ");
    warnings.push(
      `${roots.length} root elements found - only the first is converted ` +
        `(skipped: ${skipped})`
    );
  }
  for (const dropped of droppedText) {
    // one line, whatever the text node looked like - these warnings end up
    // in single-line `" TODO:` comments
    const flat = dropped.replace(/\s+/g, " ");
    warnings.push(
      `text content has no builder equivalent and was dropped: ` +
        `"${flat.slice(0, 60)}${flat.length > 60 ? "…" : ""}"`
    );
  }

  // `factory( ).` as a statement of its own and the chain off the variable:
  // the shape a 1:1 port of one XML file is written in. The trailing ends
  // only walk the cursor back to the root - the render closes every
  // still-open tag structurally, so the writer leaves them off unless asked.
  const { lines } = writeChain(chainTree(roots[0], warnings), {
    indent: baseIndent.length,
    factory: "detached",
    keepTrailingEnds: options.keepTrailingEnds === true,
  });
  if (baseIndent.trim() !== "" || baseIndent.includes("\t")) {
    // an indent that is not blanks (a tab) is the caller's, character for
    // character - the writer counted its width
    const blanks = " ".repeat(baseIndent.length);
    lines.forEach((line, ix) => {
      lines[ix] = line.startsWith(blanks) ? baseIndent + line.slice(blanks.length) : line;
    });
  }
  lines.push("");
  /* A Dialog is not a view: the corpus (and the POPUP template) hands it to
   * popup_display, and a converted dialog sent through view_display renders
   * nothing anyone can close. The variable stays `view` on purpose - the
   * abbreviation expander slices this statement apart by that name. */
  const display =
    splitName(roots[0].name).local === "Dialog" ? "popup_display" : "view_display";
  lines.push(`${baseIndent}client->${display}( view->stringify( ) ).`);

  if (lines.some((line) => line.length > MAX_LINE)) {
    warnings.push(
      "a line exceeds ABAP's 255-character limit - shorten the value or " +
        "split it by hand"
    );
  }
  return { abap: lines.join("\n"), warnings };
}
