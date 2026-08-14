/*
 * Pretty-printer for the view trees the linter reconstructs out of an ABAP
 * class (`prepareAbap( ).nodes`).
 *
 * The linter's own `toXml( )` serialises for machines - one line, no
 * whitespace - because its output feeds `XMLView.create`. "Show Reconstructed
 * XML View" shows the same tree to a person, so this module owns the
 * presentation: indentation, one attribute per line once they stop fitting,
 * the namespace declarations first. The linter stays the one source of what
 * the tree contains.
 *
 * The reconstruction records on every node and attribute the offset of the
 * builder call that wrote it (and scrub( ) is offset-preserving, so those are
 * offsets into the class as it stands). The formatter carries them through as
 * a line -> source-offset map, which is what makes the XML clickable: a line
 * knows the `ele( )` / `tag( )` / `a( )` it came from.
 *
 * `vscode`-free: nodes in, string out - covered by the test suite.
 */

import type { ViewNode } from "@abap2ui5/linter/reconstruct";

const INDENT = "  ";

/** Attributes short enough for this stay on the element's line. */
const ONE_LINE_ATTRS = 72;

function escapeAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#xA;")
    .replace(/\r/g, "&#xD;")
    .replace(/\t/g, "&#x9;");
}

/** One attribute as the formatter sees it: xmlns first, offsets along. */
interface Attr {
  text: string;
  offset?: number;
}

function sortedAttrs(node: ViewNode): Attr[] {
  const all = node.attrs.map((attr) => ({
    text: `${attr[0]}="${escapeAttr(attr[1])}"`,
    offset: typeof attr[2] === "number" ? attr[2] : undefined,
    ns: attr[0] === "xmlns" || attr[0].startsWith("xmlns:"),
  }));
  return [...all.filter((a) => a.ns), ...all.filter((a) => !a.ns)];
}

export interface FormattedXml {
  text: string;
  /** For each line of `text`: the offset (into the ABAP source) of the
   *  builder call the line renders, where the reconstruction recorded one. */
  lineOffsets: Array<number | undefined>;
}

interface Out {
  lines: string[];
  offsets: Array<number | undefined>;
}

function push(out: Out, line: string, offset: number | undefined): void {
  out.lines.push(line);
  out.offsets.push(offset);
}

function formatNode(node: ViewNode, depth: number, out: Out): void {
  // The synthetic root the reconstruction wraps a document in.
  if (node.name === null) {
    for (const child of node.children) {
      formatNode(child, depth, out);
    }
    return;
  }
  const pad = INDENT.repeat(depth);
  const name = node.ns ? `${node.ns}:${node.name}` : node.name;
  const attrs = sortedAttrs(node);
  const oneLine = attrs.map((a) => a.text).join(" ");
  const close = node.children.length ? ">" : "/>";

  if (!attrs.length) {
    push(out, `${pad}<${name}${close}`, node.offset);
  } else if (pad.length + name.length + oneLine.length <= ONE_LINE_ATTRS) {
    push(out, `${pad}<${name} ${oneLine}${close}`, node.offset);
  } else {
    push(out, `${pad}<${name}`, node.offset);
    const attrPad = pad + INDENT.repeat(2);
    attrs.forEach((attr, ix) => {
      const last = ix === attrs.length - 1;
      push(out, `${attrPad}${attr.text}${last ? close : ""}`, attr.offset ?? node.offset);
    });
  }

  for (const child of node.children) {
    formatNode(child, depth + 1, out);
  }
  if (node.children.length) {
    push(out, `${pad}</${name}>`, node.offset);
  }
}

/**
 * Everything a class builds, as one XML document with the line -> source
 * mapping. More than one view (a class assembling a popup next to its main
 * view) is separated by a comment naming which is which.
 */
export function formatDocument(
  nodes: ViewNode[],
  className: string
): FormattedXml {
  const out: Out = { lines: [], offsets: [] };
  push(
    out,
    `<!-- ${className}: the view(s) reconstructed from the z2ui5_cl_ui5_view_builder ` +
      `builder calls - what the abap2UI5 view check validates. Read-only, ` +
      `regenerated as the class changes. Go to Definition jumps to the ` +
      `builder call. -->`,
    undefined
  );
  nodes.forEach((node, ix) => {
    push(out, "", undefined);
    if (nodes.length > 1) {
      push(out, `<!-- view ${ix + 1} of ${nodes.length} -->`, node.offset);
    }
    formatNode(node, 0, out);
  });
  push(out, "", undefined);
  return { text: out.lines.join("\n"), lineOffsets: out.offsets };
}

/** One reconstructed view, indented for reading. */
export function prettyXml(node: ViewNode): string {
  const out: Out = { lines: [], offsets: [] };
  formatNode(node, 0, out);
  return out.lines.join("\n");
}

/** The document as a plain string - what the tests pin down. */
export function prettyDocument(nodes: ViewNode[], className: string): string {
  return formatDocument(nodes, className).text;
}
