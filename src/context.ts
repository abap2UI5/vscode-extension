/*
 * "What is being written here?" — the position analysis behind completion and
 * hover.
 *
 * abap2UI5 views are built by chaining calls on `z2ui5_cl_ui5_view_builder`, so the
 * control a property belongs to is not lexically around the cursor the way it
 * is in XML — it sits in the `ele( )` / `tag( )` call the `a( )` is chained
 * to. Getting that relationship right is the whole job of this module:
 *
 *   view->ele( n = `VBox` )->tag( n = `Button` )->a( n = `text` v = `Hi` )
 *                                        ^ the control            ^ its member
 *
 * Raw `*.view.xml` / `*.fragment.xml` files are handled too, where the same
 * three positions are simply the tag name, an attribute name and an attribute
 * value.
 *
 * `vscode`-free by design: this is the part with the interesting edge cases,
 * and the test suite drives it directly.
 */

import { abapSpans } from "./abapscan";

/** Which of the three writable positions the cursor sits in. */
export type ContextKind = "control" | "member" | "value" | "namespace";

export interface WriteContext {
  kind: ContextKind;
  /** Library-qualified control, e.g. `sap.m.Button` — when it could be
   *  resolved. For `kind === "control"` this is what is being typed. */
  control?: string;
  /** The member whose value is being written (`kind === "value"`). */
  member?: string;
  /** The library a completed control name would land in (`kind ===
   *  "control"`), derived from the namespace in play. */
  library?: string;
  /** What is already typed inside the literal. */
  prefix: string;
  /** The literal's content span, i.e. the range a completion replaces. */
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/** The prefix an undecorated control name belongs to when the source declares
 *  no default namespace of its own — every abap2UI5 view starts from sap.m. */
export const DEFAULT_LIBRARY = "sap.m";

/**
 * The `xmlns` declarations of an ABAP-built view. The builder writes them as
 * ordinary attributes, in either of its two spellings:
 *
 *   ->a( n = `xmlns:f` v = `sap.f` )
 *   a = VALUE #( ( `xmlns:f=sap.f` ) )
 *
 * The map is keyed by prefix, `""` for the default namespace.
 */
/** Same story as the scan memo below: both context calls of one completion ask
 *  for the namespace map of the same source. */
let lastNsMap: { source: string; map: Record<string, string> } | undefined;

export function abapNsMap(source: string): Record<string, string> {
  if (lastNsMap && lastNsMap.source === source) {
    return lastNsMap.map;
  }
  const map = abapNsMapUncached(source);
  lastNsMap = { source, map };
  return map;
}

function abapNsMapUncached(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  const pair =
    /n\s*=\s*[`'"]xmlns(?::([\w.]+))?[`'"]\s*v\s*=\s*[`'"]([\w.]+)[`'"]/gi;
  const flat = /[`'"]xmlns(?::([\w.]+))?=([\w.]+)[`'"]/gi;
  for (const re of [pair, flat]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source))) {
      map[m[1] ?? ""] = m[2];
    }
  }
  return map;
}

/** The `xmlns` declarations of a raw view/fragment XML. */
export function xmlNsMap(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  const re = /xmlns(?::([\w.]+))?\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    map[m[1] ?? ""] = m[2];
  }
  return map;
}

/** Library for a namespace prefix, falling back to sap.m for the default one
 *  so a view that never declares anything still completes usefully. */
function libraryOf(map: Record<string, string>, prefix: string): string {
  return map[prefix] ?? (prefix ? "" : DEFAULT_LIBRARY);
}

/** Splits a written control name into its prefix and local name — the builder
 *  accepts `core:Icon` as well as `ns = \`core\`` + `n = \`Icon\``. */
export function splitName(name: string): { prefix: string; local: string } {
  const ix = name.indexOf(":");
  return ix > 0
    ? { prefix: name.slice(0, ix), local: name.slice(ix + 1) }
    : { prefix: "", local: name };
}

// ---------------------------------------------------------------------------
// ABAP: a one-pass scan that knows about literals, comments and call nesting
// ---------------------------------------------------------------------------

interface Call {
  name: string;
  /** Offset of the `(`. */
  open: number;
  /** Offset of the matching `)`, or undefined while still open. */
  close?: number;
}

interface Literal {
  /** Content span, i.e. between the quotes. */
  start: number;
  end: number;
}

interface AbapScan {
  /** Call stack at the cursor, innermost last. */
  stack: Call[];
  /** Every call that started before the cursor, in source order. */
  calls: Call[];
  /** The literal the cursor sits in, if any. */
  literal?: Literal;
}

/**
 * Walks the source once, over the literal/comment/template spans `abapscan.ts`
 * found and the parenthesis nesting on top of them. Everything the context
 * analysis needs comes out of this: a `tag(` inside a comment or a string
 * never becomes a control, which is exactly the confusion a plain backwards
 * regex search would produce.
 */
/*
 * One completion asks twice: `abapBindingContextAt` first (is a binding being
 * written?) and `abapContextAt` after it, both over the whole document and
 * both from scratch. Space is a trigger character, so that ran on essentially
 * every space typed in any ABAP file. The two calls are always the same text
 * at the same offset, so remembering the last answer is enough to halve it -
 * and the comparison hits the identical string, which is a pointer compare.
 *
 * The scan's Call objects are read, never written, by the callers - so handing
 * the same ones out twice is safe.
 */
let lastScan:
  | { source: string; offset: number; scan: AbapScan }
  | undefined;

function scanAbap(source: string, offset: number): AbapScan {
  if (lastScan && lastScan.offset === offset && lastScan.source === source) {
    return lastScan.scan;
  }
  const scan = scanAbapUncached(source, offset);
  lastScan = { source, offset, scan };
  return scan;
}

function scanAbapUncached(source: string, offset: number): AbapScan {
  const stack: Call[] = [];
  const calls: Call[] = [];
  let literal: Literal | undefined;
  let stackAtCursor: Call[] | undefined;

  const snapshot = () => {
    if (stackAtCursor === undefined) {
      stackAtCursor = [...stack];
    }
  };

  // The spans come out in order, so one index walks along with the scan.
  const spans = abapSpans(source);
  let nextSpan = 0;

  let i = 0;
  while (i < source.length) {
    if (stackAtCursor === undefined && i > offset) {
      snapshot();
    }

    while (nextSpan < spans.length && spans[nextSpan].to <= i) {
      nextSpan++;
    }
    const span = spans[nextSpan];
    if (span && span.from === i) {
      // The literal the cursor sits in is the one thing the scan keeps -
      // completion offers values inside it. Comments and templates are only
      // skipped: what matters is that their content is not read as code.
      if (
        span.kind === "literal" &&
        offset >= span.start &&
        offset <= span.end
      ) {
        literal = { start: span.start, end: span.end };
        snapshot();
      }
      i = Math.max(span.to, i + 1);
      continue;
    }

    const c = source[i];
    if (c === "(") {
      // The method name is the identifier run right in front of the paren.
      let k = i;
      while (k > 0 && /[A-Za-z0-9_~]/.test(source[k - 1])) {
        k--;
      }
      const call: Call = { name: source.slice(k, i), open: i };
      if (i < offset) {
        calls.push(call);
      }
      stack.push(call);
      i++;
      continue;
    }
    if (c === ")") {
      const call = stack.pop();
      if (call) {
        call.close = i;
      }
      i++;
      continue;
    }
    i++;
  }
  return { stack: stackAtCursor ?? [...stack], calls, literal };
}

/** The argument text of a call — up to its `)`, or to the end when it is the
 *  call still being written. */
function argsOf(source: string, call: Call): string {
  return source.slice(call.open + 1, call.close ?? source.length);
}

/** The literal value of a named argument, e.g. `n` in `a( n = \`text\` … )`. */
function argValue(args: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*[\`'"]([^\`'"]*)[\`'"]`, "i").exec(
    args
  );
  return m ? m[1] : undefined;
}

/** Which named argument the cursor's literal belongs to: the last `name =`
 *  in front of it inside the same call. */
function argNameBefore(source: string, from: number, to: number): string | undefined {
  const before = source.slice(from, to);
  const m = /\b(\w+)\s*=\s*[`'"]?[^`'"=]*$/.exec(before);
  return m ? m[1].toLowerCase() : undefined;
}

/** A lone literal written as the FIRST argument, with no `name =` in front of
 *  it. */
const POSITIONAL_LITERAL = /^\s*(?:`([^`]*)`|'([^']*)'|"([^"]*)")/;

/**
 * The name an `ele( )` / `tag( )` call writes, in either of the two shapes the
 * corpus uses:
 *
 *     tag( n = `Button` )     named
 *     tag( `Button` )         positional
 *
 * The positional one is not an exotic spelling: it is what the extension's own
 * XML converter emits, because a lone `n =` trips abaplint's
 * omit_parameter_name. Reading only the named form is why completion, hover
 * and the outline used to go silent on generated code - the outline even
 * labelled every such element "?".
 */
function writtenName(args: string): string | undefined {
  return (
    argLiteral(args, "n") ??
    POSITIONAL_LITERAL.exec(args)
      ?.slice(1)
      .find((value) => value !== undefined)
  );
}

/** The control an `a( )` call attaches to: the last `ele( )` / `tag( )`
 *  started before it — exactly the rule z2ui5_cl_ui5_view_builder itself follows. */
function controlCallBefore(calls: Call[], before: number): Call | undefined {
  let found: Call | undefined;
  for (const call of calls) {
    if (call.open >= before) {
      break;
    }
    const name = call.name.toLowerCase();
    if (name === "ele" || name === "tag") {
      found = call;
    }
  }
  return found;
}

/** Library-qualified control name of an `ele( )` / `tag( )` call. */
function controlOf(
  source: string,
  call: Call,
  ns: Record<string, string>
): string | undefined {
  const args = argsOf(source, call);
  const written = writtenName(args);
  if (!written) {
    return undefined;
  }
  const split = splitName(written);
  const prefix = split.prefix || argValue(args, "ns") || "";
  const library = libraryOf(ns, prefix);
  return library ? `${library}.${split.local}` : undefined;
}

// ---------------------------------------------------------------------------
// Binding paths: where a {…} is being written, and what encloses it
// ---------------------------------------------------------------------------

/** The cursor sits inside a `{…}` binding in a value literal. */
export interface BindingContext {
  /** What is already typed of the path, from after the `{`. */
  prefix: string;
  /** Span of the path written so far - the range a completion replaces. */
  start: number;
  end: number;
  /**
   * Bound aggregation paths of the `ele( )` chain around the cursor's
   * control, outermost first - `/TRAVELS`, then `SUBITEMS` for a list nested
   * in a list. A relative path resolves against the row the innermost of
   * these hands down, exactly as the linter's gate resolves it.
   */
  aggregations: string[];
}

/** A named argument's literal value, whichever quote it uses - unlike
 *  {@link argValue} it survives the other quote characters INSIDE the
 *  literal, which a complex binding (`{path: 'X'}` in a backtick literal)
 *  always has. */
function argLiteral(args: string, name: string): string | undefined {
  const m = new RegExp(
    "\\b" + name + "\\s*=\\s*(?:`([^`]*)`|'([^']*)'|\"([^\"]*)\")",
    "i"
  ).exec(args);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** The path a bound aggregation addresses, including the complex form
 *  (`{path: 'GROUPS', templateShareable: true}`). Undefined for a named
 *  model or an expression - their rows are unknown, not empty. */
function boundPathOf(value: string): string | undefined {
  const v = value.trim();
  const complex = /^\{[^}]*\bpath\s*:\s*['"]([^'"]+)['"]/.exec(v);
  if (complex) {
    return complex[1];
  }
  const plain = /^\{\s*(\/?[A-Za-z_][\w/]*)\s*\}$/.exec(v);
  return plain ? plain[1] : undefined;
}

/** The path a `v = client->_bind( x )` argument addresses - the idiomatic
 *  way an aggregation is bound. The framework derives the client path from
 *  the ABAP name itself: `me->` drops away, `-` becomes `/`, upper-cased,
 *  with a leading `/` (the same rule the linter's reconstruction applies). */
function bindCallPathOf(args: string): string | undefined {
  const m =
    /\bv\s*=\s*client->_bind(?:_edit)?\(\s*(?:val\s*=\s*)?((?:me->)?\w+(?:-\w+)*)\s*(?:path\s*=\s*abap_\w+\s*)?\)/i.exec(
      args
    );
  if (!m) {
    return undefined;
  }
  return "/" + m[1].replace(/^me->/i, "").replace(/-/g, "/").toUpperCase();
}

/**
 * The `ele( )` containers still open around `before`, outermost first.
 * Mirrors the builder's own nesting: `ele` pushes a level, `end` pops it,
 * `tag` never nests, and a fresh `factory( )` starts over.
 */
function openContainersBefore(calls: Call[], before: number): Call[] {
  const stack: Call[] = [];
  for (const call of calls) {
    if (call.open >= before) {
      break;
    }
    const name = call.name.toLowerCase();
    if (name === "factory" || name === "stringify") {
      stack.length = 0;
    } else if (name === "ele") {
      stack.push(call);
    } else if (name === "end") {
      stack.pop();
    }
  }
  return stack;
}

/** The `a( )` calls chained to one control call: everything named `a` up to
 *  the next structural call. */
function attributeCallsOf(calls: Call[], owner: Call): Call[] {
  const out: Call[] = [];
  const from = calls.indexOf(owner);
  for (let i = from + 1; i < calls.length && i > 0; i++) {
    const name = calls[i].name.toLowerCase();
    if (["ele", "tag", "end", "factory", "stringify"].includes(name)) {
      break;
    }
    if (name === "a") {
      out.push(calls[i]);
    }
  }
  return out;
}

/**
 * The binding being written at `offset`, or undefined when the cursor is not
 * inside a plain `{…}` in an `a( v = … )` literal. Named models, expression
 * bindings and the complex syntax are deliberately not completed - their
 * meaning is not the derived model's to answer.
 *
 * `isAggregation` decides whether an attribute of an enclosing container
 * establishes a row context - that needs the UI5 metadata, which this module
 * deliberately does not know.
 */
export function abapBindingContextAt(
  source: string,
  offset: number,
  isAggregation: (control: string, member: string) => boolean
): BindingContext | undefined {
  const { stack, calls, literal } = scanAbap(source, offset);
  const call = stack[stack.length - 1];
  if (!literal || !call || call.name.toLowerCase() !== "a") {
    return undefined;
  }
  if (argNameBefore(source, call.open + 1, literal.start - 1) !== "v") {
    return undefined;
  }

  // Inside an open {…}, and behind nothing but path characters.
  const typed = source.slice(literal.start, offset);
  const brace = typed.lastIndexOf("{");
  if (brace < 0 || typed.lastIndexOf("}") > brace) {
    return undefined;
  }
  const inner = typed.slice(brace + 1);
  if (/[^\w/ \t]/.test(inner)) {
    return undefined; // a named model (>), expression (=), complex syntax (:)
  }
  const prefix = inner.replace(/^[ \t]+/, "");
  const start = literal.start + brace + 1 + (inner.length - prefix.length);
  let end = offset;
  while (end < literal.end && /[\w/]/.test(source[end])) {
    end++;
  }

  // The row context: bound aggregations of the enclosing containers. The
  // cursor's own control does not enclose itself - its aggregation binding
  // applies to its children, not to its own attributes.
  const ns = abapNsMap(source);
  const owner = controlCallBefore(calls, call.open);
  const containers = openContainersBefore(calls, call.open).filter(
    (container) => container !== owner
  );
  const aggregations: string[] = [];
  for (const container of containers) {
    const control = controlOf(source, container, ns);
    if (!control) {
      continue;
    }
    for (const attr of attributeCallsOf(calls, container)) {
      const args = argsOf(source, attr);
      const member = argLiteral(args, "n");
      if (!member || !isAggregation(control, member)) {
        continue;
      }
      const value = argLiteral(args, "v");
      const path = value ? boundPathOf(value) : bindCallPathOf(args);
      if (path) {
        aggregations.push(path);
        break;
      }
    }
  }
  return { prefix, start, end, aggregations };
}

// ---------------------------------------------------------------------------
// Outline: the ele( )/tag( ) hierarchy as a tree
// ---------------------------------------------------------------------------

/** One control in the view outline. */
export interface OutlineNode {
  /** Control name as written, prefix included (`f:Card`). */
  label: string;
  /** Value of the chain's `id` attribute, when it sets one. */
  id?: string;
  /** Full span of the control's chain (including its children). */
  start: number;
  end: number;
  /** The call name itself - what selecting the symbol reveals. */
  selStart: number;
  selEnd: number;
  /** True for `ele( )` - a container. */
  container: boolean;
  children: OutlineNode[];
}

/**
 * The view hierarchy of a class, as `z2ui5_cl_ui5_view_builder` itself would
 * nest it: `ele` pushes a level, `end` pops it, `tag` never nests,
 * `factory( )` starts a new document. A long view method reads as a tree again.
 */
export function viewOutline(source: string): OutlineNode[] {
  const { calls } = scanAbap(source, source.length);
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  let current: OutlineNode | undefined; // last ele/tag, for a( ) attributes

  const attach = (node: OutlineNode) => {
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
  };
  const closeAll = (at: number) => {
    while (stack.length) {
      const node = stack.pop()!;
      node.end = Math.max(node.end, at);
    }
  };

  for (const call of calls) {
    const name = call.name.toLowerCase();
    const endOf = call.close ?? call.open;
    if (name === "factory" || name === "stringify") {
      closeAll(endOf);
      current = undefined;
      continue;
    }
    if (name === "ele" || name === "tag") {
      const args = argsOf(source, call);
      const written = writtenName(args); // named or positional
      const prefix = argLiteral(args, "ns");
      const node: OutlineNode = {
        label: written
          ? prefix && !written.includes(":")
            ? `${prefix}:${written}`
            : written
          : "?",
        start: call.open - call.name.length,
        end: endOf,
        selStart: call.open - call.name.length,
        selEnd: call.open,
        container: name === "ele",
        children: [],
      };
      attach(node);
      current = node;
      if (name === "ele") {
        stack.push(node);
      }
      continue;
    }
    if (name === "a") {
      if (current) {
        const args = argsOf(source, call);
        if (argLiteral(args, "n")?.toLowerCase() === "id") {
          current.id = argLiteral(args, "v") ?? current.id;
        }
        current.end = Math.max(current.end, endOf);
      }
      for (const open of stack) {
        open.end = Math.max(open.end, endOf);
      }
      continue;
    }
    if (name === "end") {
      const node = stack.pop();
      if (node) {
        node.end = Math.max(node.end, endOf);
      }
      current = stack[stack.length - 1];
    }
  }
  closeAll(calls.length ? Math.max(...calls.map((c) => c.close ?? c.open)) : 0);

  // A parent must span its children - an unclosed container ends where its
  // last child does.
  const widen = (node: OutlineNode): number => {
    for (const child of node.children) {
      node.end = Math.max(node.end, widen(child));
    }
    return node.end;
  };
  roots.forEach(widen);
  return roots;
}

// ---------------------------------------------------------------------------
// The control call at a position, with its written attributes - what the
// property editor reads and edits
// ---------------------------------------------------------------------------

/** One `a( )` chained to a control call, spans included so it can be edited
 *  in place. */
export interface ChainAttribute {
  name: string;
  /** The value as written: a literal's content, or the expression source. */
  value: string;
  /** True for a plain literal - the editor may rewrite its content span.
   *  False for an expression (`client->_bind( … )`, `|…|`), which the
   *  editor shows but does not rewrite. */
  literal: boolean;
  /** What a new value replaces: the literal's content span. Only set for
   *  literals. */
  valueStart?: number;
  valueEnd?: number;
  /** The a-call's `(` and its matching `)` (usually on the next chain line). */
  aOpen: number;
  aClose?: number;
}

export interface ControlCall {
  /** Control name as written, prefix included (`f:Card`). */
  label: string;
  /** Library-qualified control, when the namespace resolves. */
  control?: string;
  /** Offset of the call name - the stable anchor identifying this call. */
  tokenStart: number;
  /**
   * Where an appended `)->a( … )` line goes: the offset of the newline that
   * ends the block's last line, so inserting `\n<indent>)->a( … )` there
   * puts the new attribute before the chain line that closes the call.
   * -1 when the chain is not line-per-segment and appending is unsafe.
   */
  appendAt: number;
  /** Indent for an appended attribute line. */
  appendIndent: string;
  attrs: ChainAttribute[];
}

/** Content span of a named literal argument inside a call, with the quote. */
function argLiteralSpan(
  source: string,
  call: Call,
  name: string
): { start: number; end: number; quote: string } | undefined {
  const args = argsOf(source, call);
  const m = new RegExp(
    "\\b" + name + "\\s*=\\s*(?:`([^`]*)`|'([^']*)'|\"([^\"]*)\")",
    "i"
  ).exec(args);
  if (!m) {
    return undefined;
  }
  const value = m[1] ?? m[2] ?? m[3];
  const matchEnd = call.open + 1 + m.index + m[0].length;
  return {
    start: matchEnd - 1 - value.length,
    end: matchEnd - 1,
    quote: source[matchEnd - 1],
  };
}

/** The `v = …` argument when it is an expression, not a literal: its span
 *  from the first value character to the end of the call's arguments. */
function argExpressionSpan(
  source: string,
  call: Call
): { start: number; end: number } | undefined {
  const args = argsOf(source, call);
  const m = /\bv\s*=\s*/i.exec(args);
  if (!m) {
    return undefined;
  }
  const start = call.open + 1 + m.index + m[0].length;
  if (`'"\``.includes(source[start])) {
    return undefined; // a literal - argLiteralSpan's business
  }
  let end = call.close ?? source.length;
  while (end > start && /\s/.test(source[end - 1])) {
    end--;
  }
  return { start, end };
}

const STRUCTURAL = ["ele", "tag", "end", "factory", "stringify"];

/**
 * The `ele( )` / `tag( )` whose block (the call plus its chained `a( )`
 * lines) contains `offset`, with every attribute's spans - or undefined when
 * the cursor is not on a builder control. The last matching control wins,
 * which is the innermost one on shared lines.
 */
export function controlCallAt(
  source: string,
  offset: number
): ControlCall | undefined {
  const { calls } = scanAbap(source, source.length);
  const ns = abapNsMap(source);
  let found: ControlCall | undefined;

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const name = call.name.toLowerCase();
    if (name !== "ele" && name !== "tag") {
      continue;
    }
    const tokenStart = call.open - call.name.length;
    if (tokenStart > offset) {
      break;
    }
    // The attribute run: every `a( )` up to the next structural call.
    const attrCalls: Call[] = [];
    for (let j = i + 1; j < calls.length; j++) {
      const next = calls[j].name.toLowerCase();
      if (STRUCTURAL.includes(next)) {
        break;
      }
      if (next === "a") {
        attrCalls.push(calls[j]);
      }
    }
    const last = attrCalls[attrCalls.length - 1] ?? call;
    const blockEnd = last.close ?? source.length;
    if (offset > blockEnd) {
      continue;
    }

    const attrs: ChainAttribute[] = [];
    for (const a of attrCalls) {
      const attrName = argLiteralSpan(source, a, "n");
      if (!attrName) {
        continue;
      }
      const literal = argLiteralSpan(source, a, "v");
      const expression = literal ? undefined : argExpressionSpan(source, a);
      const nameText = source.slice(attrName.start, attrName.end);
      if (literal) {
        attrs.push({
          name: nameText,
          value: source.slice(literal.start, literal.end),
          literal: true,
          valueStart: literal.start,
          valueEnd: literal.end,
          aOpen: a.open,
          aClose: a.close,
        });
      } else if (expression) {
        attrs.push({
          name: nameText,
          value: source.slice(expression.start, expression.end),
          literal: false,
          aOpen: a.open,
          aClose: a.close,
        });
      }
    }

    // Appending is only safe in the line-per-segment style: the new line
    // slides in before the chain line whose leading `)` closes the block.
    const anchorClose = last.close;
    let appendAt = -1;
    if (anchorClose !== undefined) {
      const newlineBeforeClose = source.lastIndexOf("\n", anchorClose);
      if (newlineBeforeClose > last.open) {
        appendAt = newlineBeforeClose;
      }
    } else {
      const eol = source.indexOf("\n", last.open);
      appendAt = eol < 0 ? source.length : eol;
    }
    const anchorLineStart =
      source.lastIndexOf("\n", (attrCalls[attrCalls.length - 1] ?? call).open) + 1;
    const anchorLine = source.slice(anchorLineStart);
    const anchorIndent = anchorLine.slice(0, anchorLine.length - anchorLine.trimStart().length);
    const appendIndent = attrCalls.length ? anchorIndent : anchorIndent + "    ";

    // named or positional - see `writtenName`
    const callArgs = argsOf(source, call);
    const written = writtenName(callArgs);
    const prefix = written ? splitName(written).prefix : "";
    const nsArg = argLiteral(callArgs, "ns") ?? "";
    const library = written
      ? (ns[prefix || nsArg] ?? (prefix || nsArg ? undefined : DEFAULT_LIBRARY))
      : undefined;
    found = {
      label: written
        ? nsArg && !written.includes(":")
          ? `${nsArg}:${written}`
          : written
        : "?",
      control:
        written && library
          ? `${library}.${splitName(written).local}`
          : undefined,
      tokenStart,
      appendAt,
      appendIndent,
      attrs,
    };
  }
  return found;
}

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
 *  (any of its spellings: positional, `val =`, `_event_display`). */
export function eventNameAt(
  source: string,
  offset: number
): NamedSpan | undefined {
  const { stack, literal } = scanAbap(source, offset);
  const call = stack[stack.length - 1];
  if (!literal || !call || !/^_event\w*$/i.test(call.name)) {
    return undefined;
  }
  const name = source.slice(literal.start, literal.end);
  return name ? { name, start: literal.start, end: literal.end } : undefined;
}

/** The event name the cursor sits on inside a `WHEN '…'` of the dispatch. */
export function whenNameAt(
  source: string,
  offset: number
): NamedSpan | undefined {
  const { literal } = scanAbap(source, offset);
  if (!literal) {
    return undefined;
  }
  const before = source.slice(Math.max(0, literal.start - 20), literal.start);
  if (!/\bWHEN\s*['`]$/i.test(before)) {
    return undefined;
  }
  const name = source.slice(literal.start, literal.end);
  return name ? { name, start: literal.start, end: literal.end } : undefined;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where `WHEN '<name>'` handles the event - the offset of the literal. */
export function whenBranchOf(source: string, name: string): number | undefined {
  const m = new RegExp(`\\bWHEN\\s+(['\`])${escapeRe(name)}\\1`, "i").exec(source);
  return m ? m.index : undefined;
}

/** Every `_event( … '<name>' … )` writing the event - the view-side ends. */
export function eventUsagesOf(source: string, name: string): number[] {
  const out: number[] = [];
  const re = new RegExp(
    `_event\\w*\\([^)]*?(['\`])${escapeRe(name)}\\1`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push(m.index);
  }
  return out;
}

/** Every `WHEN '<name>'` of the source - what the usage lens hangs on. */
export function whenBranches(source: string): NamedSpan[] {
  const out: NamedSpan[] = [];
  const re = /\bWHEN\s+(['`])([\w-]+)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].indexOf(m[1]) + 1;
    out.push({ name: m[2], start, end: start + m[2].length });
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
  const call = new RegExp(
    `_event\\w*\\([^)]*?(['\`])(${escapeRe(name)})\\1`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = call.exec(source))) {
    const start = m.index + m[0].lastIndexOf(m[1] + m[2] + m[1]) + 1;
    out.push({ name, start, end: start + name.length });
  }
  for (const branch of whenBranches(source)) {
    if (branch.name.toUpperCase() === name.toUpperCase()) {
      out.push(branch);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The write position at `offset` in an ABAP source, or undefined when the
 *  cursor is not in a place the view metadata has anything to say about. */
export function abapContextAt(
  source: string,
  offset: number
): WriteContext | undefined {
  const { stack, calls, literal } = scanAbap(source, offset);
  const call = stack[stack.length - 1];
  if (!literal || !call) {
    return undefined;
  }
  const name = call.name.toLowerCase();
  const arg = argNameBefore(source, call.open + 1, literal.start - 1);
  const ns = abapNsMap(source);
  const span = { prefix: source.slice(literal.start, offset), ...literal };

  // `tag( \`Button\` )` writes the name with nothing in front of it - the
  // shape the XML converter emits, and one the cursor may just as well sit in
  const positionalName =
    arg === undefined &&
    /^\s*$/.test(source.slice(call.open + 1, literal.start - 1));

  if (name === "ele" || name === "tag") {
    if (arg === "n" || positionalName) {
      // The builder takes the namespace either as its own argument or baked
      // into the name (`core:Icon`); a prefix in the name wins, and the
      // completion then replaces only the local part.
      const written = source.slice(literal.start, literal.end);
      const inName = splitName(written);
      const prefix = inName.prefix || argValue(argsOf(source, call), "ns") || "";
      const library = libraryOf(ns, prefix);
      if (!library) {
        return undefined;
      }
      const start = literal.start + (inName.prefix ? inName.prefix.length + 1 : 0);
      return {
        kind: "control",
        library,
        prefix: source.slice(start, Math.max(start, offset)),
        start,
        end: literal.end,
      };
    }
    if (arg === "ns") {
      return { kind: "namespace", ...span };
    }
    return undefined;
  }

  if (name === "a") {
    const owner = controlCallBefore(calls, call.open);
    const control = owner ? controlOf(source, owner, ns) : undefined;
    if (!control) {
      return undefined;
    }
    if (arg === "n") {
      return { kind: "member", control, ...span };
    }
    if (arg === "v") {
      const member = argValue(argsOf(source, call), "n");
      return member ? { kind: "value", control, member, ...span } : undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Raw view / fragment XML
// ---------------------------------------------------------------------------

/**
 * The quote character of an attribute value still open at the end of `attrs`,
 * or undefined when the cursor stands between attributes. Walks rather than
 * counts, so the `"` inside `title='He said "hi"'` belongs to the value it
 * sits in instead of ending it.
 */
function unclosedQuote(attrs: string): '"' | "'" | undefined {
  let open: '"' | "'" | undefined;
  for (const ch of attrs) {
    if (open) {
      if (ch === open) {
        open = undefined;
      }
    } else if (ch === '"' || ch === "'") {
      open = ch;
    }
  }
  return open;
}

/** The write position at `offset` in a view/fragment XML. */
export function xmlContextAt(
  source: string,
  offset: number
): WriteContext | undefined {
  // The tag the cursor sits in: the last `<` not yet closed by a `>`.
  const open = source.lastIndexOf("<", offset - 1);
  if (open < 0) {
    return undefined;
  }
  const closed = source.indexOf(">", open);
  if (closed >= 0 && closed < offset) {
    return undefined; // between tags — nothing to complete
  }
  if (source[open + 1] === "/" || source[open + 1] === "!" || source[open + 1] === "?") {
    return undefined;
  }
  const ns = xmlNsMap(source);
  const tagEnd = /[\s/>]/.exec(source.slice(open + 1))?.index;
  const nameEnd = open + 1 + (tagEnd ?? offset - open - 1);

  // Inside the tag name itself.
  if (offset <= nameEnd) {
    const written = source.slice(open + 1, offset);
    const prefix = splitName(written).prefix;
    const library = libraryOf(ns, prefix);
    return library
      ? {
          kind: "control",
          library,
          prefix: splitName(written).local,
          start: open + 1 + (prefix ? prefix.length + 1 : 0),
          end: nameEnd,
        }
      : undefined;
  }

  const tagName = source.slice(open + 1, nameEnd);
  const split = splitName(tagName);
  const library = libraryOf(ns, split.prefix);
  if (!library) {
    return undefined;
  }
  const control = `${library}.${split.local}`;

  // Inside an attribute value? XML allows either quote around one, and the
  // extension's own parser accepts both - counting only `"` meant the cursor
  // in `type='Emph'` was read as an attribute NAME position, where completing
  // would have replaced the value with a property name.
  const attrs = source.slice(nameEnd, offset);
  const openQuote = unclosedQuote(attrs);
  if (openQuote) {
    const start = nameEnd + attrs.lastIndexOf(openQuote) + 1;
    const closeQuote = source.indexOf(openQuote, start);
    const member = new RegExp(
      `([\\w:.]+)\\s*=\\s*${openQuote}[^${openQuote}]*$`
    ).exec(attrs)?.[1];
    return member
      ? {
          kind: "value",
          control,
          member,
          prefix: source.slice(start, offset),
          start,
          end: closeQuote < 0 ? offset : closeQuote,
        }
      : undefined;
  }

  // Attribute name position.
  const word = /([\w:.]*)$/.exec(attrs)?.[1] ?? "";
  return {
    kind: "member",
    control,
    prefix: word,
    start: offset - word.length,
    end: offset,
  };
}
