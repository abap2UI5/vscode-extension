/*
 * VENDORED - do not edit. abap2UI5/mcp-server lib/appclient.mjs
 * at commit d8d3b765d7591805e832cd93cc102ddc792b462c,
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

/*
 * The backend's error body as the refusal shows it: VERBATIM text
 * (protocol spec/errors.md) - the body is text/plain, and what looks like a
 * tag in it (a request URL the backend reflected into the first frame) is
 * text, so nothing is stripped, decoded or otherwise interpreted. It is only
 * shortened (the first ERROR_LINES lines, at most ERROR_CHARS characters)
 * and its control characters other than tab and newline are shown as
 * U+FFFD, so a body cannot move a terminal's cursor or hide text from
 * whoever reads the refusal - neither is markup.
 */
const ERROR_LINES = 40;
const ERROR_CHARS = 4000;
const REPLACEMENT = String.fromCodePoint(0xfffd);

export function errorText(status, body) {
  const all = String(body ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, REPLACEMENT)
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/, '');
  const lines = all.split('\n');
  let text = lines.slice(0, ERROR_LINES).join('\n');
  let cut = lines.length > ERROR_LINES;
  if (text.length > ERROR_CHARS) {
    text = text.slice(0, ERROR_CHARS);
    cut = true;
  }
  if (cut) text += `\n... (${all.length - text.length} more characters)`;
  return `HTTP ${status}${text ? `: ${text}` : ''}`;
}

const listOf = (items) => {
  const shown = items.slice(0, LIST_MAX);
  return shown.join(', ') + (items.length > shown.length ? `, ... (${items.length - shown.length} more)` : '');
};

/** The hint after "the backend did not answer (...)" on the local backend. */
export const LOCAL_BACKEND_HINT = 'is it running? backend { action: "status" } says';

/** The protocol number this client is written for (protocol
 *  spec/versioning.md): a response declaring another one is refused. */
export const PROTOCOL = 2;

/** A response header, case-insensitively, a repeated one joined; '' when absent. */
export function headerOf(headers, name) {
  if (!headers) return '';
  const want = String(name).toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return (Array.isArray(v) ? v.join(', ') : String(v ?? '')).trim();
  }
  return '';
}

/** The frontend's rule for a stateful session id (core/Lib.js
 *  isValidContextId): never empty, never the text `undefined`. */
export const validContextId = (id) => typeof id === 'string' && id !== '' && id !== 'undefined';

/** The transport over `fetch`: one POST of `body` to `baseUrl` - or, for the
 *  CSRF token fetch, one HEAD without a body. */
export function fetchTransport({ baseUrl, fetchImpl = globalThis.fetch }) {
  return async ({ method = 'POST', body, headers, signal }) => {
    const res = await fetchImpl(baseUrl, method === 'HEAD' ? { method, headers, signal } : { method, headers, body, signal });
    return {
      status: res.status,
      headers: res.headers && typeof res.headers.entries === 'function' ? Object.fromEntries(res.headers.entries()) : {},
      body: method === 'HEAD' ? '' : await res.text(),
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
 *   transport    ({ method, body, headers, signal, draftId }) => { status, headers?, body }:
 *                ONE request, sent as given. `method` 'POST' is a roundtrip:
 *                `body` the serialized JSON request, `headers` what the
 *                frontend sends (content-type, sap-contextid-accept, and the
 *                session's sap-contextid and the CSRF token once the backend
 *                handed them out); `method` 'HEAD' is the CSRF token fetch
 *                (no body). `draftId` is the S_FRONT.ID the request continues
 *                (null for an app start). The answer's `headers` are read for
 *                sap-contextid and x-csrf-token - the client does both
 *                handshakes itself, so a transport must not. A throw is "the
 *                backend did not answer". Replaces baseUrl/fetchImpl.
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

  // the token a CSRF token layer in front of the backend handed out - one
  // per backend, as the browser frontend keeps it per server
  let csrfToken = '';

  const requestHeaders = (session) => {
    const headers = { 'content-type': 'application/json', 'sap-contextid-accept': 'header' };
    if (session && validContextId(session.contextId)) headers['sap-contextid'] = session.contextId;
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    return headers;
  };

  /*
   * A token layer's refusal (an approuter route with csrfProtection, a
   * Gateway): 403 with `X-CSRF-Token: Required`. The backend's own CSRF gate
   * answers a 403 WITHOUT it, and that one is final.
   */
  const csrfRequired = (res) => res && res.status === 403 && headerOf(res.headers, 'x-csrf-token').toLowerCase() === 'required';

  /* HEAD with `X-CSRF-Token: Fetch`; the token comes back in the same
   * header. Answers whether one arrived and never throws - without one the
   * refusal that asked for it is reported as it is. */
  async function fetchCsrfToken(session, signal, draftId) {
    csrfToken = '';
    try {
      const headers = { 'x-csrf-token': 'Fetch' };
      if (session && validContextId(session.contextId)) headers['sap-contextid'] = session.contextId;
      const res = await roundtrip({ method: 'HEAD', headers, signal, draftId });
      const token = headerOf(res && res.headers, 'x-csrf-token');
      if (res && res.status >= 200 && res.status < 300 && token && !['required', 'fetch'].includes(token.toLowerCase())) csrfToken = token;
    } catch {
      // no token: the 403 below says why
    }
    return csrfToken !== '';
  }

  /*
   * One roundtrip of `session` (null for an app start), with the browser
   * frontend's handshakes (protocol spec/transport.md): the session's
   * sap-contextid sent once the backend handed one out, and a token layer's
   * 403 answered by a token fetch and ONE re-send of the same body. Answers
   * the response and the sap-contextid it carried (null when none); the
   * caller adopts both, or neither.
   */
  async function post(body, session) {
    const draftId = body.S_FRONT && body.S_FRONT.ID ? String(body.S_FRONT.ID) : null;
    const serialized = JSON.stringify({ value: body });
    const signal = AbortSignal.timeout(timeoutMs);
    const send = () => roundtrip({ method: 'POST', body: serialized, headers: requestHeaders(session), signal, draftId });
    let res;
    try {
      res = await send();
      if (csrfRequired(res) && await fetchCsrfToken(session, signal, draftId)) res = await send();
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
    // checked before anything of the response is read (spec/versioning.md):
    // a present and different number is refused whole, its ID included;
    // an absent one is let through (a backend older than the field)
    const declared = json.S_FRONT.PROTOCOL;
    if (declared !== undefined && declared !== null && Number(declared) !== PROTOCOL) {
      const newer = Number(declared) > PROTOCOL;
      throw new AgentError(`the backend answered protocol ${JSON.stringify(declared)}, this client speaks protocol ${PROTOCOL} - `
        + `the ${newer ? 'client' : 'backend'} is older; nothing of the response was adopted (update the ${newer ? 'client' : 'backend'})`);
    }
    const contextId = headerOf(res.headers, 'sap-contextid');
    return { json, contextId: validContextId(contextId) ? contextId : null };
  }

  function remember(session) {
    sessions.push(session);
    while (sessions.length > maxSessions) {
      const old = sessions.shift();
      for (const id of old.ids) byId.delete(id);
    }
  }

  function adopt(session, { json: response, contextId }) {
    // a response without the header keeps the established session id
    if (contextId) session.contextId = contextId;
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

  /*
   * A selection dialog's confirm picks a row, as a click on it does in the
   * browser: the row's selectionField becomes true (and, selecting one row,
   * every other selected row's false) - two-way bound, so the edits travel
   * with the confirm as the model delta. Answers the selected rows in model
   * order, which is what the event's selectedItem/selectedItems/
   * selectedContexts are made of. Without `row` the selection stays as the
   * model holds it (a multi-select dialog's OK after the rows were ticked
   * through `values`); picking one row needs one.
   */
  function applyPick(entry, rowIndex, session) {
    const { action, tableId } = entry;
    const t = session.lastIndex.tables.get(tableId);
    const count = t ? t.table.rowCount : 0;
    const data = session.state.models[t ? t.modelKey : 'MAIN']?.data || {};
    const rows = t ? getAt(data, t.path) : undefined;
    const list = Array.isArray(rows) ? rows : [];
    const single = t && t.table.selectionMode === 'Single';
    const given = rowIndex !== undefined && rowIndex !== null;
    if (given && (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= count)) {
      throw new AgentError(`table ${tableId} has ${count} row(s) - row ${rowIndex} does not exist (rows are 0-based)`);
    }
    const sf = t && t.selectionField;
    const set = (i, value) => {
      const p = `${t.path}/${i}/${sf}`;
      setAt(data, p, value);
      if (!session.pending[t.modelKey]) session.pending[t.modelKey] = new Map();
      session.pending[t.modelKey].set(p, value);
    };
    if (sf && given) {
      if (single) list.forEach((r, i) => { if (i !== rowIndex && r && r[sf]) set(i, false); });
      if (!(list[rowIndex] && list[rowIndex][sf] === true)) set(rowIndex, true);
    }
    let selected = sf ? list.map((r, i) => (r && r[sf] ? i : -1)).filter((i) => i >= 0) : [];
    if (given && (single || !sf)) selected = [rowIndex];
    if (given && !single && sf && !selected.includes(rowIndex)) selected.push(rowIndex);
    if (single && !selected.length) {
      throw new AgentError(`action ${action.id} (${action.event}) picks a row of table ${tableId} (${count} rows) - pass \`row\` (0-${Math.max(0, count - 1)})`);
    }
    return selected;
  }

  /*
   * The event parameters a row event hands its `${$parameters>/...}`
   * arguments, for the events whose parameters ARE the row: a selection
   * dialog's confirm (selectedItem, selectedItems, selectedContexts), a list
   * table's itemPress/selectionChange/delete/beforeOpenContextMenu
   * (listItem), a grid table's rowSelectionChange (rowIndex, rowContext),
   * cellClick (rowIndex, rowBindingContext) and beforeOpenContextMenu
   * (rowIndex), and a row action item of a grid table (row). An item is
   * { $item: <row> }, a binding context { $ctx: <row> }. null: the event's
   * parameters are not the row (or no row is known).
   */
  function rowEventParams(entry, t, rows) {
    if (!t || !rows) return null;
    const item = (r) => ({ $item: r });
    const ctx = (r) => ({ $ctx: r });
    if (entry.pick) {
      return { selectedItem: rows.length ? item(rows[0]) : null, selectedItems: rows.map(item), selectedContexts: rows.map(ctx) };
    }
    if (!rows.length) return null;
    const r = rows[0];
    const trigger = entry.action.trigger;
    if (entry.node === t.node) {
      if (t.kind === 'm' && ['itemPress', 'selectionChange', 'delete', 'beforeOpenContextMenu'].includes(trigger)) return { listItem: item(r) };
      if (t.kind === 'ui' && trigger === 'rowSelectionChange') return { rowIndex: r, rowContext: ctx(r) };
      if (t.kind === 'ui' && trigger === 'cellClick') return { rowIndex: r, rowBindingContext: ctx(r) };
      if (t.kind === 'ui' && trigger === 'beforeOpenContextMenu') return { rowIndex: r };
      return null;
    }
    if (t.kind === 'ui' && entry.rowTemplate === 'rowActionTemplate') return { row: item(r) };
    return null;
  }

  const UNKNOWN = Symbol('unknown');
  const isItem = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && ('$item' in v || '$ctx' in v || '$cell' in v);

  /*
   * `${$parameters>/<path>}` over those parameters, with the semantics of
   * the JSONModel UI5 puts them in (EventHandlerResolver): the path is split
   * at `/` and walked key by key - there is no `[n]` index syntax, so
   * `selectedContexts[0]/sPath` is undefined in the browser and goes out as
   * null here too. A context answers its `sPath`; anything else of an item
   * or a context (the control marshalled with all its properties) is
   * UNKNOWN, as is a parameter this client does not model.
   */
  function walkParams(params, path, t) {
    const segs = String(path).split('/').filter((x) => x !== '');
    let node = params;
    for (let k = 0; k < segs.length; k += 1) {
      const seg = segs[k];
      if (node === null || node === undefined) return node;
      if (isItem(node)) {
        if ('$ctx' in node && seg === 'sPath') {
          node = `${t.path}/${node.$ctx}`;
          continue;
        }
        return UNKNOWN;
      }
      if (/[[\]]/.test(seg)) return undefined;
      if (Array.isArray(node)) {
        node = seg === 'length' ? node.length : (/^\d+$/.test(seg) ? node[Number(seg)] : undefined);
        continue;
      }
      if (typeof node !== 'object') return undefined;
      if (k === 0 && !Object.prototype.hasOwnProperty.call(node, seg)) return UNKNOWN;
      node = node[seg];
    }
    if (isItem(node) || (Array.isArray(node) && node.some(isItem))) return UNKNOWN;
    return node;
  }

  /* A property getter of an item or a cell: the template attribute resolved
   * in the row - a number as the string the UI5 property holds; an
   * attribute the template does not set (or one bound to nothing) is
   * UNKNOWN. */
  function templateProp(node, prop, data, rowData) {
    if (!node) return UNKNOWN;
    const v = resolveSourceProp(node, prop, data, rowData);
    if (v === undefined || v === null) return UNKNOWN;
    return typeof v === 'number' ? String(v) : v;
  }

  /*
   * The browser-computed argument shapes of a row event, the ones views
   * actually write:
   *   ${$parameters>/P}                                (walkParams)
   *   ${$parameters>/P}.getBindingContext().getPath()
   *   ${$parameters>/P}.getBindingContext().getProperty('X')
   *   ${$parameters>/P}.getPath() / .getProperty('X')  (P a context)
   *   ${$parameters>/P}.get<Prop>()                    (the item template's <prop>)
   *   ${$parameters>/P}.getCells()[n].get<Prop>()
   *   ${$parameters>/P} ? <one of the above> : <literal>
   * Anything else is UNKNOWN - the caller asks for it in `args`.
   */
  function paramExpr(raw, params, t, data) {
    const src = String(raw).trim();
    const tern = /^(\$\{\$parameters>[^{}]*\})\s*\?\s*([\s\S]+?)\s*:\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|null|-?\d+(?:\.\d+)?)\s*$/.exec(src);
    if (tern) {
      // the condition is the parameter itself - an item is truthy
      const cond = headOf(/^\$\{\$parameters>\/?([^{}]*)\}$/.exec(tern[1])[1], params);
      if (cond === UNKNOWN) return UNKNOWN;
      if (cond) return paramExpr(tern[2], params, t, data);
      const lit = tern[3];
      if (lit === 'null') return null;
      if (/^-?\d/.test(lit)) return Number(lit);
      return lit.slice(1, -1).replace(/\\(.)/g, '$1');
    }
    const ref = /^\$\{\$parameters>\/?([^{}]*)\}/.exec(src);
    if (!ref) return UNKNOWN;
    let rest = src.slice(ref[0].length);
    if (!rest.trim()) return walkParams(params, ref[1], t);
    let cur = headOf(ref[1], params);
    if (cur === UNKNOWN) return UNKNOWN;
    const rowOf = (v) => ('$item' in v ? v.$item : '$ctx' in v ? v.$ctx : v.$cell.row);
    while (rest.trim()) {
      const call = /^\s*\.\s*([A-Za-z_]\w*)\s*\(\s*('[^']*'|"[^"]*")?\s*\)/.exec(rest);
      if (!call || !isItem(cur)) return UNKNOWN;
      rest = rest.slice(call[0].length);
      const [, fn, arg] = call;
      const r = rowOf(cur);
      const rowData = getAt(data, `${t.path}/${r}`);
      if ('$ctx' in cur) {
        if (fn === 'getPath' && !arg) cur = `${t.path}/${r}`;
        else if (fn === 'getProperty' && arg) cur = getAt(rowData, arg.slice(1, -1)) ?? null;
        else return UNKNOWN;
      } else if (fn === 'getBindingContext' && !arg) {
        cur = { $ctx: r };
      } else if (fn === 'getCells' && !arg && '$item' in cur) {
        const idx = /^\s*\[\s*(\d+)\s*\]/.exec(rest);
        if (!idx) return UNKNOWN;
        rest = rest.slice(idx[0].length);
        const n = Number(idx[1]);
        if (!t.cellNodes || n >= t.cellNodes.length) return UNKNOWN;
        cur = { $cell: { row: r, n } };
      } else if (/^get[A-Z]/.test(fn) && !arg && fn !== 'getId') {
        const prop = fn[3].toLowerCase() + fn.slice(4);
        const node = '$cell' in cur ? t.cellNodes[cur.$cell.n] : (t.kind === 'm' ? t.template : null);
        cur = templateProp(node, prop, data, rowData);
        if (cur === UNKNOWN) return UNKNOWN;
      } else {
        return UNKNOWN;
      }
    }
    return isItem(cur) ? UNKNOWN : cur;
  }

  /* The parameter a call chain starts from, as a value: an item or a
   * context is not walked into; a parameter this client does not model is
   * UNKNOWN. */
  function headOf(path, params) {
    const segs = String(path).split('/').filter((x) => x !== '');
    let cur = params;
    for (let k = 0; k < segs.length; k += 1) {
      const seg = segs[k];
      if (cur === null || cur === undefined || isItem(cur) || /[[\]]/.test(seg)) return UNKNOWN;
      if (k === 0 && !Object.prototype.hasOwnProperty.call(cur, seg)) return UNKNOWN;
      cur = Array.isArray(cur) ? (/^\d+$/.test(seg) ? cur[Number(seg)] : undefined) : cur[seg];
    }
    return cur;
  }

  /** A `$parameters`/`$expr` argument of a row event, from its row(s); UNKNOWN when this client cannot. */
  function rowParamArg(d, params, t, data) {
    if (!params || !t) return UNKNOWN;
    if (d.kind === 'parameters') return walkParams(params, d.path, t);
    if (d.kind === 'expr') return paramExpr(d.raw, params, t, data);
    return UNKNOWN;
  }

  function eventArgs(entry, given, rowIndex, session, picked = null) {
    const { action, wire, node, tableId, choices } = entry;
    const descs = (wire && wire.args) || [];
    if (given !== undefined && given !== null && !Array.isArray(given)) throw new AgentError('`args` is an array, positional to the action\'s args (null where the client should fill in the value)');
    const g = given || [];
    if (g.length > descs.length) throw new AgentError(`action ${action.id} (${action.event}) takes ${descs.length} argument(s) - ${JSON.stringify(action.args)}; ${g.length} given`);
    const data = session.state.models[entry.modelKey || 'MAIN']?.data || {};
    let rowData;
    let params = null;
    if (action.scope !== 'row' && rowIndex !== undefined && rowIndex !== null) {
      throw new AgentError(`\`row\` is for row actions - ${action.id} (${action.event}) is a screen action; leave \`row\` out`);
    }
    const t = action.scope === 'row' ? session.lastIndex.tables.get(tableId) : null;
    if (action.scope === 'row') {
      const count = t ? t.table.rowCount : 0;
      // an argument the row would fill: a row property, the source control's
      // property in the row, or an event parameter that is the row
      const probe = picked || (count ? [0] : null);
      const probeParams = rowEventParams(entry, t, probe);
      const readsRow = (d) => ['row', 'source'].includes(d.kind)
        || (['parameters', 'expr'].includes(d.kind) && rowParamArg(d, probeParams, t, data) !== UNKNOWN);
      const needsRow = descs.some((d, i) => !d.static && (g[i] === undefined || g[i] === null) && readsRow(d));
      if (rowIndex === undefined || rowIndex === null) {
        if (needsRow && !picked) throw new AgentError(`action ${action.id} (${action.event}) is a row action of table ${tableId} (${count} rows) - pass \`row\` (0-${Math.max(0, count - 1)})`);
      } else {
        if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= count) throw new AgentError(`table ${tableId} has ${count} row(s) - row ${rowIndex} does not exist (rows are 0-based)`);
        rowData = t ? getAt(data, `${t.path}/${rowIndex}`) : undefined;
      }
      params = rowEventParams(entry, t, picked || (rowIndex !== undefined && rowIndex !== null ? [rowIndex] : null));
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
      if (params) {
        const v = rowParamArg(d, params, t, data);
        if (v !== UNKNOWN) return v === undefined ? null : v;
      }
      if (entry.pick && picked && !picked.length && rowEventParams(entry, t, [0]) && t.table.rowCount
        && rowParamArg(d, rowEventParams(entry, t, [0]), t, data) !== UNKNOWN) {
        throw new AgentError(`argument ${i} of ${action.event} (${d.describe}) reads the picked row and none is selected - pass \`row\`, or the value in args[${i}]`);
      }
      throw new AgentError(`argument ${i} of ${action.event} (${d.describe}) is computed in the browser - pass its value in args[${i}]`);
    });
  }

  // ------------------------------------------------------------ act ----

  async function actNow(session, { values, event, args, row, maxRows } = {}) {
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
    let body;
    let sent;
    let modelKey;
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
      const picked = entry.pick ? applyPick(entry, row, session) : null;
      const tArgs = eventArgs(entry, args, row, session, picked);
      modelKey = entry.modelKey || 'MAIN';
      // what goes out: the edits pending NOW - the ones made while the
      // roundtrip is in flight are not part of it
      sent = new Map(session.pending[modelKey] || []);
      body = { S_FRONT: { ID: session.state.id, EVENT: entry.action.event } };
      if (tArgs.length) body.S_FRONT.T_EVENT_ARG = tArgs;
      if (sent.size && session.state.models[modelKey]) body.MODEL = buildDelta([...sent.keys()], session.state.models[modelKey].data);
    } catch (e) {
      // a refused act changes nothing: neither the pending edits nor the
      // models (nothing ran in between - this part does not wait)
      session.pending = savedPending;
      session.state = { ...session.state, models: JSON.parse(savedModels) };
      throw e;
    }
    const edits = editsSince(session, savedPending);
    let response;
    try {
      response = await post(body, session);
    } catch (e) {
      rollBack(session, edits, savedPending, JSON.parse(savedModels));
      throw e;
    }
    // only what the roundtrip carried is done with: an edit made while it
    // was in flight (another value, or a path it did not carry) stays pending
    const pendingNow = session.pending[modelKey];
    if (pendingNow) {
      for (const [p, v] of sent) if (pendingNow.has(p) && pendingNow.get(p) === v) pendingNow.delete(p);
    }
    adopt(session, response);
    res = analyze(session, maxRows);
    session.lastIndex = res.index;
    return res.snapshot;
  }

  /* The edits this act made (its values, its pick): every pending path that
   * differs from what was pending before it. */
  function editsSince(session, savedPending) {
    const edits = [];
    for (const [key, map] of Object.entries(session.pending)) {
      const before = savedPending[key];
      for (const [p, v] of map) if (!(before && before.has(p) && before.get(p) === v)) edits.push({ key, p, v });
    }
    return edits;
  }

  /*
   * A roundtrip that failed takes back the edits of ITS act - not the ones
   * made while it was in flight: a path is restored only while it still
   * holds what this act put there.
   */
  function rollBack(session, edits, savedPending, savedModels) {
    for (const { key, p, v } of edits) {
      const map = session.pending[key];
      if (!map || map.get(p) !== v) continue;
      const before = savedPending[key];
      if (before && before.has(p)) map.set(p, before.get(p));
      else map.delete(p);
      const model = session.state.models[key];
      if (model) setAt(model.data, p, savedModels[key] ? getAt(savedModels[key].data, p) : undefined);
    }
  }

  // --------------------------------------------------------- operations ----

  return {
    /** app_start: POST the app start, adopt the answer, apply `values` as pending. */
    async start(app, { values, maxRows } = {}) {
      const cls = String(app || '').trim();
      if (!cls) throw new AgentError('pass `app` - the class to start, e.g. z2ui5_cl_smp_app_009 (app_list names the built ones)');
      const where = await locate(cls);
      const response = await post({ S_FRONT: { ORIGIN: where.origin, PATHNAME: where.pathname, SEARCH: where.search } }, null);
      const session = {
        state: emptyState(), ids: new Set(), pending: { MAIN: new Map(), POPUP: new Map(), POPOVER: new Map() },
        generation: currentGeneration(), maxRows: maxRows ?? DEFAULT_MAX_ROWS, lastIndex: null,
        contextId: null, queue: Promise.resolve(),
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

    /*
     * app_act: validate, apply values, fire the event (or keep the values
     * pending). One roundtrip at a time per session (protocol
     * spec/transport.md "Client behaviour"): an act with an event while
     * another is in flight waits for it and then runs on the screen and the
     * draft id that one left - two overlapping requests would continue the
     * same draft, and the later answer would drop what the earlier did. The
     * session id is checked when the act is CALLED, so the queued act may
     * name the draft the one in flight continues. Values without an event
     * start no roundtrip and apply at once, as typing does while the browser
     * waits; the act in flight leaves them pending.
     */
    async act(sessionId, opts = {}) {
      const session = find(sessionId);
      const { event } = opts;
      if (event === undefined || event === null || event === '') return actNow(session, opts);
      const run = session.queue.then(() => {
        if (generation && session.generation !== generation()) {
          throw new AgentError(`session '${sessionId}' was started on a backend that has since stopped or restarted - its drafts are gone; app_start ${session.state.app || 'the app'} again`);
        }
        return actNow(session, opts);
      });
      session.queue = run.catch(() => {});
      return run;
    },

    /** The open sessions (for diagnostics and the error texts). */
    sessions() {
      return sessions.map((s) => ({ session: s.state.id, app: s.state.app }));
    },
  };
}

