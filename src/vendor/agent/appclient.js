/*
 * VENDORED - do not edit. abap2UI5/mcp-server lib/appclient.mjs
 * at commit 185baed6e16709ee4f45323422dd58becbae23ff,
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
  applyResponse, analyzeScreen, emptyState, getAt, setAt, rebuiltModels, writablePath, DEFAULT_MAX_ROWS,
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
  const text = shownBody(body);
  return `HTTP ${status}${text ? `: ${text}` : ''}`;
}

/** A body as errorText shows it, without the status - also the 2xx answer
 *  that is no JSON (a logon page), which went out with its control
 *  characters. */
function shownBody(body, maxChars = ERROR_CHARS) {
  const all = String(body ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, REPLACEMENT)
    .replace(/\r\n?/g, '\n')
    // not /\s+$/: tried at every position of a long whitespace run that is
    // not at the end, it is quadratic - a body padded with 100k blanks held
    // the whole server for seconds
    .trimEnd();
  const lines = all.split('\n');
  let text = lines.slice(0, ERROR_LINES).join('\n');
  let cut = lines.length > ERROR_LINES;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    cut = true;
  }
  if (cut) text += `\n... (${all.length - text.length} more characters)`;
  return text;
}

/* An argument as an error text repeats it: at most 80 characters - a
 * session id of 150k characters came back as a 150k error. */
const echo = (v) => {
  const t = String(v);
  return t.length > 80 ? `${t.slice(0, 80)}...` : t;
};

const listOf = (items) => {
  const shown = items.slice(0, LIST_MAX);
  return shown.join(', ') + (items.length > shown.length ? `, ... (${items.length - shown.length} more)` : '');
};

/** The hint after "the backend did not answer (...)" on the local backend. */
export const LOCAL_BACKEND_HINT = 'is it running? backend { action: "status" } says';

/** The protocol number this client is written for (protocol
 *  spec/versioning.md): a response declaring another one is refused. */
export const PROTOCOL = 2;

/** How many earlier draft ids of a session are still named as earlier states. */
export const EARLIER_IDS = 100;

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
 *
 * Per call, start() and act() take a `signal` beside their other options: the
 * caller's cancellation (an MCP request the client cancelled), combined with
 * the timeout - the roundtrip is aborted and the act refused as cancelled,
 * its edits taken back like any failed roundtrip's.
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

  /* The caller's `signal` (start/act option) aborted: the request is
   * cancelled - said as that, not as a backend that did not answer, and
   * nothing of a response that arrived anyway is adopted. */
  const cancelled = (signal) => {
    if (signal && signal.aborted) throw new AgentError('cancelled by the caller - nothing of this roundtrip was adopted');
  };

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
  async function post(body, session, cancel) {
    const draftId = body.S_FRONT && body.S_FRONT.ID ? String(body.S_FRONT.ID) : null;
    const serialized = JSON.stringify({ value: body });
    cancelled(cancel);
    /* the timeout, and the caller's own signal when it passed one (an MCP
     * request the client cancelled): either ends the roundtrip */
    const signal = cancel ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancel]) : AbortSignal.timeout(timeoutMs);
    const send = () => roundtrip({ method: 'POST', body: serialized, headers: requestHeaders(session), signal, draftId });
    let res;
    try {
      res = await send();
      if (csrfRequired(res) && await fetchCsrfToken(session, signal, draftId)) res = await send();
    } catch (e) {
      // the transport's own refusal (the system mode's breaker) is the
      // answer as it stands, not a network problem
      if (e instanceof AgentError) throw e;
      cancelled(cancel);
      throw new AgentError(`the backend did not answer (${(e && e.message) || e})${backendHint ? ` - ${backendHint}` : ''}`);
    }
    cancelled(cancel);
    const text = String(res.body ?? '');
    if (!(res.status >= 200 && res.status < 300)) throw new AgentError(`the backend refused the roundtrip - ${errorText(res.status, text)}`);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AgentError(`the backend answered no JSON: ${shownBody(text, 300)}`);
    }
    if (!json || !json.S_FRONT) throw new AgentError(`the backend answered without S_FRONT: ${shownBody(text, 300)}`);
    // checked before anything of the response is read (spec/versioning.md):
    // a present and different number is refused whole, its ID included;
    // an absent one is let through (a backend older than the field)
    const declared = json.S_FRONT.PROTOCOL;
    if (declared !== undefined && declared !== null && Number(declared) !== PROTOCOL) {
      const newer = Number(declared) > PROTOCOL;
      throw new AgentError(`the backend answered protocol ${JSON.stringify(declared)}, this client speaks protocol ${PROTOCOL} - `
        + `the ${newer ? 'client' : 'backend'} is older; nothing of the response was adopted (update the ${newer ? 'client' : 'backend'})`);
    }
    /* The frontend iterates both lists; anything else is a broken backend,
     * said as such - it used to surface as "object is not iterable". */
    const act = json.S_FRONT.S_ACTION;
    for (const list of ['T_SYSTEM', 'T_CUSTOM']) {
      const v = act && act[list];
      if (v !== undefined && v !== null && !Array.isArray(v)) {
        throw new AgentError(`the backend answered an S_ACTION.${list} that is no list: ${shownBody(JSON.stringify(v), 200)}`);
      }
    }
    const contextId = headerOf(res.headers, 'sap-contextid');
    return { json, contextId: validContextId(contextId) ? contextId : null };
  }

  function remember(session) {
    sessions.push(session);
    while (sessions.length > maxSessions) {
      const old = sessions.shift();
      old.evicted = true; // an act still in flight must not bring it back unlisted (adopt)
      /* only the ids that still name IT: sessions started from one screen
       * share its draft id (the playground's Pilot starts one from its
       * mirror on every change of the reader's typing), and evicting the
       * oldest took the newest's id with it - "unknown session" */
      for (const id of old.ids) if (byId.get(id) === old) byId.delete(id);
    }
  }

  function adopt(session, { json: response, contextId }) {
    // a response without the header keeps the established session id
    if (contextId) session.contextId = contextId;
    session.state = applyResponse(session.state, response);
    const id = session.state.id;
    if (id) {
      session.ids.delete(id); // the current id last: the eviction below never takes it
      session.ids.add(id);
      if (!session.evicted) {
        byId.set(id, session);
        /* The session in use is the last to go: eviction takes the least
         * recently USED one, not the first started - an agent working in one
         * app while it starts others to compare kept losing the one it was
         * working in. */
        const at = sessions.indexOf(session);
        if (at >= 0 && at !== sessions.length - 1) {
          sessions.splice(at, 1);
          sessions.push(session);
        }
      }
      /* The earlier ids are kept to name them as earlier states (find) -
       * the last EARLIER_IDS of them. Every roundtrip answers a new draft id,
       * and all of them were kept for the session's life: ~150 bytes per act
       * that a long-running server never gave back. An older id is an
       * unknown session, whose refusal names the open ones. */
      while (session.ids.size > EARLIER_IDS + 1) {
        const old = session.ids.values().next().value;
        session.ids.delete(old);
        if (byId.get(old) === session) byId.delete(old);
      }
    }
    // edits the roundtrip did not carry survive a model push, as the
    // frontend re-applies its pending paths after setData - but not a view
    // the response displays anew: its model is a new one, and the edits made
    // in the old view are gone with it (they would otherwise go out with the
    // new view's next event)
    const rebuilt = rebuiltModels(response);
    for (const [key, map] of Object.entries(session.pending)) {
      const m = session.state.models[key];
      if (!m || rebuilt.has(key)) {
        session.pending[key] = new Map();
        continue;
      }
      for (const [p, v] of map) reapply(m.data, p, v);
    }
  }

  /* The re-apply is JSONModel#setProperty's: the value lands where its
   * parent object exists, nothing is created - an edit of row 5 of a table
   * the push shrank to two rows stays pending without making the table six
   * rows long (setAt filled the gap with holes the snapshot listed as rows). */
  function reapply(data, p, v) {
    const segs = String(p).split('/').filter((x) => x !== '');
    if (!segs.length || !writablePath(p)) return;
    const parent = getAt(data, segs.slice(0, -1).join('/'));
    if (parent !== null && typeof parent === 'object') parent[segs[segs.length - 1]] = v;
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
      throw new AgentError(`unknown session '${echo(sessionId)}' - start one with app_start${known.length ? `; open sessions: ${listOf(known)}` : ''}`);
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
      /* a number, or a string that IS one in decimal - the agent addon's rule
       * (describe_arg). Number() also took true (1), '0x10' (16), '1e400'
       * and 'Infinity', and an infinite value went out as null: the field's
       * initial value, sent without a word */
      const n = typeof value === 'number' ? value
        : (typeof value === 'string' && /^-?[0-9]+(\.[0-9]+)?$/.test(value.trim()) ? Number(value) : NaN);
      if (!Number.isFinite(n)) throw new AgentError(`${label} holds a number - ${JSON.stringify(value)} is none`);
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
      if (!t) throw new AgentError(`no field '${echo(key)}' on this screen - ${fieldHelp(snapshot)}`);
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
    // a binding through a prototype ({/__proto__/x}) is no model field - the
    // write would land on Object.prototype of this process
    const unsafe = plan.find((x) => !writablePath(x.path));
    if (unsafe) throw new AgentError(`${unsafe.path} is no model path a value can be written to (it runs through __proto__, constructor or prototype)`);
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
    if (!named.length) throw new AgentError(`no action '${echo(e)}' on this screen - ${actionHelp(snapshot)}`);
    const enabled = named.filter((a) => a.enabled);
    const pool = enabled.length ? enabled : named;
    // without a row, a screen action of that name before a row action - a
    // "delete selected" button after a table with a DELETE per row was
    // reachable by its id only
    const given = row !== undefined && row !== null;
    const pick = (given ? pool.find((a) => a.scope === 'row') : pool.find((a) => a.scope !== 'row')) || pool[0];
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
  /* An item or a context anywhere in a value: `${$parameters>/}` (and
   * `${$parameters>}`) is the WHOLE parameter object, which holds them one
   * level down - this client's markers ({"$item":0}, {"$ctx":0}) went out as
   * the event argument, where the browser sends the controls marshalled. */
  const holdsItem = (v) => isItem(v) || (v !== null && typeof v === 'object' && Object.values(v).some(holdsItem));

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
    if (holdsItem(node)) return UNKNOWN;
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
        if (v === undefined) {
          /* ${$source>/id} of a control the view gives no id: UI5 generates
           * one (a row button's is a clone id like __button0-__clone3) and
           * only the browser knows it. What a backend does with it is
           * almost always anchoring a popover (popover_display by_id) - and
           * "pass it in args" alone left the agent to guess a value that
           * does not exist outside the browser. */
          if (d.prop === 'id') {
            throw new AgentError(`argument ${i} of ${action.event} (${d.describe}) is the id UI5 generates for the pressed control - the view sets none, so only a browser knows it. `
              + `Pass any id in args[${i}] (e.g. "${action.id}"): a backend that only anchors a popover to it (popover_display by_id) answers the same, since this client places no popover`);
          }
          throw new AgentError(`argument ${i} of ${action.event} (${d.describe}) cannot be read here - pass it in args[${i}]`);
        }
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

  /* What makes an action the same action across two analyses of one screen:
   * everything but its id and what values may legitimately change (its
   * label, its enabled state). */
  const actionSignature = (a) => JSON.stringify([a.event, a.trigger, a.control, a.scope, a.table, a.layer, a.args]);

  /* `row` is a row index: a non-negative integer, as a JSON number or a
   * string of decimal digits. It was read with Number() (server.mjs), so ""
   * false and [] became row 0 and true row 1 - an act on a row nobody
   * named. The agent addon takes a JSON number that describe_arg reads as
   * an integer >= 0 and refuses the rest; a string of digits is taken here
   * too, as for a number field (coerce). */
  function rowArgument(row) {
    if (row === undefined || row === null) return undefined;
    const n = typeof row === 'number' ? row
      : (typeof row === 'string' && /^[0-9]+$/.test(row.trim()) ? Number(row) : NaN);
    if (!Number.isInteger(n) || n < 0) throw new AgentError(`\`row\` is a row index (0-based) - a non-negative integer, not ${JSON.stringify(row)}`);
    return n;
  }

  /* What an act names on the screen on display: its action (by signature)
   * and the model path of every value - validated as actNow validates it. */
  function intentOf(session, { values, event, row: rowGiven, maxRows } = {}) {
    const row = rowArgument(rowGiven);
    const res = analyze(session, maxRows);
    const entry = findAction(event, row, res.snapshot, res.index);
    return { id: session.state.id, sig: actionSignature(entry.action), paths: targetPaths(values, res.snapshot, res.index) };
  }

  function targetPaths(values, snapshot, index) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
    const out = {};
    for (const key of Object.keys(values)) {
      const t = resolveTarget(key, snapshot, index);
      out[key] = !t ? null : t.kind === 'field' ? `${t.modelKey}:${t.field.path}` : `${t.entry.modelKey}:${t.table.path}/${t.row}/${t.col}`;
    }
    return out;
  }

  async function actNow(session, { values, event, args, row: rowGiven, maxRows, signal } = {}, expect = null) {
    const row = rowArgument(rowGiven);
    let res = analyze(session, maxRows);
    session.lastIndex = res.index;
    // validate everything before anything changes
    let entry = null;
    if (event !== undefined && event !== null && event !== '') {
      entry = findAction(event, row, res.snapshot, res.index);
      if (expect) {
        const paths = targetPaths(values, res.snapshot, res.index);
        const moved = actionSignature(entry.action) !== expect.sig
          || Object.keys(expect.paths).some((k) => paths[k] !== expect.paths[k]);
        if (moved) {
          throw new AgentError(`the screen changed while an earlier act was in flight - '${event}' `
            + `${actionSignature(entry.action) !== expect.sig ? `is ${entry.action.id} (${entry.action.event}) on the new screen` : 'names other fields on the new screen'}; `
            + `nothing was sent - continue from the new snapshot (session '${session.state.id}')`);
        }
      }
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
      /* Ids follow the document order, so a value that shows or hides a
       * control renumbers them: the same id can name ANOTHER action now, and
       * firing it would send an event that was never asked for or checked.
       * The re-read must be the action validated above - under its id, or
       * the one action of the new screen that is the same; anything else is
       * refused (as the abap2UI5 agent addon refuses it). An id the values
       * left with nothing behind it (they hid the action) is looked for the
       * same way: the old snapshot's entry was fired, a control the screen
       * no longer shows. And the re-read action must still be enabled - a
       * value can disable it (enabled="{/OPEN}"), and the browser cannot
       * press it then. All before anything is sent; the catch below takes
       * the values back. */
      const sig = actionSignature(entry.action);
      let again = res.index.actions.get(entry.action.id);
      if (!again || actionSignature(again.action) !== sig) {
        const same = [...res.index.actions.values()].filter((x) => actionSignature(x.action) === sig);
        if (same.length !== 1) {
          throw new AgentError(`the values change the screen - action ${entry.action.id} `
            + `${again ? `is no longer ${entry.action.event}` : `(${entry.action.event}) is no longer on it`}; `
            + 'fill the values without an event first, then fire it from the next snapshot');
        }
        again = same[0];
      }
      if (!again.action.enabled) {
        throw new AgentError(`action ${again.action.id} (${again.action.label}) is disabled once the values are filled - ${actionHelp(res.snapshot)}`);
      }
      entry = again;
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
      response = await post(body, session, signal);
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
    async start(app, { values, maxRows, signal } = {}) {
      const cls = String(app || '').trim();
      if (!cls) throw new AgentError('pass `app` - the class to start, e.g. z2ui5_cl_smp_app_009 (app_list names the built ones)');
      const where = await locate(cls);
      const response = await post({ S_FRONT: { ORIGIN: where.origin, PATHNAME: where.pathname, SEARCH: where.search } }, null, signal);
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
        /* the app runs whether its values are taken or not: a refusal names
         * the session it started, as the agent addon's does - without it the
         * started app was out of reach and the next app_start a second one */
        try {
          applyValues(session, values, res.snapshot, res.index);
        } catch (e) {
          if (e instanceof AgentError) throw new AgentError(`${e.message} (the app is running: session ${session.state.id} - app_describe shows it)`);
          throw e;
        }
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

    /** The folded screen state of a session - the views in their slots, the
     *  models with the pending edits in them, the last response's T_CUSTOM -
     *  as a copy, for a renderer other than the snapshot (the Adaptive Card
     *  of `format: "adaptive-card"`). Reads only, like describe. */
    screen(sessionId) {
      return JSON.parse(JSON.stringify(find(sessionId).state));
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
      /* Queued behind a roundtrip in flight, the act runs on the screen that
       * one answers - but its ids were read from the screen on display now.
       * Two app_act { event: "a1" } at once fired NEXT and then whatever a1
       * is on the next screen (DELETE_ALL), unseen. What the act names is
       * resolved here, and it runs only where it still names the same. */
      const expect = session.busy ? intentOf(session, opts) : null;
      session.busy = (session.busy || 0) + 1;
      const run = session.queue.then(() => {
        if (generation && session.generation !== generation()) {
          throw new AgentError(`session '${sessionId}' was started on a backend that has since stopped or restarted - its drafts are gone; app_start ${session.state.app || 'the app'} again`);
        }
        return actNow(session, opts, expect && expect.id !== session.state.id ? expect : null);
      }).finally(() => {
        session.busy -= 1;
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

