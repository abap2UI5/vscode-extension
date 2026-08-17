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
      const end = text.indexOf(">", lt);
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

/** An ABAP backtick literal: the backtick escapes by doubling. */
function lit(value: string): string {
  return "`" + value.replace(/`/g, "``").replace(/\r?\n/g, " ") + "`";
}


interface Op {
  verb: "ele" | "tag" | "a" | "end";
  args: string;
  level: number;
}

/** The call arguments of an ele/tag: positional when only the name is
 *  needed (a lone `n =` trips abaplint's omit_parameter_name), named when a
 *  namespace prefix rides along. */
function elementArgs(name: string): string {
  const { prefix, local } = splitName(name);
  return prefix ? `n = ${lit(local)} ns = ${lit(prefix)}` : lit(name);
}

function emitElement(el: XmlElement, level: number, out: Op[]): void {
  if (el.children.length === 0) {
    out.push({ verb: "tag", args: elementArgs(el.name), level });
  } else {
    out.push({ verb: "ele", args: elementArgs(el.name), level });
  }
  for (const [name, value] of el.attrs) {
    out.push({ verb: "a", args: `n = ${lit(name)} v = ${lit(value)}`, level: level + 1 });
  }
  for (const child of el.children) {
    emitElement(child, level + 1, out);
  }
  if (el.children.length) {
    out.push({ verb: "end", args: "", level });
  }
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
    warnings.push(
      `${roots.length} root elements found - only the first is converted`
    );
  }
  for (const dropped of droppedText) {
    warnings.push(
      `text content has no builder equivalent and was dropped: ` +
        `"${dropped.slice(0, 60)}${dropped.length > 60 ? "…" : ""}"`
    );
  }

  const ops: Op[] = [];
  emitElement(roots[0], 0, ops);
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
    lines.push(`${head}${body}${tail}`);
  });
  lines.push("");
  lines.push(`${baseIndent}client->view_display( view->stringify( ) ).`);

  return { abap: lines.join("\n"), warnings };
}
