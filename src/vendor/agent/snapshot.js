/*
 * VENDORED - do not edit. abap2UI5/mcp-server lib/snapshot.mjs
 * at commit 4be038e9b2516387e04265994d8d5d205d71d1fe,
 * copied by scripts/vendor-agent.mjs (`npm run agent-vendor`); the only
 * change is the sibling imports ending in .js. `npm run agent-vendor:check`
 * fails when this copy drifts from that commit. Change it upstream, then
 * re-vendor.
 */
/*
 * snapshot — what is on an abap2UI5 screen, as data an agent can act on.
 *
 * The browser's UI5 frontend turns a backend response into controls; this
 * module turns the same response into "agent snapshot v1" (docs/agent-
 * snapshot.md, shared with the VS Code extension and the ABAP agent addon):
 * the fields an agent may fill (with their model paths, labels, kinds and
 * current values), the actions it may fire (the `.eB([...])` wires, with
 * their static and dynamic arguments), the tables (columns, the first rows,
 * selection), the messages (toast, box, strip, field value states) and some
 * static text for context - from the view XML of every open slot plus the
 * JSON model, with no browser and no CSS selector.
 *
 * Two pure halves:
 *
 *   applyResponse(state, response)  the frontend's bookkeeping across
 *                                   roundtrips: which slot holds which view
 *                                   (MAIN/NEST/NEST2/POPUP/POPOVER), which
 *                                   app owns which model, what the last
 *                                   response asked the client to show
 *                                   (core/actions/Slots.js is the original)
 *   analyzeScreen({ state, ... })   that state -> { snapshot, index }; the
 *                                   index is what lib/appclient.mjs needs to
 *                                   validate and perform an act (which model
 *                                   a field writes into, how a dynamic event
 *                                   argument resolves) and never leaves it
 *
 * buildSnapshot({ response, ... }) is the one-call form the contract names.
 *
 * Optional `metadata`: the linter's UI5 control snapshot (`@abap2ui5/linter/
 * properties` loadSnapshot()). With it a control this module has no entry for
 * inherits the entry of its nearest mapped ancestor (a MaskInput subclass is
 * a text field because sap.m.InputBase is); without it the explicit table
 * below is the whole knowledge. The snapshot never needs the linter.
 */
import { parseViewXml, isAggregation, controlName, parseBinding, evalExpression, parseWire } from './viewxml.js';

export const SNAPSHOT_VERSION = 1;
export const DEFAULT_MAX_ROWS = 20;
export const MAX_ROWS_LIMIT = 200;
const MAX_TEXTS = 30;
const MAX_UNSUPPORTED = 30;
const MAX_VALUES = 100;
const TEXT_MAX_LEN = 200;

/* The two frontend-only wires the client performs itself: closing the popup
 * or the popover (`_event_client( cs_event-popup_close )`, which the backend
 * writes as eF('CONTROL_GLOBAL','VIEW_SLOTS','destroy','POPUP')). The `@`
 * keeps them apart from every backend event name. */
export const FRONTEND_EVENTS = { POPUP: '@CLOSE_POPUP', POPOVER: '@CLOSE_POPOVER' };

// ------------------------------------------------------------ the state ----

export function emptyState() {
  return { app: '', id: '', slots: {}, models: {}, custom: [] };
}

const MODEL_OWNING = ['MAIN', 'POPUP', 'POPOVER'];
/** MAIN and the nested slots share one model; popup and popover own a copy. */
export const modelKeyOf = (slot) => (slot === 'POPUP' || slot === 'POPOVER' ? slot : 'MAIN');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function asArray(item) {
  if (Array.isArray(item)) return item;
  if (typeof item === 'string') {
    try {
      const v = JSON.parse(item);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }
  return null;
}

function destroySlot(next, slot) {
  delete next.slots[slot];
  if (slot === 'MAIN') {
    delete next.slots.NEST;
    delete next.slots.NEST2;
  }
  if (slot === 'POPUP' || slot === 'POPOVER') delete next.models[slot];
}

/*
 * One response folded into the state, the way the frontend folds it:
 *   - every VIEW_SLOTS action of T_SYSTEM in order (a MAIN display tears
 *     down the nested views, the popup and the popover - the backend sends
 *     no destroy for them next to a MAIN display);
 *   - a displayed slot gets its model from this response; a MODEL key in
 *     the response is pushed into every OPEN slot whose model belongs to the
 *     app that answered (a popup app's model must not overwrite the caller's
 *     view behind it - updateModelIfRequired);
 *   - T_CUSTOM is kept as the last response's client work (toasts, boxes),
 *     and a CONTROL_GLOBAL VIEW_SLOTS destroy in it is applied too.
 * A response without MODEL leaves every model as it was: the backend only
 * sends what changed, and the client keeps what the user typed.
 */
export function applyResponse(state, response) {
  const prev = state || emptyState();
  const next = { app: prev.app, id: prev.id, slots: { ...prev.slots }, models: { ...prev.models }, custom: [] };
  const front = (response && response.S_FRONT) || {};
  if (front.APP) next.app = front.APP;
  if (front.ID) next.id = front.ID;
  const hasModel = response && response.MODEL !== undefined;
  const data = hasModel ? response.MODEL : {};
  const actions = front.S_ACTION || {};
  const displayed = new Set();
  for (const raw of actions.T_SYSTEM || []) {
    const a = asArray(raw);
    if (!a || a[0] !== 'VIEW_SLOTS') continue;
    const [, method, slot, xml, options] = a;
    if (method === 'destroy') {
      destroySlot(next, slot);
    } else if (method === 'display') {
      if (slot === 'MAIN') {
        for (const s of ['MAIN', 'POPUP', 'POPOVER']) destroySlot(next, s);
      }
      next.slots[slot] = { xml: String(xml || ''), app: next.app, options: options || {} };
      const key = modelKeyOf(slot);
      if (slot === key || !next.models[key]) {
        next.models[key] = { app: next.app, data: clone(data) || {} };
        displayed.add(key);
      }
    }
  }
  for (const raw of actions.T_CUSTOM || []) {
    const a = asArray(raw);
    if (!a) continue;
    const b = a[0] === 'CONTROL_GLOBAL' ? a.slice(1) : a;
    if (b[0] === 'VIEW_SLOTS' && b[1] === 'destroy') {
      destroySlot(next, b[2]);
      continue;
    }
    next.custom.push(a);
  }
  if (hasModel) {
    for (const key of MODEL_OWNING) {
      const m = next.models[key];
      if (!m || displayed.has(key)) continue;
      if (!m.app || m.app === next.app) next.models[key] = { app: m.app || next.app, data: clone(data) };
    }
  }
  return next;
}

// --------------------------------------------------------- model access ----

const segments = (p) => String(p).split('/').filter((s) => s !== '');

export function getAt(data, p) {
  let cur = data;
  for (const seg of segments(p)) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setAt(data, p, value) {
  const segs = segments(p);
  let cur = data;
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (cur[segs[i]] === null || typeof cur[segs[i]] !== 'object') cur[segs[i]] = /^\d+$/.test(segs[i + 1]) ? [] : {};
    cur = cur[segs[i]];
  }
  cur[segs[segs.length - 1]] = value;
}

/** "/MS_HEAD/KUNNR" -> "MS_HEAD-KUNNR"; the old two-way prefix /XX/ is not
 *  part of the attribute's name. */
export function nameOfPath(p) {
  const segs = segments(p);
  if (segs[0] === 'XX' && segs.length > 1) segs.shift();
  return segs.join('-');
}

// --------------------------------------------------------- control maps ----

/* The editable value of each input-like control: which property carries it,
 * and what kind of value it is. `textLabel`: the control's own `text` names
 * it when nothing else does (a CheckBox "Accept terms"). */
const FIELD_SPECS = {
  'sap.m.Input': { props: ['value'], kind: (n) => inputKind(n.attrs.type) },
  'sap.m.InputBase': { props: ['value'], kind: 'text' },
  'sap.m.TextArea': { props: ['value'], kind: 'textarea' },
  'sap.m.MaskInput': { props: ['value'], kind: 'text' },
  'sap.m.SearchField': { props: ['value'], kind: 'text' },
  'sap.m.MultiInput': { props: ['value'], kind: 'text' },
  'sap.m.StepInput': { props: ['value'], kind: 'number' },
  'sap.m.Slider': { props: ['value'], kind: 'number' },
  'sap.m.RangeSlider': { props: ['value'], kind: 'number' },
  'sap.m.RatingIndicator': { props: ['value'], kind: 'number' },
  'sap.m.DatePicker': { props: ['value', 'dateValue'], kind: 'date' },
  'sap.m.DateRangeSelection': { props: ['value', 'dateValue'], kind: 'date' },
  'sap.m.TimePicker': { props: ['value', 'dateValue'], kind: 'time' },
  'sap.m.DateTimePicker': { props: ['value', 'dateValue'], kind: 'datetime' },
  'sap.m.CheckBox': { props: ['selected'], kind: 'boolean', textLabel: true },
  'sap.m.Switch': { props: ['state'], kind: 'boolean' },
  'sap.m.ToggleButton': { props: ['pressed'], kind: 'boolean', textLabel: true },
  'sap.m.RadioButton': { props: ['selected'], kind: 'boolean', textLabel: true },
  'sap.m.Select': { props: ['selectedKey'], kind: 'choice', items: 'key' },
  'sap.m.ComboBox': { props: ['selectedKey', 'value'], kind: 'choice', items: 'key' },
  'sap.m.MultiComboBox': { props: ['selectedKeys'], kind: 'multichoice', items: 'key' },
  'sap.m.SegmentedButton': { props: ['selectedKey'], kind: 'choice', items: 'key' },
  'sap.m.RadioButtonGroup': { props: ['selectedIndex'], kind: 'choice', items: 'index' },
};

function inputKind(type) {
  switch (String(type || '')) {
    case 'Number': return 'number';
    case 'Date': return 'date';
    case 'Time': return 'time';
    case 'DateTime': return 'datetime';
    default: return 'text';
  }
}

/** A model type in a binding refines the kind (`type: 'sap.ui.model.type.Integer'`). */
function kindFromType(type) {
  if (!type) return null;
  if (/Integer|Float|Decimal|Currency|Unit/.test(type)) return 'number';
  if (/DateTime/.test(type)) return 'datetime';
  if (/Time/.test(type)) return 'time';
  if (/Date/.test(type)) return 'date';
  if (/Boolean/.test(type)) return 'boolean';
  return null;
}

/* The list controls whose bound aggregation is a table of rows. */
const TABLE_SPECS = {
  'sap.m.Table': { agg: 'items', kind: 'm' },
  'sap.m.List': { agg: 'items', kind: 'm' },
  'sap.m.Tree': { agg: 'items', kind: 'm' },
  'sap.m.GridList': { agg: 'items', kind: 'm' },
  'sap.m.ListBase': { agg: 'items', kind: 'm' },
  'sap.ui.table.Table': { agg: 'rows', kind: 'ui' },
  'sap.ui.table.TreeTable': { agg: 'rows', kind: 'ui' },
  'sap.ui.table.AnalyticalTable': { agg: 'rows', kind: 'ui' },
};

/* Controls whose text is context worth handing an agent (outside tables). */
const TEXT_PROPS = {
  'sap.m.Text': ['text'],
  'sap.m.Title': ['text'],
  'sap.m.ObjectStatus': ['title', 'text'],
  'sap.m.ObjectAttribute': ['title', 'text'],
  'sap.m.ObjectIdentifier': ['title', 'text'],
  'sap.m.ObjectNumber': ['number', 'unit'],
  'sap.m.ObjectHeader': ['title', 'number'],
  'sap.m.FormattedText': ['htmlText'],
  'sap.m.ExpandableText': ['text'],
  'sap.m.GenericTag': ['text'],
  'sap.ui.core.Title': ['text'],
  'sap.m.IllustratedMessage': ['title', 'description'],
};

/* Controls that title their layer (Dialog/Popover first, then the page). */
const TITLED = new Set(['sap.m.Dialog', 'sap.m.Popover', 'sap.m.ResponsivePopover', 'sap.m.Page', 'sap.m.semantic.FullscreenPage', 'sap.m.Shell']);

/* An event that only fires when a flag shows its trigger. */
const EVENT_GATE = { navButtonPress: 'showNavButton', valueHelpRequest: 'showValueHelp' };

/* Row events that live on the TABLE but fire for one row. */
const ROW_EVENTS_ON_TABLE = new Set(['itemPress', 'selectionChange', 'rowSelectionChange', 'cellClick', 'rowPress', 'delete', 'beforeOpenContextMenu']);

/* Aggregations of a grid table that are templated per row (a row's action
 * buttons, its highlight) - their wires are row actions. */
const ROW_TEMPLATES = new Set(['rowActionTemplate', 'rowSettingsTemplate']);

/* Client work in T_CUSTOM that changes nothing an agent reads. */
const BENIGN_CUSTOM = new Set(['SET_FOCUS', 'SCROLL_TO', 'SCROLL_INTO_VIEW', 'SET_SIZE_LIMIT', 'SET_TITLE', 'SET_FAVICON', 'BUSY_INDICATOR', 'ROUTER', 'ICON_POOL', 'THEMING', 'FORMATTING', 'POPUP', 'SET_TITLE_LAUNCHPAD']);

const MESSAGE_TYPES = { Error: 'error', Warning: 'warning', Success: 'success', Information: 'info' };

function lookupSpec(table, name, metadata) {
  if (table[name]) return table[name];
  if (!metadata || !/^sap\./.test(name)) return null;
  let cur = metadata[name];
  for (let guard = 0; cur && cur.parent && guard < 30; guard += 1) {
    if (table[cur.parent]) return table[cur.parent];
    cur = metadata[cur.parent];
  }
  return null;
}

const isLabel = (name) => name === 'sap.m.Label';
const iconName = (src) => (src ? String(src).replace(/^sap-icon:\/\/(?:[^/]+\/)?/, '').replace(/-/g, ' ') : '');
const clip = (s, n = TEXT_MAX_LEN) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
};
const stripTags = (s) => String(s).replace(/<[^>]*>/g, ' ');

// ----------------------------------------------------------- the walker ----

/*
 * The screen, analysed. `state` is the folded slot state (applyResponse);
 * `pending` lists the model paths the client changed and has not sent yet.
 */
export function analyzeScreen({ state, response, app, session, maxRows = DEFAULT_MAX_ROWS, metadata = null, pending = [] } = {}) {
  const st = state || applyResponse(emptyState(), response);
  const rowsLimit = Math.max(0, Math.min(MAX_ROWS_LIMIT, Number.isFinite(Number(maxRows)) ? Math.floor(Number(maxRows)) : DEFAULT_MAX_ROWS));
  const layers = [];
  if (st.slots.POPUP) {
    layers.push({ layer: 'popup', slot: 'POPUP' });
  } else {
    for (const slot of ['MAIN', 'NEST', 'NEST2']) if (st.slots[slot]) layers.push({ layer: 'main', slot });
  }
  if (st.slots.POPOVER) layers.push({ layer: 'popover', slot: 'POPOVER' });
  const topmost = st.slots.POPOVER ? 'popover' : st.slots.POPUP ? 'popup' : 'main';

  const out = { fields: [], actions: [], tables: [], messages: [], texts: [], unsupported: [], titles: {} };
  const index = { fields: new Map(), actions: new Map(), tables: new Map() };
  const seenTexts = new Set();
  const seenUnsupported = new Set();
  const managerMessages = [];
  const note = (s) => {
    if (seenUnsupported.has(s) || out.unsupported.length >= MAX_UNSUPPORTED) return;
    seenUnsupported.add(s);
    out.unsupported.push(s);
  };
  const addText = (s) => {
    const t = clip(s);
    if (!t || seenTexts.has(t) || out.texts.length >= MAX_TEXTS) return;
    seenTexts.add(t);
    out.texts.push(t);
  };

  for (const { layer, slot } of layers) {
    const key = modelKeyOf(slot);
    const model = st.models[key] || { data: {} };
    const root = parseViewXml(st.slots[slot].xml);
    const labelFor = collectLabelFor(root, model.data);
    const ctx = { layer, slot, modelKey: key, data: model.data || {}, row: null, label: null, where: [], labelFor };
    walkChildren(root.children, ctx);
  }

  // the app's message table (z2ui5.cc.MessageManager): a TARGET that is a
  // field's path points at that field - resolved once every field is known
  for (const m of managerMessages) {
    const f = m.target ? out.fields.find((x) => x.path === m.target) : null;
    const msg = { type: m.type, text: m.text, source: m.target ? 'field' : 'model' };
    if (f) msg.field = f.id;
    else if (m.target) msg.field = m.target;
    out.messages.push(msg);
  }

  // what the last response asked the client to do besides the views
  for (const raw of st.custom || []) {
    const a = raw[0] === 'CONTROL_GLOBAL' ? raw.slice(1) : raw;
    const [target, method, text, options] = a;
    if (target === 'MESSAGE_TOAST') {
      out.messages.push({ type: 'info', text: clip(text ?? '', 1000), source: 'toast' });
      if (options && typeof options.onClose === 'string' && options.onClose) {
        pushAction({ event: options.onClose, args: [], label: 'toast closed', control: 'sap.m.MessageToast', trigger: 'close', enabled: true, scope: 'screen', layer: topmost }, { wire: { args: [] } });
      }
    } else if (target === 'MESSAGE_BOX') {
      const type = { error: 'error', warning: 'warning', success: 'success', information: 'info' }[method] || 'info';
      out.messages.push({ type, text: clip(text ?? '', 1000), source: 'box' });
      if (options && typeof options.onClose === 'string' && options.onClose) {
        const choices = Array.isArray(options.actions) && options.actions.length
          ? options.actions.map(String)
          : (method === 'confirm' ? ['OK', 'CANCEL'] : ['OK']);
        pushAction({ event: options.onClose, args: ['$action'], label: `close message box (${choices.join(' | ')})`, control: 'sap.m.MessageBox', trigger: 'close', enabled: true, scope: 'screen', layer: topmost },
          { wire: { args: [{ static: false, kind: 'action', describe: '$action' }] }, choices });
      }
    } else if (target === 'START_TIMER' && typeof method === 'string' && method) {
      pushAction({ event: method, args: [], label: `timer (${Number(text) || 0} ms)`, control: 'timer', trigger: 'timer', enabled: true, scope: 'screen', layer: topmost }, { wire: { args: [] } });
    } else if (!BENIGN_CUSTOM.has(target)) {
      note(`frontend action ${clip(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' '), 120)} (runs in the browser only, not performed)`);
    }
  }

  const title = out.titles[topmost] || out.titles.main || '';
  const snapshot = {
    snapshotVersion: SNAPSHOT_VERSION,
    session: session ?? st.id ?? '',
    app: app || st.app || '',
    title,
    layer: topmost,
    fields: out.fields,
    actions: out.actions,
    tables: out.tables,
    messages: out.messages,
    texts: out.texts.filter((t) => t !== title && !out.tables.some((tb) => tb.label === t)),
    unsupported: out.unsupported,
  };
  if (pending && pending.length) snapshot.pending = [...pending];
  return { snapshot, index };

  // ---------------------------------------------------------- helpers ----

  function pushAction(action, extra) {
    const id = `a${out.actions.length + 1}`;
    const rec = { id, ...action };
    if (rec.scope !== 'row') delete rec.table;
    out.actions.push(rec);
    index.actions.set(id, { action: rec, ...extra });
    return rec;
  }

  function resolveRef(ref, ctx, rowData) {
    const r = String(ref).trim();
    if (/^[A-Za-z_][\w.-]*>/.test(r)) return undefined; // a named model
    if (r.startsWith('/')) return getAt(ctx.data, r);
    if (rowData !== undefined && rowData !== null) return getAt(rowData, r);
    return undefined;
  }

  /** A property value resolved: { value, b } (b = the parsed binding). */
  function resolve(raw, ctx, rowData) {
    const b = parseBinding(raw);
    if (b.kind === 'literal') return { value: b.value, b };
    if (b.kind === 'path') {
      return { value: b.model ? undefined : (b.relative ? resolveRef(b.path, ctx, rowData) : getAt(ctx.data, b.path)), b };
    }
    if (b.kind === 'expression') return { value: evalExpression(b.expression, (ref) => resolveRef(ref, ctx, rowData)), b };
    let known = false;
    const text = b.parts.map((p) => {
      if (p.text !== undefined) return p.text;
      if (p.path !== undefined && !p.model && !p.formatter) {
        const v = p.relative ? resolveRef(p.path, ctx, rowData) : getAt(ctx.data, p.path);
        if (v !== undefined && v !== null) {
          known = true;
          return String(v);
        }
      }
      return '';
    }).join('');
    return { value: known || b.parts.every((p) => p.text !== undefined) ? text : undefined, b };
  }

  /** A boolean property: literal, bound or an expression; `dflt` when unknown. */
  function bool(raw, ctx, rowData, dflt) {
    if (raw === undefined) return dflt;
    const { value } = resolve(raw, ctx, rowData);
    if (value === undefined || value === null) return dflt;
    if (typeof value === 'string') {
      if (value === 'true') return true;
      if (value === 'false' || value === '') return false;
      return dflt;
    }
    return Boolean(value);
  }

  function textOf(raw, ctx, rowData) {
    if (raw === undefined) return '';
    const { value } = resolve(raw, ctx, rowData);
    return value === undefined || value === null ? '' : String(value);
  }

  function walkChildren(children, ctx) {
    let label = ctx.label;
    for (const child of children) {
      if (!isAggregation(child)) {
        const name = controlName(child);
        if (isLabel(name) && !child.attrs.labelFor) {
          if (!bool(child.attrs.visible, ctx, undefined, true)) continue;
          label = { text: textOf(child.attrs.text, ctx), required: bool(child.attrs.required, ctx, undefined, false) };
          continue;
        }
        if (name === 'sap.ui.core.Title' || name === 'sap.m.Title' || /Toolbar$/.test(name)) label = null;
      }
      walk(child, { ...ctx, label });
    }
  }

  function walk(node, ctx) {
    if (isAggregation(node)) {
      walkChildren(node.children, ctx);
      return;
    }
    const name = controlName(node);
    const a = node.attrs;
    if (name === 'sap.ui.core.mvc.View' || name === 'sap.ui.core.FragmentDefinition') {
      walkChildren(node.children, ctx);
      return;
    }
    if (!bool(a.visible, ctx, undefined, true)) return;
    const where = [...ctx.where, node.local];
    const c = { ...ctx, where };

    if (TITLED.has(name) && a.title !== undefined && !out.titles[ctx.layer]) {
      const t = textOf(a.title, ctx);
      if (t) out.titles[ctx.layer] = clip(t);
    }
    if (name === 'sap.f.DynamicPageTitle' && !out.titles[ctx.layer]) {
      const heading = findFirst(node, (n) => controlName(n) === 'sap.m.Title');
      if (heading) {
        const t = textOf(heading.attrs.text, ctx);
        if (t) out.titles[ctx.layer] = clip(t);
      }
    }

    if (!/^sap\./.test(node.ns || '')) {
      if (node.ns === 'z2ui5.cc' && node.local === 'MessageManager') {
        messageManager(node, c);
        return;
      }
      note(`custom control ${name} (${ctx.layer}: ${where.slice(-3).join(' > ')}) - not described`);
      wires(node, c, name);
      walkChildren(node.children, c);
      return;
    }
    if (name === 'sap.ui.core.HTML') {
      note(`raw HTML (sap.ui.core.HTML, ${ctx.layer}: ${where.slice(-3).join(' > ')}) - not described`);
      return;
    }

    const tableSpec = lookupSpec(TABLE_SPECS, name, metadata);
    if (tableSpec && !ctx.row) {
      table(node, c, name, tableSpec);
      return;
    }

    if (name === 'sap.ui.layout.form.FormElement') {
      let label = null;
      if (a.label !== undefined) label = { text: textOf(a.label, ctx), required: false };
      const labelAgg = node.children.find((n) => n.local === 'label');
      const labelCtl = labelAgg && labelAgg.children.find((n) => !isAggregation(n));
      if (labelCtl) label = { text: textOf(labelCtl.attrs.text, ctx), required: bool(labelCtl.attrs.required, ctx, undefined, false) };
      for (const agg of node.children) {
        if (agg.local === 'label') continue;
        walk(agg, { ...c, label });
      }
      return;
    }

    if (name === 'sap.m.MessageStrip') {
      const text = textOf(a.text, ctx);
      if (text) out.messages.push({ type: MESSAGE_TYPES[textOf(a.type, ctx) || 'Information'] || 'info', text: clip(text, 1000), source: 'strip' });
      wires(node, c, name);
      return;
    }

    const fieldSpec = lookupSpec(FIELD_SPECS, name, metadata);
    let fieldRec = null;
    if (fieldSpec && !ctx.row) fieldRec = field(node, c, name, fieldSpec);
    if (!fieldSpec && !ctx.row && TEXT_PROPS[name]) {
      const parts = TEXT_PROPS[name].map((p) => textOf(a[p], ctx)).filter(Boolean);
      let t = parts.join(' ');
      if (name === 'sap.m.FormattedText') t = stripTags(t);
      if (t) addText(ctx.label && ctx.label.text ? `${ctx.label.text}: ${t}` : t);
    }
    wires(node, c, name, fieldRec);
    // the items of a choice control are its values, not controls to walk
    if (fieldSpec && fieldSpec.items) return;
    walkChildren(node.children, c);
  }

  function findFirst(node, pred) {
    for (const ch of node.children) {
      if (!isAggregation(ch) && pred(ch)) return ch;
      const hit = findFirst(ch, pred);
      if (hit) return hit;
    }
    return null;
  }

  function labelOf(node, ctx, spec) {
    const a = node.attrs;
    if (a.id && ctx.labelFor.has(a.id)) return ctx.labelFor.get(a.id).text;
    if (ctx.label && ctx.label.text) {
      // one form label over several fields (a SimpleForm row "Name" with a
      // first and a last name input): the placeholder tells them apart
      ctx.label.uses = (ctx.label.uses || 0) + 1;
      const ph = ctx.label.uses > 1 ? textOf(a.placeholder, ctx) : '';
      return ph ? `${ctx.label.text} (${ph})` : ctx.label.text;
    }
    if (spec && spec.textLabel && a.text) {
      const t = textOf(a.text, ctx);
      if (t) return t;
    }
    for (const p of ['placeholder', 'tooltip', 'ariaLabel', 'title']) {
      const t = textOf(a[p], ctx);
      if (t) return t;
    }
    return '';
  }

  function field(node, ctx, name, spec) {
    const a = node.attrs;
    const prop = spec.props.find((p) => a[p] !== undefined);
    if (!prop) return null;
    const { value, b } = resolve(a[prop], ctx);
    if (b.kind !== 'path') return null; // a literal or computed value: nothing to fill
    if (b.model) {
      note(`field ${node.local} bound to the named model '${b.model}' (${ctx.layer}) - not editable here`);
      return null;
    }
    if (b.relative) {
      note(`field ${node.local} bound relatively ({${b.path}}, ${ctx.layer}: element binding) - not editable here`);
      return null;
    }
    const lbl = labelOf(node, ctx, spec);
    const kind = kindFromType(b.type) || (typeof spec.kind === 'function' ? spec.kind(node) : spec.kind);
    const editable = bool(a.editable, ctx, undefined, true) && bool(a.enabled, ctx, undefined, true) && !bool(a.displayOnly, ctx, undefined, false);
    const required = bool(a.required, ctx, undefined, false)
      || Boolean(a.id && ctx.labelFor.has(a.id) && ctx.labelFor.get(a.id).required)
      || Boolean(ctx.label && ctx.label.required);
    const id = `f${out.fields.length + 1}`;
    const rec = {
      id,
      path: b.path,
      name: nameOfPath(b.path),
      label: clip(lbl || nameOfPath(b.path), 120),
      control: name,
      kind,
      value: value === undefined ? null : value,
      required,
      editable,
    };
    if (spec.items) {
      const vals = choiceValues(node, ctx, spec);
      if (vals) {
        if (vals.length > MAX_VALUES) note(`field ${id} (${rec.label}): ${vals.length} choices, the first ${MAX_VALUES} listed`);
        rec.values = vals.slice(0, MAX_VALUES);
      }
    }
    rec.layer = ctx.layer;
    out.fields.push(rec);
    index.fields.set(id, { field: rec, modelKey: ctx.modelKey, node });
    const vs = textOf(a.valueState, ctx);
    if (MESSAGE_TYPES[vs]) {
      out.messages.push({ type: MESSAGE_TYPES[vs], text: clip(textOf(a.valueStateText, ctx) || `${rec.label}: ${vs}`, 1000), source: 'field', field: id });
    }
    return rec;
  }

  function itemControls(node, aggName) {
    const agg = node.children.find((n) => n.local === aggName);
    const pool = agg ? agg.children : node.children;
    return pool.filter((n) => !isAggregation(n));
  }

  function choiceValues(node, ctx, spec) {
    const items = itemControls(node, spec.items === 'index' ? 'buttons' : 'items');
    if (spec.items === 'index') {
      return items.map((it, i) => ({ key: i, text: textOf(it.attrs.text, ctx) }));
    }
    const bound = node.attrs.items !== undefined ? parseBinding(node.attrs.items) : null;
    const bpath = bound && (bound.kind === 'path' ? bound : (bound.parts || []).find((p) => p.path !== undefined));
    if (bpath && bpath.path && !bpath.model && !bpath.relative) {
      const rows = getAt(ctx.data, bpath.path);
      const tmpl = items[0];
      if (!Array.isArray(rows) || !tmpl) return null;
      return rows.map((row) => {
        const text = textOf(tmpl.attrs.text, ctx, row);
        const k = tmpl.attrs.key !== undefined ? textOf(tmpl.attrs.key, ctx, row) : text;
        return { key: k, text };
      });
    }
    if (!items.length) return null;
    return items.map((it) => {
      const text = textOf(it.attrs.text, ctx);
      return { key: it.attrs.key !== undefined ? textOf(it.attrs.key, ctx) : text, text };
    });
  }

  /* Every attribute that carries an abap2UI5 wire: an action (eB/eBP), one
   * of the two popup closes the client performs itself, or a note that a
   * frontend-only action exists here. */
  function wires(node, ctx, name, fieldRec, { only = null, label: labelOverride = null } = {}) {
    for (const [attr, raw] of Object.entries(node.attrs)) {
      if (only && attr !== only) continue;
      if (!/\.(eB|eBP|eF)\s*\(/.test(raw)) continue;
      const wire = parseWire(raw);
      if (!wire) {
        note(`event ${attr} on ${node.local} (${ctx.layer}) - a handler this client cannot read`);
        continue;
      }
      const gate = EVENT_GATE[attr];
      if (gate && !bool(node.attrs[gate], ctx, undefined, false)) continue;
      const label = labelOverride || actionLabel(node, ctx, name, attr, fieldRec);
      const enabled = bool(node.attrs.enabled, ctx, undefined, true);
      const scope = ctx.row ? 'row' : 'screen';
      if (wire.fn === 'eF') {
        const st = wire.args.map((x) => (x.static ? String(x.value) : null));
        if (wire.action === 'CONTROL_GLOBAL' && st[0] === 'VIEW_SLOTS' && st[1] === 'destroy' && FRONTEND_EVENTS[st[2]]) {
          pushAction({ event: FRONTEND_EVENTS[st[2]], args: [], label, control: name, trigger: attr, enabled, scope, table: ctx.row && ctx.row.tableId, layer: ctx.layer },
            { wire, node, modelKey: ctx.modelKey, frontend: st[2], tableId: ctx.row && ctx.row.tableId });
        } else {
          note(`frontend action ${wire.action}(${wire.args.map((x) => (x.static ? JSON.stringify(x.value) : x.describe)).join(', ')}) on ${node.local} "${clip(label, 60)}" (${ctx.layer}) - runs in the browser only`);
        }
        continue;
      }
      pushAction({
        event: wire.event,
        args: wire.args.map((x) => (x.static ? x.value : x.describe)),
        label,
        control: name,
        trigger: attr,
        enabled,
        scope,
        table: ctx.row && ctx.row.tableId,
        layer: ctx.layer,
      }, { wire, node, modelKey: ctx.modelKey, tableId: ctx.row && ctx.row.tableId });
    }
  }

  function actionLabel(node, ctx, name, attr, fieldRec) {
    const a = node.attrs;
    if (attr === 'navButtonPress') return 'Back';
    if (fieldRec) return `${fieldRec.label}: ${attr}`;
    if (lookupSpec(FIELD_SPECS, name, metadata) && !ctx.row) {
      const l = labelOf(node, ctx, lookupSpec(FIELD_SPECS, name, metadata));
      if (l) return `${clip(l, 80)}: ${attr}`;
    }
    for (const p of ['text', 'title', 'tooltip', 'headerText', 'ariaLabel']) {
      // in a row template a bound text differs per row: not a label
      if (a[p] === undefined || (ctx.row && parseBinding(a[p]).kind !== 'literal')) continue;
      const t = textOf(a[p], ctx);
      if (t) return clip(t, 80);
    }
    if (a.icon && parseBinding(a.icon).kind === 'literal') return iconName(a.icon);
    if (ctx.row && a.type && parseBinding(a.type).kind === 'literal') return `row ${attr} (${a.type})`;
    if (ctx.row) return `row ${attr}`;
    return attr;
  }

  function messageManager(node, ctx) {
    const b = parseBinding(node.attrs.items);
    if (b.kind !== 'path' || b.model || b.relative) return;
    const rows = getAt(ctx.data, b.path);
    if (!Array.isArray(rows)) return;
    for (const r of rows) {
      const get = (k) => r[k] ?? r[k.toLowerCase()] ?? r[k[0] + k.slice(1).toLowerCase()];
      const text = get('MESSAGE');
      if (!text) continue;
      const type = MESSAGE_TYPES[get('TYPE')] || 'info';
      managerMessages.push({ type, text: clip(text, 1000), target: get('TARGET') || '' });
    }
  }

  // ----------------------------------------------------------- tables ----

  function table(node, ctx, name, spec) {
    const a = node.attrs;
    const bound = a[spec.agg] !== undefined ? parseBinding(a[spec.agg]) : null;
    const bpath = bound && (bound.kind === 'path' ? bound : (bound.parts || []).find((p) => p.path !== undefined));
    if (!bpath || !bpath.path || bpath.model || bpath.relative) {
      if (bound) note(`${node.local} bound to ${bpath && bpath.model ? `the named model '${bpath.model}'` : 'something other than a model table'} (${ctx.layer}) - rows not described`);
      wires(node, ctx, name);
      walkChildren(node.children, ctx);
      return;
    }
    const tableId = `t${out.tables.length + 1}`;
    const label = textOf(a.headerText, ctx) || textOf(a.title, ctx) || headerTitle(node, ctx) || nameOfPath(bpath.path);
    const rowsData = getAt(ctx.data, bpath.path);
    const rows = Array.isArray(rowsData) ? rowsData : [];

    // the template: the one control of the bound aggregation
    let template = null;
    let columnsNodes = [];
    if (spec.kind === 'm') {
      const agg = node.children.find((n) => n.local === spec.agg);
      template = (agg ? agg.children : node.children).find((n) => !isAggregation(n)) || null;
      const colAgg = node.children.find((n) => n.local === 'columns');
      columnsNodes = colAgg ? colAgg.children.filter((n) => !isAggregation(n)) : [];
    } else {
      const colAgg = node.children.find((n) => n.local === 'columns');
      columnsNodes = colAgg ? colAgg.children.filter((n) => !isAggregation(n)) : node.children.filter((n) => !isAggregation(n) && /Column$/.test(n.local));
    }

    // cells: [{ node, header }]
    const cells = [];
    if (spec.kind === 'm' && template) {
      const cellAgg = template.children.find((n) => n.local === 'cells');
      if (cellAgg || controlName(template) === 'sap.m.ColumnListItem') {
        const cellNodes = (cellAgg ? cellAgg.children : template.children).filter((n) => !isAggregation(n));
        cellNodes.forEach((cn, i) => cells.push({ node: cn, header: columnHeader(columnsNodes[i], ctx), visible: columnsNodes[i] ? bool(columnsNodes[i].attrs.visible, ctx, undefined, true) : true }));
      } else {
        // a list item: its bound properties are the columns
        for (const [attr, raw] of Object.entries(template.attrs)) {
          if (['selected', 'type', 'visible', 'highlight', 'unread', 'counter', 'navigated', 'id', 'class'].includes(attr)) continue;
          if (/\.(eB|eBP|eF)\s*\(/.test(raw)) continue;
          const b = parseBinding(raw);
          if (b.kind === 'path' && b.relative && !b.model) cells.push({ node: template, prop: attr, header: attr, visible: true });
          else if (b.kind === 'composite' && b.parts.some((p) => p.path && p.relative)) cells.push({ node: template, prop: attr, header: attr, visible: true });
        }
        if (!cells.length) {
          // a CustomListItem: the bound controls inside it
          for (const cn of descendants(template)) {
            const p = mainProp(cn);
            if (p) cells.push({ node: cn, prop: p, header: p, visible: true });
          }
        }
      }
    } else if (spec.kind === 'ui') {
      for (const col of columnsNodes) {
        const tAgg = col.children.find((n) => n.local === 'template');
        const tNode = tAgg ? tAgg.children.find((n) => !isAggregation(n)) : null;
        if (!tNode) continue;
        let header = col.attrs.label !== undefined ? textOf(col.attrs.label, ctx) : '';
        if (!header) {
          // the label aggregation, written out or as the column's default one
          const lAgg = col.children.find((n) => n.local === 'label');
          const lNode = (lAgg ? lAgg.children : col.children).find((n) => !isAggregation(n));
          if (lNode) header = textOf(lNode.attrs.text, ctx);
        }
        cells.push({ node: tNode, header, visible: bool(col.attrs.visible, ctx, undefined, true) });
      }
    }

    const columns = [];
    const cellSpecs = new Map();
    const used = new Set();
    cells.forEach((cell, i) => {
      if (!cell.visible) return;
      const cn = cell.node;
      const prop = cell.prop || mainProp(cn);
      const b = prop ? parseBinding(cn.attrs[prop]) : null;
      let colName = b && b.kind === 'path' && b.relative && !b.model ? b.path : `COL${i + 1}`;
      if (used.has(colName)) colName = `${colName}_${i + 1}`;
      used.add(colName);
      columns.push({ name: colName, label: clip(cell.header || colName, 80) });
      const cname = controlName(cn);
      const fspec = cell.prop ? null : lookupSpec(FIELD_SPECS, cname, metadata);
      cellSpecs.set(colName, { node: cn, prop, binding: b, fieldSpec: fspec });
    });

    // selection
    let selectionMode = 'None';
    if (spec.kind === 'm') {
      const mode = textOf(a.mode, ctx) || 'None';
      selectionMode = /Multi/.test(mode) ? 'Multi' : /Single/.test(mode) ? 'Single' : 'None';
    } else {
      const mode = a.selectionMode !== undefined ? textOf(a.selectionMode, ctx) : 'MultiToggle';
      selectionMode = /Multi/.test(mode) ? 'Multi' : /Single/.test(mode) ? 'Single' : 'None';
    }
    let selectionField = null;
    if (template && template.attrs.selected !== undefined) {
      const sb = parseBinding(template.attrs.selected);
      if (sb.kind === 'path' && sb.relative && !sb.model) selectionField = sb.path;
    }

    // editable cells: an input bound to a row property, not disabled for every row
    const editableCells = [];
    for (const [colName, cs] of cellSpecs) {
      if (!cs.fieldSpec || !cs.binding || cs.binding.kind !== 'path' || !cs.binding.relative || cs.binding.model) continue;
      const okFor = (row) => bool(cs.node.attrs.editable, ctx, row, true) && bool(cs.node.attrs.enabled, ctx, row, true) && !bool(cs.node.attrs.displayOnly, ctx, row, false);
      const probe = rows.length ? rows : [undefined];
      if (probe.some(okFor)) editableCells.push(colName);
      cs.editableFor = okFor;
    }
    if (selectionMode === 'None') selectionField = null;
    if (selectionField && !editableCells.includes(selectionField)) editableCells.push(selectionField);

    const shown = rows.slice(0, rowsLimit).map((row) => {
      const r = {};
      for (const [colName, cs] of cellSpecs) {
        if (!cs.prop) {
          r[colName] = null;
          continue;
        }
        const { value } = resolve(cs.node.attrs[cs.prop], ctx, row);
        r[colName] = value === undefined ? null : value;
      }
      if (selectionField && !(selectionField in r)) r[selectionField] = row ? (row[selectionField] ?? null) : null;
      return r;
    });
    const rec = {
      id: tableId,
      path: bpath.path,
      name: nameOfPath(bpath.path),
      label: clip(label, 120),
      control: name,
      columns,
      rowCount: rows.length,
      rows: shown,
      truncated: rows.length > shown.length,
      selectionMode,
      editableCells,
      layer: ctx.layer,
    };
    if (selectionField) rec.selectionField = selectionField;
    out.tables.push(rec);
    index.tables.set(tableId, { table: rec, path: bpath.path, modelKey: ctx.modelKey, cellSpecs, selectionField, ctx });

    // the table's own events: a row event on the table is row scope
    for (const [attr, raw] of Object.entries(a)) {
      if (!/\.(eB|eBP|eF)\s*\(/.test(raw)) continue;
      const rowCtx = ROW_EVENTS_ON_TABLE.has(attr) ? { ...ctx, row: { tableId } } : ctx;
      wires(node, rowCtx, name, null, { only: attr, label: `${clip(label, 60)}: ${attr}` });
    }
    // everything but the template: toolbars, columns' own controls, ...
    for (const agg of node.children) {
      if (isAggregation(agg) && agg.local === spec.agg) continue;
      if (agg === template) continue;
      if (agg.local === 'columns') {
        for (const col of agg.children) {
          for (const sub of col.children) {
            if (isAggregation(sub) && sub.local === 'template') continue;
            // the header: its text is the column's label; a header that is
            // more than text (a select-all CheckBox, a sort Button) is on the
            // screen like any control
            const headers = isAggregation(sub) && (sub.local === 'label' || sub.local === 'header')
              ? sub.children.filter((n) => !isAggregation(n))
              : (isAggregation(sub) ? null : [sub]);
            if (!headers) {
              walk(sub, ctx);
              continue;
            }
            for (const h of headers) {
              const hn = controlName(h);
              if (TEXT_PROPS[hn] || isLabel(hn)) continue;
              walk(h, ctx);
            }
          }
          wires(col, ctx, controlName(col));
        }
        continue;
      }
      if (ROW_TEMPLATES.has(agg.local)) continue;
      walk(agg, ctx);
    }
    // the template's wires, once, as row actions
    const rowCtx = { ...ctx, row: { tableId }, label: null };
    if (template) walkTemplate(template, rowCtx);
    for (const cs of cells) {
      if (spec.kind === 'ui') walkTemplate(cs.node, rowCtx);
    }
    for (const agg of node.children) {
      if (ROW_TEMPLATES.has(agg.local)) walkTemplate(agg, rowCtx);
    }
  }

  function walkTemplate(node, ctx) {
    if (isAggregation(node)) {
      for (const ch of node.children) walkTemplate(ch, ctx);
      return;
    }
    if (node.attrs.visible !== undefined && node.attrs.visible.trim() === 'false') return;
    const name = controlName(node);
    if (!/^sap\./.test(node.ns || '')) note(`custom control ${name} in table ${ctx.row.tableId} - not described`);
    wires(node, ctx, name);
    const spec = lookupSpec(FIELD_SPECS, name, metadata);
    if (spec && spec.items) return;
    for (const ch of node.children) walkTemplate(ch, ctx);
  }

  function columnHeader(col, ctx) {
    if (!col) return '';
    if (col.attrs.header !== undefined) return textOf(col.attrs.header, ctx);
    const headerAgg = col.children.find((n) => n.local === 'header');
    const hNode = (headerAgg ? headerAgg.children : col.children).find((n) => !isAggregation(n));
    if (!hNode) return '';
    return textOf(hNode.attrs.text ?? hNode.attrs.title, ctx);
  }

  function headerTitle(node, ctx) {
    for (const agg of node.children) {
      if (!isAggregation(agg) || !['headerToolbar', 'extension', 'infoToolbar', 'title', 'toolbar'].includes(agg.local)) continue;
      const t = findFirst(agg, (n) => controlName(n) === 'sap.m.Title');
      if (t) return textOf(t.attrs.text, ctx);
    }
    return '';
  }

  function descendants(node) {
    const acc = [];
    for (const ch of node.children) {
      if (!isAggregation(ch)) acc.push(ch);
      acc.push(...descendants(ch));
    }
    return acc;
  }

  function mainProp(n) {
    const spec = lookupSpec(FIELD_SPECS, controlName(n), metadata);
    if (spec) return spec.props.find((p) => n.attrs[p] !== undefined) || null;
    for (const p of ['text', 'title', 'number', 'value', 'displayValue', 'percentValue', 'state', 'selected', 'src', 'htmlText']) {
      if (n.attrs[p] !== undefined && !/\.(eB|eBP|eF)\s*\(/.test(n.attrs[p])) return p;
    }
    return null;
  }
}

/* A Label with labelFor names the control of that id, wherever it is. */
function collectLabelFor(root, data) {
  const map = new Map();
  const visit = (n) => {
    for (const ch of n.children) {
      if (!isAggregation(ch) && controlName(ch) === 'sap.m.Label' && ch.attrs.labelFor) {
        const b = parseBinding(ch.attrs.text);
        const text = b.kind === 'literal' ? b.value : (b.kind === 'path' && !b.relative && !b.model ? String(getAt(data, b.path) ?? '') : '');
        map.set(ch.attrs.labelFor, { text: text || '', required: ch.attrs.required === 'true' });
      }
      visit(ch);
    }
  };
  visit(root);
  return map;
}

/** The contract's one-call form: a backend response (or a folded state) -> snapshot v1. */
export function buildSnapshot({ response, state, app, session, maxRows = DEFAULT_MAX_ROWS, metadata = null, pending = [] } = {}) {
  return analyzeScreen({ response, state, app, session, maxRows, metadata, pending }).snapshot;
}
