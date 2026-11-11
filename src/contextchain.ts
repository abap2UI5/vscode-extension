/*
 * The builder chain: which control an `a( )` belongs to, the write position
 * in an ABAP source, the binding being written, the view outline and the
 * control call the property editor edits.
 *
 * Split out of `context.ts`, which re-exports it - import from there.
 * `vscode`-free.
 */

import { abapStatements, blankComments, blankNonCode } from "./abapscan";
import {
  DEFAULT_LIBRARY,
  WriteContext,
  libraryOf,
  splitName,
} from "./contextnames";
import {
  Call,
  LITERAL_ALTERNATIVES,
  argLiteral,
  argNameBefore,
  argValue,
  argsOf,
  scanAbap,
  unescapeLiteral,
  writtenName,
} from "./contextscan";

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------

/**
 * The `xmlns` declarations of an ABAP-built view. The builder writes them as
 * ordinary attributes, in either of its two spellings:
 *
 *   ->a( n = `xmlns:f` v = `sap.f` )
 *   a = VALUE #( ( `xmlns:f=sap.f` ) )
 *
 * The map is keyed by prefix, `""` for the default namespace.
 */
/** Same story as the scan memo in `contextscan.ts`: both context calls of
 *  one completion ask for the namespace map of the same source. A few slots rather than one, so
 *  the colour pass and the outline of a second visible document do not evict
 *  the entry the completion is about to ask for again.
 *
 *  `abapscan.ts` memoises the LEX itself now, so what is left here is the two
 *  regex sweeps over the blanked source - still worth keeping, still not the
 *  expensive half. */
const NS_MEMO_SLOTS = 4;
const nsMemo: Array<{ source: string; map: Record<string, string> }> = [];

export function abapNsMap(source: string): Record<string, string> {
  for (let i = 0; i < nsMemo.length; i++) {
    if (nsMemo[i].source === source) {
      const [entry] = nsMemo.splice(i, 1);
      nsMemo.unshift(entry);
      return entry.map;
    }
  }
  const map = abapNsMapUncached(source);
  nsMemo.unshift({ source, map });
  if (nsMemo.length > NS_MEMO_SLOTS) {
    nsMemo.pop();
  }
  return map;
}

function abapNsMapUncached(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  // over blanked comments: a commented-out `xmlns` line is not a declaration,
  // and used to re-resolve a prefix to whatever the dead line said
  const code = blankComments(source);
  const pair =
    /n\s*=\s*[`'"]xmlns(?::([\w.]+))?[`'"]\s*v\s*=\s*[`'"]([\w.]+)[`'"]/gi;
  const flat = /[`'"]xmlns(?::([\w.]+))?=([\w.]+)[`'"]/gi;
  for (const re of [pair, flat]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      map[m[1] ?? ""] = m[2];
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// The container stack: which control a call belongs to
// ---------------------------------------------------------------------------

/** One level of the builder's nesting: the `ele( )` opened there (none on
 *  the root), and the child written last under it. */
interface Frame<T> {
  call?: T;
  lastChild?: T;
}

/**
 * The rule that says which control an `a( )` call attaches to — the builder's
 * own (and the linter's reconstruction's): the last CHILD of the open
 * container, or the container itself while it has none. `end( )` pops a
 * level, so an `a( )` after it belongs to the container that was just closed,
 * not to the last `tag( )` written — reading it lexically made completion
 * offer the tag's members where the gate validates the container's, and gave
 * the colour swatches the wrong owner.
 *
 * Fed the structural calls in source order; `owner` is the answer for an
 * attribute written at that point. Generic over what a "call" is so the
 * regex-scanning colour provider can walk its matches through the same rule
 * instead of keeping a second, lexical one.
 *
 * The second half of the rule is the HANDLE idiom every scaffolded class is
 * written in: `DATA(page) = view->ele( \`Shell\` )->ele( \`Page\` )` keeps the
 * element the chain ended on, and a later statement written on that variable
 * - `page->tag( \`Button\` )` - continues from there, not from wherever the
 * previous statement stopped. Read linearly, the Button landed inside the
 * List the previous statement had opened, completion offered the list row's
 * fields at Page level (which the gate then squiggled), and `page->a( )`
 * offered the StandardListItem's members. `beginStatement` / `endStatement`
 * are that idiom, the way the linter's reconstruction replays it: the
 * assigned variable holds the levels open at the end of its chain, and a
 * statement on it starts from a COPY of them - the levels are shared, so a
 * child added under the handle's element is seen by every later statement on
 * it, while an `ele( )` the statement descends into stays its own. A caller
 * that never calls the two gets the plain linear walk.
 */
export class ContainerStack<T> {
  private stack: Frame<T>[] = [{}];
  /** Variable (lower-cased) -> the levels open where its chain ended. */
  private handles = new Map<string, Frame<T>[]>();
  /** The variable the statement under way assigns its chain to, if any. */
  private assigns?: string;

  /**
   * A statement begins. `handle` is the variable it is written on
   * (`page->…`), `assigns` the one it assigns its chain to (`DATA(page) = …`
   * or `page = …`). A handle nothing was assigned to is not a builder - the
   * walk simply continues, and what such a statement assigns is no handle
   * either (`DATA(lv) = client->get( )` must not become one).
   */
  beginStatement(handle?: string, assigns?: string): void {
    this.endStatement();
    const held = handle ? this.handles.get(handle.toLowerCase()) : undefined;
    if (held) {
      this.stack = held.slice();
    }
    this.assigns =
      assigns && (held || !handle) ? assigns.toLowerCase() : undefined;
  }

  /** The statement under way ends: what it assigned now holds its levels. */
  endStatement(): void {
    if (this.assigns !== undefined) {
      this.handles.set(this.assigns, this.stack);
      // the next statement must not move the handle's levels along with it
      this.stack = this.stack.slice();
      this.assigns = undefined;
    }
  }

  /** One structural call: `verb` lower-cased (`ele`, `tag`, `end`, `factory`,
   *  `stringify`; anything else is ignored). `call` is what `ele` / `tag`
   *  open or add; the other verbs take none. */
  push(verb: string, call?: T): void {
    if (verb === "factory" || verb === "stringify") {
      this.stack = [{}];
    } else if (verb === "ele") {
      this.stack[this.stack.length - 1].lastChild = call;
      this.stack.push({ call });
    } else if (verb === "tag") {
      this.stack[this.stack.length - 1].lastChild = call;
    } else if (verb === "end") {
      if (this.stack.length > 1) {
        this.stack.pop();
      }
    }
  }

  /** The control an `a( )` written now belongs to, if any. */
  get owner(): T | undefined {
    const top = this.stack[this.stack.length - 1];
    return top.lastChild ?? top.call;
  }

  /** The container the chain points at - what an `ele( )` / `tag( )` written
   *  now goes into. Undefined on the root. */
  get top(): T | undefined {
    return this.stack[this.stack.length - 1].call;
  }

  /** The `ele( )` containers still open, outermost first. */
  get containers(): T[] {
    const out: T[] = [];
    for (let i = 1; i < this.stack.length; i++) {
      const call = this.stack[i].call;
      if (call !== undefined) {
        out.push(call);
      }
    }
    return out;
  }
}

/**
 * One ABAP statement of the source, with what it says about handles: the
 * variable it is written on and the one it assigns its chain to. Every
 * statement is listed - the walk below has to notice a statement boundary
 * even between two that name no handle at all.
 *
 * Read over the BLANKED source: an `->` inside a literal or a comment names
 * nothing. Both spellings of an assignment count, the inline `DATA(page) =`
 * and a plain `page =`; the chain assigned is one starting on a variable or
 * on a `factory( )`.
 */
interface ChainStatement {
  start: number;
  /** Offset of the delimiting period (or the end of the source). */
  end: number;
  handle?: string;
  assigns?: string;
}

const ASSIGNED_CHAIN =
  /^\s*(?:DATA\(\s*(\w+)\s*\)|(\w+))\s*=\s*(?:(\w+)\s*->|\w+\s*=>\s*factory\s*\()/i;
const HANDLE_CHAIN = /^\s*(\w+)\s*->/;

/** Same memo as the namespace map's: the statement table of a source is
 *  asked for by both context calls of one completion and by the outline. */
const STATEMENT_MEMO_SLOTS = 4;
const statementMemo: Array<{ source: string; statements: ChainStatement[] }> =
  [];

function chainStatements(source: string): ChainStatement[] {
  for (let i = 0; i < statementMemo.length; i++) {
    if (statementMemo[i].source === source) {
      const [entry] = statementMemo.splice(i, 1);
      statementMemo.unshift(entry);
      return entry.statements;
    }
  }
  const statements = chainStatementsUncached(source);
  statementMemo.unshift({ source, statements });
  if (statementMemo.length > STATEMENT_MEMO_SLOTS) {
    statementMemo.pop();
  }
  return statements;
}

function chainStatementsUncached(source: string): ChainStatement[] {
  const code = blankNonCode(source);
  return abapStatements(source).map((statement) => {
    const end = statement.start + statement.text.length;
    const text = code.slice(statement.start, end);
    const assigned = ASSIGNED_CHAIN.exec(text);
    if (assigned) {
      return {
        start: statement.start,
        end,
        assigns: assigned[1] ?? assigned[2],
        ...(assigned[3] ? { handle: assigned[3] } : {}),
      };
    }
    const handle = HANDLE_CHAIN.exec(text);
    return handle
      ? { start: statement.start, end, handle: handle[1] }
      : { start: statement.start, end };
  });
}

/**
 * The statement side of a walk over the calls of `source`: the function
 * returned is called with each call's offset, in source order, and begins
 * the call's statement on `stack` whenever it is a new one. The index only
 * ever moves forward, so a walk pays one pass over the statement table.
 */
function statementEntry<T>(
  source: string,
  stack: ContainerStack<T>
): (offset: number) => void {
  const statements = chainStatements(source);
  let ix = -1;
  return (offset) => {
    let moved = false;
    while (ix + 1 < statements.length && statements[ix + 1].start <= offset) {
      ix++;
      moved = true;
    }
    if (moved) {
      stack.beginStatement(statements[ix].handle, statements[ix].assigns);
    }
  };
}

/**
 * The container stack at `before`: every structural call in front of it
 * walked through {@link ContainerStack}, statement by statement so a chain
 * written on a handle starts where the handle points. The statement that
 * contains `before` itself is begun too - the `a( )` being written may be
 * the first call of `page->a( … )`, with nothing of its statement in front
 * of it.
 */
function stackBefore(
  source: string,
  calls: Call[],
  before: number
): ContainerStack<Call> {
  const stack = new ContainerStack<Call>();
  const enter = statementEntry(source, stack);
  for (const call of calls) {
    if (call.open >= before) {
      break;
    }
    enter(call.open);
    stack.push(call.name.toLowerCase(), call);
  }
  enter(before);
  return stack;
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

/** The calls that end one control's attribute run - the builder's structure,
 *  as opposed to the `a( )` calls hanging off it. One list, read by both
 *  readers of an attribute run below; it used to be written out twice. */
const STRUCTURAL = ["ele", "tag", "end", "factory", "stringify"];

/** The `a( )` calls chained to the control call at `index`: everything named
 *  `a` up to the next structural call. Index rather than the call itself, so
 *  a caller already walking `calls` does not pay an `indexOf` per control. */
function attributeCallsFrom(calls: Call[], index: number): Call[] {
  const out: Call[] = [];
  for (let i = index + 1; i < calls.length && i > 0; i++) {
    const name = calls[i].name.toLowerCase();
    if (STRUCTURAL.includes(name)) {
      break;
    }
    if (name === "a") {
      out.push(calls[i]);
    }
  }
  return out;
}

/** The `a( )` calls chained to one control call. */
function attributeCallsOf(calls: Call[], owner: Call): Call[] {
  // an owner that is not in the list leaves `indexOf` at -1, and the `i > 0`
  // guard above then answers with nothing rather than with the whole chain
  return attributeCallsFrom(calls, calls.indexOf(owner));
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
  // applies to its children, not to its own attributes. Containers a handle
  // statement left behind do not enclose the cursor either: `page->tag( )`
  // written after the List chain sits under Page, outside the List's rows.
  const ns = abapNsMap(source);
  const levels = stackBefore(source, calls, call.open);
  const owner = levels.owner;
  const containers = levels.containers.filter(
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
 * `factory( )` starts a new document - and a statement written on a handle
 * (`page->tag( \`Button\` )`) goes into the element the handle points at, see
 * {@link ContainerStack}. A long view method reads as a tree again.
 */
export function viewOutline(source: string): OutlineNode[] {
  const { calls } = scanAbap(source, source.length);
  const roots: OutlineNode[] = [];
  const stack = new ContainerStack<OutlineNode>();
  const enter = statementEntry(source, stack);

  const widenOpen = (at: number) => {
    for (const open of stack.containers) {
      open.end = Math.max(open.end, at);
    }
  };

  for (const call of calls) {
    enter(call.open);
    const name = call.name.toLowerCase();
    const endOf = call.close ?? call.open;
    if (name === "factory" || name === "stringify") {
      widenOpen(endOf);
      stack.push(name);
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
      (stack.top?.children ?? roots).push(node);
      stack.push(name, node);
      continue;
    }
    if (name === "a") {
      const current = stack.owner;
      if (current) {
        const args = argsOf(source, call);
        if (argLiteral(args, "n")?.toLowerCase() === "id") {
          current.id = argLiteral(args, "v") ?? current.id;
        }
        current.end = Math.max(current.end, endOf);
      }
      widenOpen(endOf);
      continue;
    }
    if (name === "end") {
      const closing = stack.containers.pop();
      if (closing) {
        closing.end = Math.max(closing.end, endOf);
      }
      stack.push(name);
    }
  }
  // a loop, not `Math.max(...calls)`: one argument per call of the class
  // overflowed the stack from about 120,000 calls on, and the outline threw
  let last = 0;
  for (const call of calls) {
    last = Math.max(last, call.close ?? call.open);
  }
  widenOpen(last);

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
  const m = new RegExp("\\b" + name + "\\s*=\\s*" + LITERAL_ALTERNATIVES, "i").exec(
    args
  );
  if (!m) {
    return undefined;
  }
  // the RAW written form, doubled quotes included - the span has to cover the
  // whole literal, or a rewrite leaves the tail of it in the source
  const raw = m[1] ?? m[2] ?? m[3];
  const matchEnd = call.open + 1 + m.index + m[0].length;
  return {
    start: matchEnd - 1 - raw.length,
    end: matchEnd - 1,
    quote: source[matchEnd - 1],
  };
}

/**
 * The `v = …` literal when it IS the value: nothing after it but the end of
 * the arguments or the next named one. `v = \`sap-icon://\` && mv_icon`
 * starts with a literal too, and was read as that literal alone - the
 * property editor then rewrote the first operand and kept `&& mv_icon`.
 */
function valueLiteralSpan(
  source: string,
  call: Call
): { start: number; end: number; quote: string } | undefined {
  const literal = argLiteralSpan(source, call, "v");
  if (!literal) {
    return undefined;
  }
  const rest = argsOf(source, call).slice(literal.end + 1 - (call.open + 1));
  return /^\s*(?:$|\w+\s*=)/.test(rest) ? literal : undefined;
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
  let end = call.close ?? source.length;
  while (end > start && /\s/.test(source[end - 1])) {
    end--;
  }
  return { start, end };
}

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
    const attrCalls = attributeCallsFrom(calls, i);
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
      const literal = valueLiteralSpan(source, a);
      const expression = literal ? undefined : argExpressionSpan(source, a);
      // Read unescaped, written escaped: the span covers the literal AS
      // WRITTEN (doubling included, so a rewrite replaces all of it), while
      // the value is what the literal MEANS - which is what the property
      // editor shows in a form field and re-escapes on the way back.
      const nameText = unescapeLiteral(
        source.slice(attrName.start, attrName.end),
        attrName.quote
      );
      if (literal) {
        attrs.push({
          name: nameText,
          value: unescapeLiteral(
            source.slice(literal.start, literal.end),
            literal.quote
          ),
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
      const lastLineStart = source.lastIndexOf("\n", last.open) + 1;
      if (
        newlineBeforeClose > last.open &&
        !source.slice(newlineBeforeClose + 1, anchorClose).trim()
      ) {
        appendAt = newlineBeforeClose;
      } else if (
        /^\s*(?:\)|\w+)\s*->\s*\w+\s*\($/.test(
          source.slice(lastLineStart, last.open + 1)
        )
      ) {
        /*
         * The block's last call closes on its own line - `)->a( n = \`text\`
         * v = \`x\` ).` - which is what the LAST control of every chain looks
         * like (all five templates end that way), so answering -1 here refused
         * "add attribute" on exactly that control. The call opens its line,
         * so the new line goes in front of its `)`: after the last character
         * of the call's content, before the whitespace preceding the `)`.
         */
        let end = anchorClose;
        while (end > last.open + 1 && /\s/.test(source[end - 1])) {
          end--;
        }
        appendAt = end;
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
// The write position
// ---------------------------------------------------------------------------

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
    const owner = stackBefore(source, calls, call.open).owner;
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
