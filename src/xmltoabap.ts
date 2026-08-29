/*
 * XML view -> z2ui5_cl_ui5_view_builder chain: the reverse of the reconstructed
 * XML view.
 *
 * The linter reconstructs the XML a class builds; this module goes the other
 * way, so a sample from the UI5 demo kit (or any existing view) can be pasted
 * and comes out as the builder chain a port writes by hand. The emitted style
 * is the canonical corpus style the chain formatter enforces - a converted
 * view round-trips Format Document unchanged, which the test suite pins down.
 *
 * `vscode`-free: XML text in, ABAP text out - covered by the test suite.
 */

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
      warnings.push(`skipped an unreadable tag: ${tag.slice(0, 40)}`);
      i = j + 1;
      continue;
    }
    const attrs: Array<[string, string]> = [];
    for (const m of body.slice(name.length).matchAll(ATTR_RE)) {
      attrs.push([m[1], decodeEntities(m[2] ?? m[3] ?? "")]);
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
// The emitter - canonical corpus style, chain-formatter clean
// ---------------------------------------------------------------------------

/** 4 spaces per level, the step the chain formatter enforces. */
const STEP = "    ";

/** ABAP's hard line limit - a longer line fails abapGit import/activation. */
const MAX_LINE = 255;

/** An ABAP backtick literal: the backtick escapes by doubling. */
function lit(value: string): string {
  return "`" + value.replace(/`/g, "``").replace(/\r?\n/g, " ") + "`";
}

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

interface Op {
  verb: "ele" | "tag" | "a" | "end";
  args: string;
  level: number;
  /** For an `a` op with a plain literal value - what 255-char splitting
   *  needs to rebuild the call across lines. */
  attr?: { name: string; value: string };
}

/** The call arguments of an ele/tag: positional when only the name is
 *  needed (a lone `n =` trips abaplint's omit_parameter_name), named when a
 *  namespace prefix rides along. */
function elementArgs(name: string): string {
  const { prefix, local } = splitName(name);
  return prefix ? `n = ${lit(local)} ns = ${lit(prefix)}` : lit(name);
}

function emitElement(
  el: XmlElement,
  level: number,
  out: Op[],
  warnings: string[]
): void {
  if (el.children.length === 0) {
    out.push({ verb: "tag", args: elementArgs(el.name), level });
  } else {
    out.push({ verb: "ele", args: elementArgs(el.name), level });
  }
  for (const [name, value] of el.attrs) {
    const isEvent =
      HANDLER_VALUE.test(value) ||
      (EVENT_ATTRS.has(name.toLowerCase()) && /^[A-Za-z_]\w*$/.test(value));
    if (isEvent) {
      const event = eventNameFor(value);
      out.push({
        verb: "a",
        args: `n = ${lit(name)} v = client->_event( ${lit(event)} )`,
        level: level + 1,
      });
      warnings.push(
        `event '${name}' (was: ${value}) is wired to ` +
          `client->_event( \`${event}\` ) - handle it in a WHEN branch`
      );
      continue;
    }
    out.push({
      verb: "a",
      args: `n = ${lit(name)} v = ${lit(value)}`,
      level: level + 1,
      attr: { name, value },
    });
  }
  for (const child of el.children) {
    emitElement(child, level + 1, out, warnings);
  }
  if (el.children.length) {
    out.push({ verb: "end", args: "", level });
  }
}

/** `value` in chunks whose emitted literals keep each line within the given
 *  widths - escaped length is the measure, a backtick costs two. Undefined
 *  when the widths leave no room to make progress. */
function chunkValue(
  value: string,
  firstAvail: number,
  restAvail: number
): string[] | undefined {
  if (firstAvail < 8 || restAvail < 8) {
    return undefined;
  }
  const chunks: string[] = [];
  let current = "";
  let used = 0;
  let avail = firstAvail;
  for (const ch of value) {
    const cost = ch === "`" ? 2 : 1;
    if (used + cost > avail && current) {
      chunks.push(current);
      current = "";
      used = 0;
      avail = restAvail;
    }
    current += ch;
    used += cost;
  }
  chunks.push(current);
  return chunks;
}

export interface ConvertedXml {
  /** The complete statement block, `DATA(view) = …` through `view_display`. */
  abap: string;
  warnings: string[];
}

/**
 * One XML view (or fragment) as the builder chain that produces it.
 *
 * `stringify( )` renders from the root, so the trailing `end( )`s that only
 * walk the cursor back up are dropped - the corpus ends a chain at its
 * deepest node with a single `).`, and so does this.
 */
export function xmlToAbap(text: string, baseIndent = ""): ConvertedXml {
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

  const ops: Op[] = [];
  emitElement(roots[0], 0, ops, warnings);
  // Trailing ends only walk the cursor back to the root - the render closes
  // every still-open tag structurally, so the corpus leaves them off.
  while (ops.length && ops[ops.length - 1].verb === "end") {
    ops.pop();
  }

  const lines: string[] = [];
  lines.push(`${baseIndent}DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).`);
  ops.forEach((op, ix) => {
    const first = ix === 0;
    const last = ix === ops.length - 1;
    const indent = baseIndent + STEP.repeat(op.level);
    // The corpus breathing rhythm, coarse-grained: a blank line before every
    // end, and before an ele that starts a new sibling block after another
    // element's attributes - never between a control and its own a( ) lines.
    const prev = ops[ix - 1];
    const blankBefore =
      (op.verb === "end" && prev?.verb !== "end") ||
      (op.verb === "ele" && (prev?.verb === "a" || prev?.verb === "end")) ||
      (op.verb === "tag" && prev?.verb === "end");
    if (!first && blankBefore) {
      lines.push("");
    }
    const head = first
      ? `${baseIndent}view->${op.verb}(`
      : `${indent})->${op.verb}(`;
    const body = op.args ? ` ${op.args}` : "";
    const tail = last ? " )." : "";
    const line = `${head}${body}${tail}`;
    if (line.length > MAX_LINE && op.attr) {
      // a value too long for one line is split into `&&`-joined literals
      const contIndent = indent + STEP;
      const firstHead = `${head} n = ${lit(op.attr.name)} v = `;
      const chunks = chunkValue(
        op.attr.value,
        MAX_LINE - firstHead.length - 2,
        MAX_LINE - contIndent.length - 5 - tail.length
      );
      if (chunks && chunks.length > 1) {
        lines.push(`${firstHead}${lit(chunks[0])}`);
        chunks.slice(1).forEach((chunk, cx) => {
          const end = cx === chunks.length - 2 ? tail : "";
          lines.push(`${contIndent}&& ${lit(chunk)}${end}`);
        });
        return;
      }
    }
    lines.push(line);
  });
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
