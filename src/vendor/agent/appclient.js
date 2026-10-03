/*
 * VENDORED - do not edit. abap2UI5/mcp-server lib/appclient.mjs
 * at commit 9ca6cdf220acab2db938bcce123c81d6640c27ee,
 * copied by scripts/vendor-agent.mjs (`npm run agent-vendor`); the only
 * change is the sibling imports ending in .js. `npm run agent-vendor:check`
 * fails when this copy drifts from that commit. Change it upstream, then
 * re-vendor.
 */
/*
 * appclient — an abap2UI5 app operated through its own JSON protocol, the
 * way the browser's UI5 frontend operates it, without the browser.
 *
 * The frontend's roundtrip (abap2UI5 app/webapp/core/Server.js and
 * controller/View1.controller.js) is small:
 *
 *   start   POST { value: { S_FRONT: { ORIGIN, PATHNAME, SEARCH: '?app_start=<CLASS>' } } }
 *   event   POST { value: { S_FRONT: { ID: <draft id of the last response>,
 *                                     EVENT: 'SAVE', T_EVENT_ARG: [...] },
 *                           MODEL: <delta of the model the event's view owns> } }
 *   answer  { S_FRONT: { ID, APP, S_ACTION: { T_SYSTEM, T_CUSTOM } }, MODEL? }
 *
 * This client keeps per session what the frontend keeps per component: the
 * views in their slots and the models (lib/snapshot.mjs applyResponse), the
 * draft id to continue with, and the edits made since the last roundtrip.
 * Every answer is a snapshot v1 (docs/agent-snapshot.md); app_describe is
 * answered from memory.
 *
 * Validation is the point (Contract B): an event that is not among the
 * snapshot's actions, a field that is not among its fields or is not
 * editable, a choice outside its values - each is refused with the list of
 * what IS allowed, before anything goes over the wire. An agent cannot wire
 * blind.
 *
 * Values without an event stay PENDING: typing into a field does not
 * roundtrip in the browser either (unless the view wires a change event, in
 * which case that event is an action like any other). They travel with the
 * next event fired from the same view, exactly as the browser's delta does.
 */
import {
  applyResponse, analyzeScreen, emptyState, getAt, setAt, DEFAULT_MAX_ROWS,
} from './snapshot.js';
import { parseBinding, evalExpression } from './viewxml.js';

/** A refusal the tool returns as an error result: what was wrong, what is allowed. */
export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
  }
}

const LIST_MAX = 30;

/*
 * The model delta, as the frontend builds it (core/Lib.js
 * buildDeltaFromPaths): a scalar or structure edit ships the whole top-level
 * attribute, a table cell edit ships { TAB: { __delta: { <row>: { COL: v } } } }
 * (recursively for nested tables).
 */
export function buildDelta(paths, data) {
  const delta = {};
  for (const p of paths) {
    const parts = String(p).replace(/^\//, '').split('/');
    const attr = parts[0];
    const steps = deltaSteps(parts.slice(1));
    if (!steps) {
      delta[attr] = data[attr];
      continue;
    }
    if (attr in delta && !(delta[attr] && delta[attr].__delta)) continue;
    if (!(delta[attr] && delta[attr].__delta)) delta[attr] = { __delta: {} };
    let node = delta[attr];
    let model = data[attr];
    for (const { row, field, leaf } of steps) {
      const rows = node.__delta;
      if (!rows[row]) rows[row] = {};
      const rowDelta = rows[row];
      model = model && model[Number(row)] ? model[Number(row)][field] : undefined;
      if (leaf) {
        rowDelta[field] = model;
        break;
      }
      if (field in rowDelta && !(rowDelta[field] && rowDelta[field].__delta)) break;
      if (!(rowDelta[field] && rowDelta[field].__delta)) rowDelta[field] = { __delta: {} };
      node = rowDelta[field];
    }
  }
  return delta;
}

function deltaSteps(segs) {
  const steps = [];
  let i = 0;
  while (i < segs.length) {
    const row = segs[i];
    if (row === '' || Number.isNaN(Number(row))) return null;
    const field = segs[i + 1];
    if (field === undefined || field === '' || !Number.isNaN(Number(field))) return null;
    i += 2;
    if (i >= segs.length || Number.isNaN(Number(segs[i]))) {
      steps.push({ row, field, leaf: true });
      return steps;
    }
    steps.push({ row, field, leaf: false });
  }
  return null;
}

/** The backend's error page (a 500 renders the exception chain in a <pre>)
 *  as plain text. */
export function errorText(status, body) {
  const s = String(body || '');
  const pre = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(s);
  const raw = pre ? pre[1] : s;
  const text = raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(0, 12).join('\n');
  return `HTTP ${status}${text ? `: ${text}` : ''}`;
}

const listOf = (items) => {
  const shown = items.slice(0, LIST_MAX);
  return shown.join(', ') + (items.length > shown.length ? `, ... (${items.length - shown.length} more)` : '');
};

/** The hint after "the backend did not answer (...)" on the local backend. */
export const LOCAL_BACKEND_HINT = 'is it running? backend { action: "status" } says';

/** The transport over `fetch`: one POST of `body` to `baseUrl`. */
export function fetchTransport({ baseUrl, fetchImpl = globalThis.fetch }) {
  return async ({ body, headers, signal }) => {
    const res = await fetchImpl(baseUrl, { method: 'POST', headers, body, signal });
    return {
      status: res.status,
      headers: res.headers && typeof res.headers.entries === 'function' ? Object.fromEntries(res.headers.entries()) : {},
      body: await res.text(),
    };
  };
}

/*
 * One client per backend. The defaults are the local backend's; every
 * assumption about it is an option, so the same client (vendored, unchanged)
 * runs against a real system (docs/agent-snapshot.md, "Embedding the
 * client"):
 *
 *   baseUrl      the backend's root (http://127.0.0.1:<port>/) - where the
 *                default transport POSTs and what the default location says
 *   fetchImpl    the default transport's fetch
 *   transport    ({ body, headers, signal, draftId }) => { status, headers?, body }:
 *                ONE roundtrip - `body` is the serialized JSON request,
 *                `headers` the two the frontend sends, `draftId` the
 *                S_FRONT.ID the request continues (null for an app start);
 *                a throw is "the backend did not answer". Replaces
 *                baseUrl/fetchImpl.
 *   location     (app) => { origin, pathname, search } (or a promise of
 *                it): the start request's ORIGIN/PATHNAME/SEARCH - the
 *                backend builds URLs out of them and keeps them with the
 *                app's session, so on a real system they are its launch URL,
 *                not a proxy's; `search` names the class (app_start=<app>).
 *                A throw reaches the caller as it is (an AgentError is a
 *                refusal). Default: baseUrl, '/', '?app_start=<app>'
 *   generation   () => <id of the running backend process>: a session started
 *                under another one is gone (its drafts lived in that
 *                process) and is refused so instead of answered with a
 *                backend error. Absent: no restart detection.
 *   backendHint  what follows "the backend did not answer (...) - " ('' for
 *                nothing); default: the local backend's `backend` tool
 *   metadata     the linter's UI5 control snapshot for the snapshot builder
 */
export function createAppClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  transport,
  location,
  generation,
  backendHint = LOCAL_BACKEND_HINT,
  metadata = () => null,
  maxSessions = 20,
  timeoutMs = 120_000,
} = {}) {
  const sessions = [];
  const byId = new Map();
  const roundtrip = transport || fetchTransport({ baseUrl, fetchImpl });
  const locate = location || ((app) => ({
    origin: String(baseUrl).replace(/\/$/, ''),
    pathname: '/',
    search: `?app_start=${encodeURIComponent(app)}`,
  }));
  const currentGeneration = () => (generation ? generation() : null);

  async function post(body) {
    let res;
    try {
      res = await roundtrip({
        body: JSON.stringify({ value: body }),
        headers: { 'content-type': 'application/json', 'sap-contextid-accept': 'header' },
        signal: AbortSignal.timeout(timeoutMs),
        draftId: body.S_FRONT && body.S_FRONT.ID ? String(body.S_FRONT.ID) : null,
      });
    } catch (e) {
      throw new AgentError(`the backend did not answer (${(e && e.message) || e})${backendHint ? ` - ${backendHint}` : ''}`);
    }
    const text = String(res.body ?? '');
    if (!(res.status >= 200 && res.status < 300)) throw new AgentError(`the backend refused the roundtrip - ${errorText(res.status, text)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AgentError(`the backend answered no JSON: ${text.slice(0, 300)}`);
    }
    if (!json || !json.S_FRONT) throw new AgentError(`the backend answered without S_FRONT: ${text.slice(0, 300)}`);
    return json;
  }

  function remember(session) {
    sessions.push(session);
    while (sessions.length > maxSessions) {
      const old = sessions.shift();
      for (const id of old.ids) byId.delete(id);
    }
  }

  function adopt(session, response) {
    session.state = applyResponse(session.state, response);
    const id = session.state.id;
    if (id) {
      session.ids.add(id);
      byId.set(id, session);
    }
    // edits the roundtrip did not carry survive a model push, as the
    // frontend re-applies its pending paths after setData
    for (const [key, map] of Object.entries(session.pending)) {
      const m = session.state.models[key];
      if (!m) {
        session.pending[key] = new Map();
        continue;
      }
      for (const [p, v] of map) setAt(m.data, p, v);
    }
  }

  function analyze(session, maxRows) {
    const pending = Object.values(session.pending).flatMap((m) => [...m.keys()]);
    return analyzeScreen({
      state: session.state,
      maxRows: maxRows ?? session.maxRows,
      metadata: metadata(),
      pending,
    });
  }

  function find(sessionId) {
    if (!sessionId) throw new AgentError('pass `session` - the draft id the last snapshot carried (app_start returns the first)');
    const s = byId.get(String(sessionId));
    if (!s) {
      const known = sessions.map((x) => `${x.state.id} (${x.state.app})`);
      throw new AgentError(`unknown session '${sessionId}' - start one with app_start${known.length ? `; open sessions: ${listOf(known)}` : ''}`);
    }
    if (generation && s.generation !== generation()) {
      throw new AgentError(`session '${sessionId}' was started on a backend that has since stopped or restarted - its drafts are gone; app_start ${s.state.app || 'the app'} again`);
    }
    if (s.state.id !== String(sessionId)) {
      throw new AgentError(`session '${sessionId}' is an earlier state of this app session - continue with the current one: '${s.state.id}' (app_describe shows it)`);
    }
    return s;
  }

  // ------------------------------------------------------------ values ----

  function resolveTarget(key, snapshot, index) {
    const k = String(key);
    const byIdHit = index.fields.get(k);
    if (byIdHit) return { kind: 'field', ...byIdHit };
    const f = snapshot.fields.find((x) => x.path === k)
      || snapshot.fields.find((x) => x.name.toUpperCase() === k.toUpperCase());
    if (f) return { kind: 'field', ...index.fields.get(f.id) };
    // a table cell: /T_TAB/3/QTY or t1/3/QTY
    const m = /^(.*)\/(\d+)\/([A-Za-z_][\w-]*)$/.exec(k);
    if (m) {
      const t = snapshot.tables.find((x) => x.path === m[1] || x.id === m[1]);
      if (t) return { kind: 'cell', table: t, entry: index.tables.get(t.id), row: Number(m[2]), col: m[3] };
    }
    return null;
  }

  function fieldHelp(snapshot) {
    const editable = snapshot.fields.filter((f) => f.editable).map((f) => `${f.id} (${f.label}, ${f.path})`);
    const cells = snapshot.tables.filter((t) => t.editableCells.length).map((t) => `${t.path}/<row 0-${Math.max(0, t.rowCount - 1)}>/{${t.editableCells.join('|')}} (table ${t.id})`);
    const parts = [];
    parts.push(editable.length ? `fields you can fill: ${listOf(editable)}` : 'no editable field on this screen');
    if (cells.length) parts.push(`table cells: ${listOf(cells)}`);
    return parts.join('; ') + layerNote(snapshot);
  }

  /* A dialog in front of the page: the page's fields and actions are not on
   * the screen until it closes - said, so the refusal does not read as "the
   * field is gone". */
  function layerNote(snapshot) {
    return snapshot.layer === 'main' ? '' : ` (a ${snapshot.layer} is open: only its fields and actions count until it closes)`;
  }

  /** The value in the type the model holds there (a Number input bound to a
   *  string attribute stays a string, a boolean stays a boolean). */
  function coerce(value, current, kind, label) {
    if (kind === 'boolean') {
      if (value === true || value === false) return value;
      if (value === 'true' || value === 'false') return value === 'true';
      throw new AgentError(`${label} is a boolean - pass true or false, not ${JSON.stringify(value)}`);
    }
    if (kind === 'multichoice') {
      if (!Array.isArray(value)) throw new AgentError(`${label} is a multichoice - pass an array of keys`);
      return value.map(String);
    }
    if (value !== null && typeof value === 'object') throw new AgentError(`${label} takes a single value, not ${JSON.stringify(value).slice(0, 80)}`);
    if (typeof current === 'number') {
      const n = Number(value);
      if (value === '' || Number.isNaN(n)) throw new AgentError(`${label} holds a number - ${JSON.stringify(value)} is none`);
      return n;
    }
    if (typeof current === 'boolean') return coerce(value, undefined, 'boolean', label);
    return value === null || value === undefined ? '' : String(value);
  }

  function applyValues(session, values, snapshot, index) {
    if (values === undefined || values === null) return [];
    if (typeof values !== 'object' || Array.isArray(values)) throw new AgentError('`values` is an object: { "<field id, path or name>": value }');
    const plan = [];
    for (const [key, value] of Object.entries(values)) {
      const t = resolveTarget(key, snapshot, index);
      if (!t) throw new AgentError(`no field '${key}' on this screen - ${fieldHelp(snapshot)}`);
      if (t.kind === 'field') {
        const f = t.field;
        if (!f.editable) throw new AgentError(`field ${f.id} (${f.label}) is not editable - ${fieldHelp(snapshot)}`);
        const label = `field ${f.id} (${f.label})`;
        const v = coerce(value, getAt(session.state.models[t.modelKey].data, f.path), f.kind, label);
        if ((f.kind === 'choice' || f.kind === 'multichoice') && Array.isArray(f.values)) {
          const keys = f.values.map((x) => String(x.key));
          for (const one of (Array.isArray(v) ? v : [v])) {
            if (!keys.includes(String(one))) throw new AgentError(`${label}: '${one}' is not one of its values - allowed keys: ${listOf(keys.map((x) => `'${x}'`))}`);
          }
        }
        // a choice keyed by index (RadioButtonGroup) keeps its number
        const stored = f.kind === 'choice' && Array.isArray(f.values) && typeof f.values[0]?.key === 'number' ? Number(v) : v;
        plan.push({ modelKey: t.modelKey, path: f.path, value: stored });
      } else {
        const { table, entry, row, col } = t;
        if (!table.editableCells.includes(col)) {
          throw new AgentError(`column ${col} of table ${table.id} is not editable - editable columns: ${table.editableCells.length ? table.editableCells.join(', ') : 'none'}`);
        }
        if (row >= table.rowCount) throw new AgentError(`table ${table.id} has ${table.rowCount} row(s) - row ${row} does not exist (rows are 0-based)`);
        const data = session.state.models[entry.modelKey].data;
        const rowData = getAt(data, `${table.path}/${row}`);
        const cs = entry.cellSpecs.get(col);
        if (cs && cs.editableFor && !cs.editableFor(rowData)) throw new AgentError(`cell ${col} of row ${row} in table ${table.id} is not editable in that row`);
        const p = `${table.path}/${row}/${col}`;
        const kind = cs && cs.fieldSpec ? (typeof cs.fieldSpec.kind === 'string' ? cs.fieldSpec.kind : 'text') : (col === table.selectionField ? 'boolean' : 'text');
        plan.push({ modelKey: entry.modelKey, path: p, value: coerce(value, getAt(data, p), kind, `cell ${p}`) });
      }
    }
    for (const { modelKey, path, value } of plan) {
      setAt(session.state.models[modelKey].data, path, value);
      if (!session.pending[modelKey]) session.pending[modelKey] = new Map();
      session.pending[modelKey].set(path, value);
    }
    return plan.map((x) => x.path);
  }

  // ----------------------------------------------------------- actions ----

  function actionHelp(snapshot) {
    const items = snapshot.actions.filter((a) => a.enabled).map((a) => `${a.event} (${a.id} "${a.label}"${a.scope === 'row' ? `, row action of ${a.table}` : ''})`);
    return (items.length ? `allowed events: ${listOf(items)}` : 'this screen offers no action') + layerNote(snapshot);
  }

  function findAction(event, row, snapshot, index) {
    const e = String(event);
    const hit = index.actions.get(e);
    if (hit) return hit;
    const named = snapshot.actions.filter((a) => a.event === e);
    if (!named.length) throw new AgentError(`no action '${e}' on this screen - ${actionHelp(snapshot)}`);
    const enabled = named.filter((a) => a.enabled);
    const pool = enabled.length ? enabled : named;
    const pick = (row !== undefined && row !== null ? pool.find((a) => a.scope === 'row') : null) || pool[0];
    return index.actions.get(pick.id);
  }

  function resolveSourceProp(node, prop, data, rowData) {
    const raw = node && node.attrs ? node.attrs[prop] : undefined;
    if (raw === undefined) return undefined;
    const b = parseBinding(raw);
    const ref = (r) => {
      if (/^[A-Za-z_][\w.-]*>/.test(r)) return undefined;
      return r.startsWith('/') ? getAt(data, r) : (rowData ? getAt(rowData, r) : undefined);
    };
    if (b.kind === 'literal') return b.value;
    if (b.kind === 'path') return b.model ? undefined : ref(b.path);
    if (b.kind === 'expression') return evalExpression(b.expression, ref);
    return undefined;
  }

  function eventArgs(entry, given, rowIndex, session) {
    const { action, wire, node, tableId, choices } = entry;
    const descs = (wire && wire.args) || [];
    if (given !== undefined && given !== null && !Array.isArray(given)) throw new AgentError('`args` is an array, positional to the action\'s args (null where the client should fill in the value)');
    const g = given || [];
    if (g.length > descs.length) throw new AgentError(`action ${action.id} (${action.event}) takes ${descs.length} argument(s) - ${JSON.stringify(action.args)}; ${g.length} given`);
    const data = session.state.models[entry.modelKey || 'MAIN']?.data || {};
    let rowData;
    if (action.scope !== 'row' && rowIndex !== undefined && rowIndex !== null) {
      throw new AgentError(`\`row\` is for row actions - ${action.id} (${action.event}) is a screen action; leave \`row\` out`);
    }
    if (action.scope === 'row') {
      const t = session.lastIndex.tables.get(tableId);
      const count = t ? t.table.rowCount : 0;
      const needsRow = descs.some((d, i) => !d.static && (g[i] === undefined || g[i] === null) && ['row', 'source'].includes(d.kind));
      if (rowIndex === undefined || rowIndex === null) {
        if (needsRow) throw new AgentError(`action ${action.id} (${action.event}) is a row action of table ${tableId} (${count} rows) - pass \`row\` (0-${Math.max(0, count - 1)})`);
      } else {
        if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= count) throw new AgentError(`table ${tableId} has ${count} row(s) - row ${rowIndex} does not exist (rows are 0-based)`);
        rowData = t ? getAt(data, `${t.path}/${rowIndex}`) : undefined;
      }
    }
    return descs.map((d, i) => {
      const explicit = g[i];
      if (d.static) {
        if (explicit !== undefined && explicit !== null && explicit !== d.value) throw new AgentError(`argument ${i} of ${action.event} is static (${JSON.stringify(d.value)}) - pass null there`);
        return d.value;
      }
      if (explicit !== undefined && explicit !== null) {
        if (d.kind === 'action' && choices && !choices.includes(String(explicit))) throw new AgentError(`argument ${i} of ${action.event}: '${explicit}' is not one of ${listOf(choices)}`);
        return explicit;
      }
      if (d.kind === 'row') {
        if (rowData === undefined) throw new AgentError(`argument ${i} of ${action.event} (${d.describe}) reads a row - pass \`row\`, or the value in args[${i}]`);
        return getAt(rowData, d.path) ?? '';
      }
      if (d.kind === 'model') return getAt(data, d.path) ?? '';
      if (d.kind === 'source') {
        const v = resolveSourceProp(node, d.prop, data, rowData);
        if (v === undefined) throw new AgentError(`argument ${i} of ${action.event} (${d.describe}) cannot be read here - pass it in args[${i}]`);
        return v;
      }
      if (d.kind === 'action') return choices ? choices[0] : 'OK';
      throw new AgentError(`argument ${i} of ${action.event} (${d.describe}) is computed in the browser - pass its value in args[${i}]`);
    });
  }

  // --------------------------------------------------------- operations ----

  return {
    /** app_start: POST the app start, adopt the answer, apply `values` as pending. */
    async start(app, { values, maxRows } = {}) {
      const cls = String(app || '').trim();
      if (!cls) throw new AgentError('pass `app` - the class to start, e.g. z2ui5_cl_smp_app_009 (app_list names the built ones)');
      const where = await locate(cls);
      const response = await post({ S_FRONT: { ORIGIN: where.origin, PATHNAME: where.pathname, SEARCH: where.search } });
      const session = {
        state: emptyState(), ids: new Set(), pending: { MAIN: new Map(), POPUP: new Map(), POPOVER: new Map() },
        generation: currentGeneration(), maxRows: maxRows ?? DEFAULT_MAX_ROWS, lastIndex: null,
      };
      adopt(session, response);
      remember(session);
      let res = analyze(session, maxRows);
      session.lastIndex = res.index;
      if (values && Object.keys(values).length) {
        applyValues(session, values, res.snapshot, res.index);
        res = analyze(session, maxRows);
        session.lastIndex = res.index;
      }
      return res.snapshot;
    },

    /** app_describe: the current state, from memory. */
    describe(sessionId, { maxRows } = {}) {
      const session = find(sessionId);
      const res = analyze(session, maxRows);
      session.lastIndex = res.index;
      return res.snapshot;
    },

    /** app_act: validate, apply values, fire the event (or keep the values pending). */
    async act(sessionId, { values, event, args, row, maxRows } = {}) {
      const session = find(sessionId);
      let res = analyze(session, maxRows);
      session.lastIndex = res.index;
      // validate everything before anything changes
      let entry = null;
      if (event !== undefined && event !== null && event !== '') {
        entry = findAction(event, row, res.snapshot, res.index);
        if (!entry.action.enabled) throw new AgentError(`action ${entry.action.id} (${entry.action.label}) is disabled - ${actionHelp(res.snapshot)}`);
      } else if (row !== undefined && row !== null) {
        throw new AgentError('`row` belongs to an event - pass `event` too');
      }
      const savedPending = Object.fromEntries(Object.entries(session.pending).map(([k, m]) => [k, new Map(m)]));
      const savedModels = JSON.stringify(session.state.models);
      try {
        applyValues(session, values, res.snapshot, res.index);
        if (!entry) {
          res = analyze(session, maxRows);
          session.lastIndex = res.index;
          return res.snapshot;
        }
        // the values may have changed what the args read: re-analyse first
        res = analyze(session, maxRows);
        session.lastIndex = res.index;
        entry = res.index.actions.get(entry.action.id) || entry;
        if (entry.frontend) {
          // performed here, as the browser performs it: the slot closes, its
          // unsent edits go with it, no roundtrip
          const slot = entry.frontend;
          const nextState = { ...session.state, slots: { ...session.state.slots }, models: { ...session.state.models }, custom: [] };
          delete nextState.slots[slot];
          delete nextState.models[slot];
          session.state = nextState;
          session.pending[slot] = new Map();
          res = analyze(session, maxRows);
          session.lastIndex = res.index;
          return res.snapshot;
        }
        const tArgs = eventArgs(entry, args, row, session);
        const modelKey = entry.modelKey || 'MAIN';
        const sent = session.pending[modelKey] || new Map();
        const body = { S_FRONT: { ID: session.state.id, EVENT: entry.action.event } };
        if (tArgs.length) body.S_FRONT.T_EVENT_ARG = tArgs;
        if (sent.size && session.state.models[modelKey]) body.MODEL = buildDelta([...sent.keys()], session.state.models[modelKey].data);
        const response = await post(body);
        session.pending[modelKey] = new Map();
        adopt(session, response);
      } catch (e) {
        // a refused act changes nothing: neither the pending edits nor the models
        session.pending = savedPending;
        session.state = { ...session.state, models: JSON.parse(savedModels) };
        throw e;
      }
      res = analyze(session, maxRows);
      session.lastIndex = res.index;
      return res.snapshot;
    },

    /** The open sessions (for diagnostics and the error texts). */
    sessions() {
      return sessions.map((s) => ({ session: s.state.id, app: s.state.app }));
    },
  };
}

