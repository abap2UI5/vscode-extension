/*
 * VENDORED - do not edit. abap2UI5/mcp-server lib/viewxml.mjs
 * at commit 6bd3cc3a79e99f8027fb0b62cc968f4161bf1118,
 * copied by scripts/vendor-agent.mjs (`npm run agent-vendor`); the only
 * change is the sibling imports ending in .js. `npm run agent-vendor:check`
 * fails when this copy drifts from that commit. Change it upstream, then
 * re-vendor.
 */
/*
 * viewxml — the three small parsers the agent snapshot (lib/snapshot.mjs)
 * stands on, kept apart from it so each is tested on its own:
 *
 *   parseViewXml(xml)        an abap2UI5 view or fragment -> element tree with
 *                            RESOLVED namespaces (xmlns="sap.m" + <Input> is
 *                            sap.m.Input), entities decoded, text kept
 *   parseBinding(value)      a UI5 property value -> literal, path binding,
 *                            composite text or expression binding
 *   parseWire(value)         an event handler the backend wrote
 *                            (`.eB(['SAVE'], ${NAME})`, `.eBP($event, true,
 *                            [...])`, `.eF('CONTROL_GLOBAL', ...)`) -> event
 *                            name and argument descriptors
 *   evalExpression(src, get) a UI5 expression binding body (`${/X} === 'A'`)
 *                            evaluated over the model, WITHOUT eval: a tiny
 *                            parser for the operators views actually use, and
 *                            `undefined` for anything else
 *
 * Why not the linter's parseXml: it drops text nodes and leaves namespaces as
 * prefixes - right for its property gate, not enough to name a control - and
 * the snapshot must work where no linter resolves (the app tools need a
 * backend, not the linter). Nothing here imports anything.
 */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decode the five XML entities and numeric character references. */
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

/*
 * The element tree. Every element is
 *   { tag, prefix, local, ns, attrs: { name: value }, children: [], text }
 * where `ns` is the namespace URI its prefix resolves to (UI5 uses library
 * names as URIs: `sap.m`, `sap.ui.layout.form`, `z2ui5.cc`). Lenient on
 * purpose: a closing tag pops whatever is open - the backend wrote this XML
 * and the browser already accepted it; the snapshot describes it, it does not
 * judge it.
 */
export function parseViewXml(xml) {
  const src = String(xml || '');
  const root = { tag: '#document', prefix: '', local: '#document', ns: '', attrs: {}, children: [], text: '', nsMap: {} };
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      appendText(stack[stack.length - 1], src.slice(i));
      break;
    }
    if (lt > i) appendText(stack[stack.length - 1], src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      const body = src.slice(lt + 9, end < 0 ? src.length : end);
      stack[stack.length - 1].text += body;
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    // an opening tag: name, then attributes up to the unquoted '>'
    let j = lt + 1;
    while (j < src.length && !/[\s/>]/.test(src[j])) j += 1;
    const tag = src.slice(lt + 1, j);
    const attrs = {};
    let selfClose = false;
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (j >= src.length) break;
      if (src[j] === '>') { j += 1; break; }
      if (src[j] === '/' && src[j + 1] === '>') { selfClose = true; j += 2; break; }
      let k = j;
      while (k < src.length && !/[\s=/>]/.test(src[k])) k += 1;
      const name = src.slice(j, k);
      j = k;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      let value = '';
      if (src[j] === '=') {
        j += 1;
        while (j < src.length && /\s/.test(src[j])) j += 1;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          value = src.slice(j + 1, end < 0 ? src.length : end);
          j = end < 0 ? src.length : end + 1;
        } else {
          let e = j;
          while (e < src.length && !/[\s>]/.test(src[e])) e += 1;
          value = src.slice(j, e);
          j = e;
        }
      }
      if (name) attrs[name] = decodeEntities(value);
      if (!name) j += 1; // a stray character: step over it rather than loop
    }
    const parent = stack[stack.length - 1];
    const nsMap = { ...parent.nsMap };
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'xmlns') nsMap[''] = value;
      else if (name.startsWith('xmlns:')) nsMap[name.slice(6)] = value;
    }
    const colon = tag.indexOf(':');
    const prefix = colon < 0 ? '' : tag.slice(0, colon);
    const local = colon < 0 ? tag : tag.slice(colon + 1);
    const node = { tag, prefix, local, ns: nsMap[prefix] ?? '', attrs, children: [], text: '', nsMap };
    parent.children.push(node);
    if (!selfClose) stack.push(node);
    i = j;
  }
  return root;
}

function appendText(node, raw) {
  const t = decodeEntities(raw);
  if (t.trim()) node.text += t;
}

/** An element whose local name starts lower-case is an AGGREGATION of its
 *  parent (`<content>`, `<headerToolbar>`), not a control - the XML view
 *  convention UI5 itself parses by. */
export const isAggregation = (node) => /^[a-z]/.test(node.local);

/** The full control name: namespace URI + local name (`sap.m.Input`). */
export const controlName = (node) => (node.ns ? `${node.ns}.${node.local}` : node.local);

// ------------------------------------------------------------- bindings ----

/*
 * Split a property value into literal text and `{...}` binding parts, the way
 * the UI5 binding parser does: braces nest, quotes inside a binding hide
 * braces, and `\{` / `\}` are escaped literal braces.
 */
function splitBindingParts(value) {
  const s = String(value);
  const parts = [];
  let lit = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === '{' || s[i + 1] === '}' || s[i + 1] === '\\')) {
      lit += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '{') {
      let depth = 0;
      let quote = null;
      let j = i;
      for (; j < s.length; j += 1) {
        const d = s[j];
        if (quote) {
          if (d === '\\') { j += 1; continue; }
          if (d === quote) quote = null;
          continue;
        }
        if (d === '"' || d === "'") { quote = d; continue; }
        if (d === '{') depth += 1;
        else if (d === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j >= s.length) { // unbalanced: the rest is text
        lit += s.slice(i);
        break;
      }
      if (lit) parts.push({ text: lit });
      lit = '';
      parts.push({ binding: s.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    lit += c;
    i += 1;
  }
  if (lit) parts.push({ text: lit });
  return parts;
}

const SIMPLE_PATH = /^\s*(?:([A-Za-z_][\w.-]*)>)?(\/?[\w$/.-]*)\s*$/;

/** One `{...}` body -> { path, model, relative, type } or { expression } or
 *  { computed } (parts/formatter bindings the snapshot cannot evaluate). */
function bindingInfo(body) {
  const b = String(body).trim();
  if (b.startsWith('=') || b.startsWith(':=')) return { expression: b.replace(/^:?=/, '') };
  const simple = SIMPLE_PATH.exec(b);
  if (simple && simple[2] !== '') {
    return { path: simple[2], model: simple[1] || '', relative: !simple[2].startsWith('/') };
  }
  // object syntax: { path: '/X', type: '...', formatter: '...' }
  if (/^\s*parts\s*:/.test(b) || /[,{\s]parts\s*:/.test(` ${b}`)) return { computed: b };
  const p = /(?:^|[,{\s])path\s*:\s*(['"])(.*?)\1/.exec(b);
  if (p) {
    const m = /^(?:([A-Za-z_][\w.-]*)>)?(.*)$/.exec(p[2]);
    const type = (/(?:^|[,{\s])type\s*:\s*(['"])(.*?)\1/.exec(b) || [])[2] || '';
    const formatter = /(?:^|[,{\s])formatter\s*:/.test(b);
    return { path: m[2], model: m[1] || '', relative: !m[2].startsWith('/'), type, formatter };
  }
  return { computed: b };
}

/*
 * A property value, classified:
 *   { kind: 'literal', value }                     no binding at all
 *   { kind: 'path', path, model, relative, type }  exactly one binding, nothing around it
 *   { kind: 'expression', expression }             `{= ... }`
 *   { kind: 'composite', parts }                   text and bindings mixed, or parts/formatter
 */
export function parseBinding(value) {
  if (value === undefined || value === null) return { kind: 'literal', value: undefined };
  const parts = splitBindingParts(value);
  const bindings = parts.filter((p) => p.binding !== undefined);
  if (!bindings.length) return { kind: 'literal', value: parts.map((p) => p.text).join('') };
  if (parts.length === 1) {
    const info = bindingInfo(bindings[0].binding);
    if (info.expression !== undefined) return { kind: 'expression', expression: info.expression };
    if (info.path !== undefined && !info.formatter) return { kind: 'path', ...info };
    return { kind: 'composite', parts: [info.path !== undefined ? info : { computed: info.computed || bindings[0].binding }] };
  }
  return {
    kind: 'composite',
    parts: parts.map((p) => (p.binding !== undefined ? bindingInfo(p.binding) : { text: p.text })),
  };
}

// ---------------------------------------------------------- expressions ----

/*
 * A UI5 expression binding body, evaluated over a getter for `${path}`
 * references. Supported: `${path}` (any model path the getter answers),
 * string/number literals, true/false/null/undefined, `!`, unary `-`, the
 * comparison and equality operators, `&&`, `||`, `? :`, parentheses and
 * `.length`. Anything else - a function call, a formatter, `odata.*` - makes
 * the whole expression `undefined`, which every caller reads as "unknown".
 * No eval, no Function: the view XML is app data.
 */
export function evalExpression(src, get) {
  let tokens;
  try {
    tokens = tokenizeExpression(String(src));
  } catch {
    return undefined;
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const UNKNOWN = Symbol('unknown');
  const parsePrimary = () => {
    const t = take();
    if (!t) throw new Error('end');
    if (t.type === 'ref') return get(t.value);
    if (t.type === 'str' || t.type === 'num') return t.value;
    if (t.type === 'word') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      if (t.value === 'undefined') return undefined;
      throw new Error('word');
    }
    if (t.value === '(') {
      const v = parseTernary();
      if (!take() || tokens[pos - 1].value !== ')') throw new Error('paren');
      return v;
    }
    if (t.value === '!') return !parsePostfix();
    if (t.value === '-') return -parsePostfix();
    throw new Error('token');
  };
  const parsePostfix = () => {
    let v = parsePrimary();
    while (peek() && peek().value === '.') {
      take();
      const name = take();
      if (!name || name.type !== 'word' || name.value !== 'length') throw new Error('member');
      v = v === undefined || v === null ? undefined : v.length;
    }
    return v;
  };
  const BIN = [
    ['||'], ['&&'], ['===', '!==', '==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%'],
  ];
  const parseBinary = (level) => {
    if (level >= BIN.length) return parsePostfix();
    let left = parseBinary(level + 1);
    while (peek() && peek().type === 'op' && BIN[level].includes(peek().value)) {
      const op = take().value;
      const right = parseBinary(level + 1);
      left = applyOp(op, left, right);
    }
    return left;
  };
  const parseTernary = () => {
    const cond = parseBinary(0);
    if (peek() && peek().value === '?') {
      take();
      const a = parseTernary();
      if (!take() || tokens[pos - 1].value !== ':') throw new Error('ternary');
      const b = parseTernary();
      return cond ? a : b;
    }
    return cond;
  };
  try {
    const v = parseTernary();
    if (pos !== tokens.length) return undefined;
    return v === UNKNOWN ? undefined : v;
  } catch {
    return undefined;
  }
}

function applyOp(op, a, b) {
  switch (op) {
    case '||': return a || b;
    case '&&': return a && b;
    // eslint-disable-next-line eqeqeq
    case '==': return a == b;
    // eslint-disable-next-line eqeqeq
    case '!=': return a != b;
    case '===': return a === b;
    case '!==': return a !== b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    default: throw new Error(op);
  }
}

function tokenizeExpression(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i);
      if (end < 0) throw new Error('ref');
      const body = s.slice(i + 2, end).trim();
      // object syntax inside an expression: ${path: '/X', ...}
      const p = /^path\s*:\s*(['"])(.*?)\1/.exec(body);
      out.push({ type: 'ref', value: p ? p[2] : body });
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = '';
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\\') { v += s[j + 1]; j += 2; continue; }
        v += s[j];
        j += 1;
      }
      if (j >= s.length) throw new Error('string');
      out.push({ type: 'str', value: v });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(s.slice(i));
      out.push({ type: 'num', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][\w]*/.exec(s.slice(i));
      out.push({ type: 'word', value: m[0] });
      i += m[0].length;
      continue;
    }
    const three = s.slice(i, i + 3);
    const two = s.slice(i, i + 2);
    if (three === '===' || three === '!==') { out.push({ type: 'op', value: three }); i += 3; continue; }
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { out.push({ type: 'op', value: two }); i += 2; continue; }
    if ('<>+-*/%'.includes(c)) { out.push({ type: 'op', value: c }); i += 1; continue; }
    if ('!?:().'.includes(c)) { out.push({ type: 'punct', value: c }); i += 1; continue; }
    throw new Error(`char ${c}`);
  }
  return out;
}

// ---------------------------------------------------------------- wires ----

/*
 * Split a JS argument list at top-level commas: quotes, (), [] and {} nest.
 */
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\') { cur += s[i + 1] ?? ''; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ('([{'.includes(c)) depth += 1;
    if (')]}'.includes(c)) depth -= 1;
    if (c === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A single-quoted (or double-quoted) JS string literal -> its value, or null. */
function jsString(s) {
  const m = /^(['"])([\s\S]*)\1$/.exec(String(s).trim());
  if (!m) return null;
  return m[2].replace(/\\(n|r|t|\\|'|")/g, (x, e) => ({ n: '\n', r: '\r', t: '\t' }[e] ?? e));
}

/*
 * One argument of a wire, described:
 *   { static: true, value }                         a quoted literal
 *   { static: false, kind: 'row', path }            ${REL}       - the row's (or bound element's) property
 *   { static: false, kind: 'model', path }          ${/ABS}      - the model, read at act time
 *   { static: false, kind: 'source', prop }         ${$source>/text} - the control's own property
 *   { static: false, kind: 'parameters', path }     ${$parameters>/selectedItem}
 *   { static: false, kind: 'event' }                $event
 *   { static: false, kind: 'expr', raw }            anything else: an expression only a browser evaluates
 * `describe` is the contract's string form ("$row:VALUE", "$source:text", ...).
 */
export function describeArg(raw) {
  const s = String(raw).trim();
  const str = jsString(s);
  if (str !== null) return { static: true, value: str };
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return { static: true, value: Number(s) };
  if (s === 'true' || s === 'false') return { static: true, value: s === 'true' };
  const ref = /^\$\{([^{}]*)\}$/.exec(s);
  if (ref) {
    const body = ref[1].trim();
    const src = /^\$source>\/?(.+)$/.exec(body);
    if (src) return { static: false, kind: 'source', prop: src[1], describe: `$source:${src[1]}` };
    const par = /^\$parameters>\/?(.*)$/.exec(body);
    if (par) return { static: false, kind: 'parameters', path: par[1], describe: `$parameters:${par[1]}` };
    if (/^\/[\w/.$-]*$/.test(body)) return { static: false, kind: 'model', path: body, describe: `$model:${body}` };
    if (/^[A-Za-z_][\w/.$-]*$/.test(body)) return { static: false, kind: 'row', path: body, describe: `$row:${body}` };
  }
  if (s === '$event') return { static: false, kind: 'event', describe: '$event' };
  return { static: false, kind: 'expr', raw: s, describe: `$expr:${s}` };
}

/*
 * An event handler the backend wrote into a view attribute:
 *   { fn: 'eB', event, flags: [...], args: [descriptor...] }
 *   { fn: 'eF', action, args: [descriptor...] }
 * or null when the value is no abap2UI5 wire. `.eBP($event, cond, [...], ...)`
 * is eB behind a preventDefault and is reported as fn 'eB'.
 */
export function parseWire(value) {
  const s = String(value || '').trim();
  const m = /^\.?(eB|eBP|eF)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(s);
  if (!m) return null;
  let args = splitArgs(m[2]);
  if (m[1] === 'eF') {
    const action = jsString(args[0] || '');
    if (action === null) return null;
    return { fn: 'eF', action, args: args.slice(1).map(describeArg) };
  }
  if (m[1] === 'eBP') args = args.slice(2);
  const head = /^\[([\s\S]*)\]$/.exec(args[0] || '');
  if (!head) return null;
  const inner = splitArgs(head[1]);
  const event = jsString(inner[0] || '');
  if (event === null) return null;
  return { fn: 'eB', event, flags: inner.slice(1), args: args.slice(1).map(describeArg) };
}
