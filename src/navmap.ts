/*
 * The app navigation map: which abap2UI5 app calls which.
 *
 * `client->nav_app_call( NEW zcl_next( ) )` is the only way one app reaches
 * another, so the workspace's ABAP sources describe a graph: apps as nodes,
 * nav calls as edges. This module extracts it, lays it out in columns (BFS
 * from the apps nothing navigates to) and renders the SVG the map view
 * shows - all `vscode`-free and covered by the test suite.
 */

import { classNameOf, isAppClassDeep } from "./abap";
import { blankNonCode } from "./abapscan";

export interface NavSource {
  fileName: string;
  source: string;
}

export interface NavNode {
  className: string;
  fileName?: string;
  /** True when the class implements z2ui5_if_app; a nav target whose source
   *  is not in the workspace stays on the map as an external node. */
  isApp: boolean;
}

export interface NavEdge {
  from: string;
  to: string;
  /** Offset of the `nav_app_call` in the FROM class's source - what an edge
   *  click jumps to. */
  offset?: number;
}

export interface NavGraph {
  nodes: NavNode[];
  edges: NavEdge[];
}

/** Words that appear inside a nav_app_call argument but never name a class. */
const NOT_A_CLASS = new Set([
  "new",
  "client",
  "me",
  "app",
  "val",
  "factory",
  "get_app_prev",
]);

/** One `nav_app_call( )` and the class it names. */
export interface NavCall {
  target: string;
  /** Offset of the call in the source. */
  offset: number;
}

/** Every nav_app_call with the class its argument names: `NEW zcl_x( )`,
 *  `zcl_x=>factory( … )` or a variable it cannot resolve (skipped).
 *
 *  Read from the BLANKED source: a commented-out navigation, or one quoted
 *  inside a toast text, used to draw a live edge on the map. Blanking keeps
 *  every offset, so the recorded position still points into the original. */
export function navCallsOf(source: string): NavCall[] {
  const calls: NavCall[] = [];
  for (const m of blankNonCode(source).matchAll(/nav_app_call\s*\(([^)]*)/gi)) {
    const arg = m[1];
    // `/dmo/cl_travel_app` counts as one word: the namespace is part of the
    // class name, and a pattern that could only start at a letter never saw
    // one of them - the `/^\//` branch below was unreachable
    for (const word of arg.matchAll(/(\/\w+\/)?\b([a-z]\w+)\b/gi)) {
      const name = (word[0].startsWith("/") ? word[0] : word[2]).toUpperCase();
      if (NOT_A_CLASS.has(word[2].toLowerCase())) {
        continue;
      }
      // Only class-looking names: the customer namespaces and z2ui5's own.
      if (/^(Z|Y|\/)/i.test(name) || /^CL_/i.test(name)) {
        calls.push({ target: name, offset: m.index ?? 0 });
        break; // the first class name is the target; the rest are arguments
      }
    }
  }
  return calls;
}

/** The distinct classes a source navigates to. */
export function navTargetsOf(source: string): string[] {
  return [...new Set(navCallsOf(source).map((call) => call.target))];
}

/** The graph over a set of sources. Nav targets without a source in the set
 *  become external nodes, so a call into the framework stays visible. */
export function navGraph(sources: NavSource[]): NavGraph {
  const nodes = new Map<string, NavNode>();
  const edges: NavEdge[] = [];

  /* An app may inherit `z2ui5_if_app` from a shared base class rather than
   * write it (issue #81), and the set handed in is exactly the place to look
   * the base class up - the map is drawn over these sources and no others. */
  const byName = new Map<string, string>();
  for (const { fileName, source } of sources) {
    byName.set(classNameOf(source, fileName), source);
  }
  // once per source - the lookup walks the inheritance chain and both loops
  // below used to ask again
  const appFlags = sources.map(({ source }) =>
    isAppClassDeep(source, (name) => byName.get(name.toUpperCase()))
  );

  sources.forEach(({ fileName, source }, ix) => {
    if (!appFlags[ix]) {
      return;
    }
    const className = classNameOf(source, fileName);
    nodes.set(className, { className, fileName, isApp: true });
  });
  const seenEdges = new Set<string>();
  sources.forEach(({ fileName, source }, ix) => {
    if (!appFlags[ix]) {
      return;
    }
    const from = classNameOf(source, fileName);
    for (const { target: to, offset } of navCallsOf(source)) {
      if (to === from) {
        continue;
      }
      if (!nodes.has(to)) {
        nodes.set(to, { className: to, isApp: false });
      }
      const key = `${from}>${to}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ from, to, offset });
      }
    }
  });
  return { nodes: [...nodes.values()], edges };
}

// ---------------------------------------------------------------------------
// Layout: BFS columns, roots (nothing navigates to them) on the left
// ---------------------------------------------------------------------------

export interface PlacedNode extends NavNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NavLayout {
  nodes: PlacedNode[];
  edges: Array<
    NavEdge & {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      /** The FROM class's file, when it is in the workspace - together with
       *  `offset` it makes the edge clickable. */
      file?: string;
    }
  >;
  width: number;
  height: number;
}

const NODE_H = 34;
const COL_GAP = 90;
const ROW_GAP = 18;
const PAD = 24;
const CHAR_W = 7.5;

export function layoutGraph(graph: NavGraph): NavLayout {
  const incoming = new Map<string, number>();
  for (const edge of graph.edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(
      edge.to
    );
  }
  // BFS depth from the roots; a cycle's nodes keep the depth they get first.
  const depth = new Map<string, number>();
  const queue: string[] = graph.nodes
    .filter((n) => !incoming.has(n.className))
    .map((n) => n.className);
  queue.forEach((name) => depth.set(name, 0));
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const to of outgoing.get(current) ?? []) {
      if (!depth.has(to)) {
        depth.set(to, (depth.get(current) ?? 0) + 1);
        queue.push(to);
      }
    }
  }
  for (const node of graph.nodes) {
    if (!depth.has(node.className)) {
      depth.set(node.className, 0); // a pure cycle - show it, column 0
    }
  }

  // Column widths from the longest name in each column.
  const columns = new Map<number, NavNode[]>();
  for (const node of graph.nodes) {
    const col = depth.get(node.className)!;
    (columns.get(col) ?? columns.set(col, []).get(col)!).push(node);
  }
  const colWidth = new Map<number, number>();
  for (const [col, nodes] of columns) {
    const widest = Math.max(...nodes.map((n) => n.className.length));
    colWidth.set(col, Math.max(120, widest * CHAR_W + 24));
  }
  const colX = new Map<number, number>();
  let x = PAD;
  for (const col of [...columns.keys()].sort((a, b) => a - b)) {
    colX.set(col, x);
    x += colWidth.get(col)! + COL_GAP;
  }

  const placed = new Map<string, PlacedNode>();
  const nodes: PlacedNode[] = [];
  let height = 0;
  for (const [col, colNodes] of columns) {
    colNodes.sort((a, b) => a.className.localeCompare(b.className));
    colNodes.forEach((node, row) => {
      const p: PlacedNode = {
        ...node,
        x: colX.get(col)!,
        y: PAD + row * (NODE_H + ROW_GAP),
        width: colWidth.get(col)!,
        height: NODE_H,
      };
      placed.set(node.className, p);
      nodes.push(p);
      height = Math.max(height, p.y + NODE_H + PAD);
    });
  }

  const edges = graph.edges.map((edge) => {
    const from = placed.get(edge.from)!;
    const to = placed.get(edge.to)!;
    return {
      ...edge,
      x1: from.x + from.width,
      y1: from.y + from.height / 2,
      x2: to.x,
      y2: to.y + to.height / 2,
      file: from.fileName,
    };
  });

  return {
    nodes,
    edges,
    width: Math.max(x - COL_GAP + PAD, 200),
    height: Math.max(height, 100),
  };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The map as an SVG string. Styling rides on CSS classes (`node`, `ext`,
 * `edge`) so the webview's theme-variable stylesheet colours it; every app
 * node carries `data-file` so a click can open the class.
 */
export function navMapSvg(layout: NavLayout): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" ` +
      `height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`
  );
  parts.push(
    `<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" ` +
      `markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
      `<path d="M0 0 8 4 0 8z"/></marker></defs>`
  );
  for (const edge of layout.edges) {
    const midX = (edge.x1 + edge.x2) / 2;
    // the calling class and the call's offset ride along, so a click on the
    // edge can open the nav_app_call itself
    const jump =
      edge.file && typeof edge.offset === "number"
        ? ` data-file="${escapeXml(edge.file)}" data-offset="${edge.offset}"`
        : "";
    // a <title> child is SVG's native tooltip - where edges cross, hovering
    // says which navigation this one is
    const label = `${edge.from} -> ${edge.to}`;
    parts.push(
      `<path class="edge"${jump} d="M${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ` +
        `${midX} ${edge.y2}, ${edge.x2 - 2} ${edge.y2}" marker-end="url(#arrow)">` +
        `<title>${escapeXml(label)}</title></path>`
    );
  }
  for (const node of layout.nodes) {
    const cls = node.isApp ? "node" : "node ext";
    const file = node.fileName ? ` data-file="${escapeXml(node.fileName)}"` : "";
    const hint = node.fileName
      ? `${node.className} (click to open the class)`
      : `${node.className} (source not in this workspace)`;
    parts.push(
      `<g class="${cls}"${file}><title>${escapeXml(hint)}</title>` +
        `<rect x="${node.x}" y="${node.y}" rx="6" ` +
        `width="${node.width}" height="${node.height}"/>` +
        `<text x="${node.x + node.width / 2}" y="${node.y + node.height / 2 + 4}" ` +
        `text-anchor="middle">${escapeXml(node.className)}</text></g>`
    );
  }
  parts.push("</svg>");
  return parts.join("");
}
