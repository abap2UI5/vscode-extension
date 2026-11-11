/*
 * The last roundtrips of the running app, and what each of them changed.
 *
 * There is no debugger. The traffic log says THAT a roundtrip happened and
 * how long it took; this module keeps the last few request and response
 * bodies the auth proxy saw, so "Show Roundtrip" can answer what the event
 * was, which arguments it carried and which model paths the backend changed
 * - and "Replay Roundtrip" can send the stored request once more.
 *
 * The bodies are the app's data: customer names, prices, whatever the screen
 * shows. So they live in MEMORY ONLY, in private fields of `Roundtrip`:
 *
 *   - nothing here writes a file, and nothing here formats a body into a log
 *     line - the only strings this module produces for a log are the caller's
 *     to build from `label( )`, which carries no body;
 *   - a `Roundtrip` that ends up in `JSON.stringify`, a template string or
 *     `util.inspect` shows its number, time and sizes, never a body
 *     (`report.test.ts` pins that against the bug report);
 *   - the ring holds `ROUNDTRIP_CAP` entries, a body over `BODY_CAP_BYTES`
 *     is not kept at all (the entry says so), and the ring is emptied when
 *     the proxy stops or the system changes.
 *
 * The body shape is abap2UI5's own protocol, as its frontend speaks it
 * (app/webapp/core/Server.js; mcp-server's lib/appclient.mjs is the other
 * reader of it in this repository, vendored and loaded apart from the
 * activation bundle - nothing is imported from it here):
 *
 *   start   POST { value: { S_FRONT: { ORIGIN, PATHNAME, SEARCH: '?app_start=<CLASS>' } } }
 *   event   POST { value: { S_FRONT: { ID, EVENT, T_EVENT_ARG: [...] },
 *                           MODEL: <delta of what was edited in the browser> } }
 *   answer  { S_FRONT: { ID, APP, S_ACTION }, MODEL? }
 *
 * "What counts as the model" is decided here, in one place:
 *
 *   - AFTER a roundtrip the model is the answer's `MODEL`. An answer without
 *     one leaves the model as it was (the backend only sends what changed).
 *   - BEFORE a roundtrip the model is what the previous roundtrip left - the
 *     stored roundtrip whose answer handed out the draft id this request
 *     continues - with the request's own delta applied: what the user typed
 *     since then is part of the state the event ran on, and must not be
 *     blamed on the backend. An app start begins with an empty model.
 *   - When the previous roundtrip is no longer stored (or its body was too
 *     large to keep), "before" is unknown and said to be - never guessed.
 *
 * `vscode`-free: buffers and bodies in, plain values out.
 */

import * as zlib from "zlib";
import { formatBytes } from "./traffic";
import { redactQueryCredentials } from "./report";

/** How many roundtrips are kept. */
export const ROUNDTRIP_CAP = 20;
/** The largest request or response body that is kept, decoded. */
export const BODY_CAP_BYTES = 512 * 1024;

/**
 * The request headers a replay sends again - the ones the frontend's
 * roundtrip is made of. Everything else is the browser's connection to the
 * proxy. `cookie` and the two session headers are kept (in memory, like the
 * bodies) because a stateful app's roundtrip is addressed by them.
 */
export const REPLAY_HEADERS = [
  "content-type",
  "accept",
  "cookie",
  "origin",
  "x-csrf-token",
  "sap-contextid",
  "sap-contextid-accept",
] as const;

// ---------------------------------------------------------------------------
// Capturing
// ---------------------------------------------------------------------------

/**
 * Collects a body as it streams past, up to a cap. Past the cap everything
 * collected so far is dropped at once - an upload or a download that is not
 * a roundtrip must not sit in memory because it was a POST.
 */
export class BodyTap {
  private chunks: Buffer[] = [];
  private size = 0;
  private overflow = false;

  constructor(private readonly cap = BODY_CAP_BYTES) {}

  push(chunk: Buffer): void {
    this.size += chunk.length;
    if (this.overflow) {
      return;
    }
    if (this.size > this.cap) {
      this.overflow = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(chunk);
  }

  /** Bytes seen, kept or not. */
  get bytes(): number {
    return this.size;
  }

  /** The body, or undefined when it was larger than the cap. */
  take(): Buffer | undefined {
    return this.overflow ? undefined : Buffer.concat(this.chunks);
  }
}

/** A body as kept: its bytes (decoded, UTF-8), or the reason there are none. */
type StoredBody = { bytes: Buffer } | { omitted: string };

const tooLarge = (cap: number) =>
  `larger than ${formatBytes(cap)} - not stored`;

/**
 * A body as it travelled, undone to plain bytes. The proxy pipes responses
 * through untouched, so what it sees is whatever `Content-Encoding` the
 * system chose. The cap applies to the DECODED size: 512 KB of gzip can be
 * many megabytes of JSON.
 */
export function decodeContent(
  body: Buffer | undefined,
  encoding: string,
  cap = BODY_CAP_BYTES
): StoredBody {
  if (body === undefined) {
    return { omitted: tooLarge(cap) };
  }
  const codings = encoding
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c && c !== "identity")
    .reverse();
  let bytes = body;
  try {
    for (const coding of codings) {
      const options = { maxOutputLength: cap };
      if (coding === "gzip" || coding === "x-gzip") {
        bytes = zlib.gunzipSync(bytes, options);
      } else if (coding === "deflate") {
        try {
          bytes = zlib.inflateSync(bytes, options);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
            throw err;
          }
          // some servers send the raw stream under this name
          bytes = zlib.inflateRawSync(bytes, options);
        }
      } else if (coding === "br") {
        bytes = zlib.brotliDecompressSync(bytes, options);
      } else {
        return { omitted: `content-encoding "${coding}" is not understood - not stored` };
      }
    }
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
      ? { omitted: tooLarge(cap) }
      : { omitted: "the body could not be decompressed - not stored" };
  }
  return bytes.length > cap ? { omitted: tooLarge(cap) } : { bytes };
}

/** What the proxy hands over for one finished POST. */
export interface RoundtripCapture {
  /** ms timestamp of the request. */
  at: number;
  /** The forwarded path with its query - never the proxy's token. */
  path: string;
  status: number;
  durationMs: number;
  /** Lower-case names, as node delivers them. */
  requestHeaders: Record<string, string | string[] | undefined>;
  /** Undefined when it was larger than the cap. */
  requestBody: Buffer | undefined;
  requestBytes: number;
  responseBody: Buffer | undefined;
  /** Response size on the wire. */
  responseBytes: number;
  /** The response's `Content-Encoding`. */
  responseEncoding: string;
  /**
   * Which system (profile) the roundtrip belongs to. A capture under another
   * scope than the stored ones empties the ring first - two profiles may
   * share an origin, and then the proxy does not restart between them.
   */
  scope?: string;
}

// ---------------------------------------------------------------------------
// The protocol's bodies
// ---------------------------------------------------------------------------

type Json = unknown;
type JsonObject = Record<string, Json>;

const isObject = (v: Json): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** What a request body says, as far as it is an abap2UI5 roundtrip. */
export interface ParsedRequest {
  /** The class an app start names - then there is no event. */
  startClass?: string;
  /** The draft id the request continues. */
  draftId?: string;
  event?: string;
  args: Json[];
  /** The model delta sent along - what was edited in the browser. */
  delta?: JsonObject;
}

/** Undefined when the text is not an abap2UI5 request at all. */
export function parseRequest(text: string): ParsedRequest | undefined {
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  // the frontend wraps the body in `value`; a caller that does not is read too
  const body = isObject(json) && isObject(json.value) ? json.value : json;
  if (!isObject(body) || !isObject(body.S_FRONT)) {
    return undefined;
  }
  const front = body.S_FRONT;
  const out: ParsedRequest = {
    args: Array.isArray(front.T_EVENT_ARG) ? front.T_EVENT_ARG : [],
  };
  if (front.ID !== undefined && front.ID !== null && front.ID !== "") {
    out.draftId = String(front.ID);
  }
  if (typeof front.EVENT === "string" && front.EVENT) {
    out.event = front.EVENT;
  }
  if (!out.draftId && typeof front.SEARCH === "string") {
    const started = new URLSearchParams(front.SEARCH.replace(/^\?/, "")).get("app_start");
    out.startClass = (started ?? "").toUpperCase() || undefined;
  }
  if (isObject(body.MODEL)) {
    out.delta = body.MODEL;
  }
  return out;
}

/** What an answer says. */
export interface ParsedResponse {
  /** The draft id the next request continues. */
  draftId?: string;
  /** The class that answered. */
  app?: string;
  /** The model, when the answer carries one. */
  model?: Json;
}

export function parseResponse(text: string): ParsedResponse | undefined {
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(json) || !isObject(json.S_FRONT)) {
    return undefined;
  }
  const front = json.S_FRONT;
  const out: ParsedResponse = {};
  if (front.ID !== undefined && front.ID !== null && front.ID !== "") {
    out.draftId = String(front.ID);
  }
  if (typeof front.APP === "string" && front.APP) {
    out.app = front.APP;
  }
  if (json.MODEL !== undefined) {
    out.model = json.MODEL;
  }
  return out;
}

/**
 * A request's model delta applied to a model, as the frontend builds it
 * (core/Lib.js buildDeltaFromPaths): a scalar or structure edit ships the
 * whole top-level attribute, a table cell edit ships
 * `{ TAB: { __delta: { <row>: { COL: v } } } }`, recursively for nested
 * tables. The input is not modified.
 */
export function applyDelta(model: Json, delta: JsonObject | undefined): Json {
  if (!delta) {
    return model;
  }
  const next: JsonObject = isObject(model) ? structuredClone(model) : {};
  const rowsInto = (table: Json, rows: Json): Json => {
    if (!isObject(rows)) {
      return table;
    }
    const out: Json[] = Array.isArray(table) ? table : [];
    for (const [index, fields] of Object.entries(rows)) {
      const at = Number(index);
      if (!Number.isInteger(at) || at < 0 || !isObject(fields)) {
        continue;
      }
      const row: JsonObject = isObject(out[at]) ? (out[at] as JsonObject) : {};
      for (const [field, value] of Object.entries(fields)) {
        row[field] =
          isObject(value) && "__delta" in value
            ? rowsInto(row[field], value.__delta)
            : value;
      }
      out[at] = row;
    }
    return out;
  };
  for (const [key, value] of Object.entries(delta)) {
    next[key] =
      isObject(value) && "__delta" in value
        ? rowsInto(next[key], value.__delta)
        : structuredClone(value);
  }
  return next;
}

/** The model paths a delta touches - `/MV_NAME`, `/MT_ROWS/2/QTY`. */
export function deltaPaths(delta: JsonObject | undefined): string[] {
  const out: string[] = [];
  const walk = (prefix: string, value: Json): void => {
    if (!isObject(value) || !("__delta" in value) || !isObject(value.__delta)) {
      out.push(prefix);
      return;
    }
    for (const [row, fields] of Object.entries(value.__delta)) {
      if (!isObject(fields)) {
        continue;
      }
      for (const [field, inner] of Object.entries(fields)) {
        walk(`${prefix}/${row}/${field}`, inner);
      }
    }
  };
  for (const [key, value] of Object.entries(delta ?? {})) {
    walk(`/${key}`, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------

/** One difference between two models, at the deepest path that differs. */
export interface ModelChange {
  /** A UI5 binding path: `/MT_ROWS/2/QTY`. */
  path: string;
  kind: "changed" | "added" | "removed";
  before?: Json;
  after?: Json;
}

/**
 * Every path whose value differs between two models. Objects are compared
 * key by key and arrays index by index, so a change inside a table row is
 * one path and not "the table changed"; a row past the other side's end is
 * added or removed as a whole. A value that changed its kind (a table that
 * became a string) is one change at that path.
 */
export function diffModels(before: Json, after: Json): ModelChange[] {
  const out: ModelChange[] = [];
  const walk = (path: string, a: Json, b: Json): void => {
    if (isObject(a) && isObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const at = `${path}/${key}`;
        if (!(key in b)) {
          out.push({ path: at, kind: "removed", before: a[key] });
        } else if (!(key in a)) {
          out.push({ path: at, kind: "added", after: b[key] });
        } else {
          walk(at, a[key], b[key]);
        }
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const at = `${path}/${i}`;
        if (i >= b.length) {
          out.push({ path: at, kind: "removed", before: a[i] });
        } else if (i >= a.length) {
          out.push({ path: at, kind: "added", after: b[i] });
        } else {
          walk(at, a[i], b[i]);
        }
      }
      return;
    }
    const same =
      a === b ||
      (typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b));
    if (!same) {
      out.push({ path: path || "/", kind: "changed", before: a, after: b });
    }
  };
  walk("", before, after);
  return out;
}

const shown = (value: Json, max = 60): string => {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** `~ /MV_TITLE: "a" -> "b"`, `+ /MT_ROWS/2: {…}`, `- /MV_OLD: 1`. */
export function formatChange(change: ModelChange): string {
  if (change.kind === "added") {
    return `+ ${change.path}: ${shown(change.after)}`;
  }
  if (change.kind === "removed") {
    return `- ${change.path}: ${shown(change.before)}`;
  }
  return `~ ${change.path}: ${shown(change.before)} -> ${shown(change.after)}`;
}

// ---------------------------------------------------------------------------
// One stored roundtrip
// ---------------------------------------------------------------------------

/** What the picker shows of a roundtrip - no body in it. */
export interface RoundtripSummary {
  seq: number;
  at: number;
  /** The event name, `app start`, or why there is none. */
  event: string;
  args: Json[];
  /** The class that answered (or was started), when the bodies say. */
  className?: string;
  durationMs: number;
  /** Response size on the wire. */
  bytes: number;
  /** False when the request body was not kept - nothing to replay then. */
  replayable: boolean;
  /** Why a body is missing, when one is. */
  notes: string[];
}

/**
 * One roundtrip. The bodies and the headers are `#private`: they do not
 * serialize, do not print and cannot be read without calling for them by
 * name - the structural half of "never in a log, never in a report".
 */
export class Roundtrip {
  readonly #request: StoredBody;
  readonly #response: StoredBody;
  readonly #headers: Record<string, string>;
  readonly #parsedRequest: ParsedRequest | undefined;
  readonly #draftIdOut: string | undefined;
  readonly #app: string | undefined;

  constructor(
    readonly seq: number,
    readonly at: number,
    readonly path: string,
    readonly status: number,
    readonly durationMs: number,
    readonly requestBytes: number,
    readonly responseBytes: number,
    request: StoredBody,
    response: StoredBody,
    headers: Record<string, string>
  ) {
    this.#request = request;
    this.#response = response;
    this.#headers = headers;
    // the small facts the list and the chain need, read once - the models
    // themselves are parsed when somebody looks
    this.#parsedRequest = "bytes" in request ? parseRequest(request.bytes.toString("utf8")) : undefined;
    const answer = "bytes" in response ? parseResponse(response.bytes.toString("utf8")) : undefined;
    this.#draftIdOut = answer?.draftId;
    this.#app = answer?.app;
  }

  /** The request body, or undefined when it was not kept. */
  requestText(): string | undefined {
    return "bytes" in this.#request ? this.#request.bytes.toString("utf8") : undefined;
  }

  responseText(): string | undefined {
    return "bytes" in this.#response ? this.#response.bytes.toString("utf8") : undefined;
  }

  /** The headers a replay sends again (see `REPLAY_HEADERS`). */
  replayHeaders(): Record<string, string> {
    return { ...this.#headers };
  }

  request(): ParsedRequest | undefined {
    return this.#parsedRequest;
  }

  /** The draft id this roundtrip's answer handed out. */
  draftIdOut(): string | undefined {
    return this.#draftIdOut;
  }

  summary(): RoundtripSummary {
    const request = this.#parsedRequest;
    const notes: string[] = [];
    if ("omitted" in this.#request) {
      notes.push(`request body ${this.#request.omitted}`);
    }
    if ("omitted" in this.#response) {
      notes.push(`response body ${this.#response.omitted}`);
    }
    const event = request?.startClass
      ? "app start"
      : (request?.event ?? (request ? "(no event)" : "(request not stored)"));
    return {
      seq: this.seq,
      at: this.at,
      event,
      args: request?.args ?? [],
      className: this.#app ?? request?.startClass,
      durationMs: this.durationMs,
      bytes: this.responseBytes,
      replayable: "bytes" in this.#request,
      notes,
    };
  }

  /** What a serializer gets: the line the traffic log already shows. */
  toJSON(): Record<string, unknown> {
    return {
      seq: this.seq,
      at: this.at,
      path: redactQueryCredentials(this.path),
      status: this.status,
      durationMs: this.durationMs,
      requestBytes: this.requestBytes,
      responseBytes: this.responseBytes,
    };
  }

  toString(): string {
    return `roundtrip #${this.seq} (${this.status}, ${this.durationMs} ms, ${formatBytes(this.responseBytes)})`;
  }
}

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/** The model on both sides of one roundtrip, and what moved. */
export interface RoundtripModels {
  /** Undefined when it is not known - `notes` says why. */
  before: Json | undefined;
  after: Json | undefined;
  /** Empty when either side is unknown. */
  changes: ModelChange[];
  /** The paths the request itself carried: edited in the browser. */
  sent: string[];
  notes: string[];
}

export class RoundtripBuffer {
  private entries: Roundtrip[] = [];
  private seq = 0;
  private scope: string | undefined;

  /** Called after the ring was emptied - whoever shows a body drops it too. */
  onClear?: () => void;

  constructor(
    private readonly cap = ROUNDTRIP_CAP,
    private readonly bodyCap = BODY_CAP_BYTES
  ) {}

  /**
   * Stores one finished POST - when it is an abap2UI5 roundtrip. A POST
   * whose request is readable and is something else (an OData batch, an
   * upload) is not kept: this is not a network recorder. A request too
   * large to read is kept as an entry that says so.
   */
  add(capture: RoundtripCapture): Roundtrip | undefined {
    if (capture.scope !== undefined && this.scope !== undefined && capture.scope !== this.scope) {
      this.clear();
    }
    if (capture.scope !== undefined) {
      this.scope = capture.scope;
    }
    const request: StoredBody =
      capture.requestBody === undefined
        ? { omitted: tooLarge(this.bodyCap) }
        : capture.requestBody.length > this.bodyCap
          ? { omitted: tooLarge(this.bodyCap) }
          : { bytes: capture.requestBody };
    if ("bytes" in request && !parseRequest(request.bytes.toString("utf8"))) {
      return undefined;
    }
    const headers: Record<string, string> = {};
    for (const name of REPLAY_HEADERS) {
      const value = capture.requestHeaders[name];
      if (value !== undefined) {
        headers[name] = Array.isArray(value) ? value.join(", ") : value;
      }
    }
    const entry = new Roundtrip(
      ++this.seq,
      capture.at,
      capture.path,
      capture.status,
      capture.durationMs,
      capture.requestBytes,
      capture.responseBytes,
      request,
      decodeContent(capture.responseBody, capture.responseEncoding, this.bodyCap),
      headers
    );
    this.entries.push(entry);
    while (this.entries.length > this.cap) {
      this.entries.shift();
    }
    return entry;
  }

  /** Newest first. */
  list(): Roundtrip[] {
    return [...this.entries].reverse();
  }

  get(seq: number): Roundtrip | undefined {
    return this.entries.find((e) => e.seq === seq);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Drops every body - on proxy stop, on a system change. */
  clear(): void {
    const had = this.entries.length > 0;
    this.entries = [];
    this.scope = undefined;
    if (had) {
      this.onClear?.();
    }
  }

  /** The stored roundtrip whose answer handed out the draft id `entry`
   *  continues - the state its event ran on. */
  private previousOf(entry: Roundtrip): Roundtrip | undefined {
    const id = entry.request()?.draftId;
    if (!id) {
      return undefined;
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const candidate = this.entries[i];
      if (candidate.seq < entry.seq && candidate.draftIdOut() === id) {
        return candidate;
      }
    }
    return undefined;
  }

  private modelBefore(entry: Roundtrip, notes: string[]): Json | undefined {
    const request = entry.request();
    if (!request) {
      notes.push("the model before is not known: the request body was not stored");
      return undefined;
    }
    if (!request.draftId) {
      return applyDelta({}, request.delta); // an app start begins empty
    }
    const previous = this.previousOf(entry);
    if (!previous) {
      notes.push(
        `the model before is not known: the roundtrip before this one is no longer stored (the last ${this.cap} are kept)`
      );
      return undefined;
    }
    const base = this.modelAfter(previous, notes);
    return base === undefined ? undefined : applyDelta(base, request.delta);
  }

  private modelAfter(entry: Roundtrip, notes: string[]): Json | undefined {
    const text = entry.responseText();
    if (text === undefined) {
      notes.push(`the model after roundtrip #${entry.seq} is not known: its response body was not stored`);
      return undefined;
    }
    const answer = parseResponse(text);
    if (!answer) {
      notes.push(`the answer of roundtrip #${entry.seq} is not an abap2UI5 response`);
      return undefined;
    }
    if (answer.model !== undefined) {
      return answer.model;
    }
    // no MODEL in the answer: the backend changed nothing
    return this.modelBefore(entry, notes);
  }

  /** The model before and after one stored roundtrip, and the difference. */
  models(entry: Roundtrip): RoundtripModels {
    const notes: string[] = [];
    const before = this.modelBefore(entry, notes);
    const afterNotes: string[] = [];
    const after = this.modelAfter(entry, afterNotes);
    for (const note of afterNotes) {
      if (!notes.includes(note)) {
        notes.push(note);
      }
    }
    const previous = this.previousOf(entry);
    const from = previous?.summary().className;
    const to = entry.summary().className;
    if (from && to && from !== to) {
      notes.push(`the app changed with this roundtrip: ${from} -> ${to} (the two sides are different classes' models)`);
    }
    return {
      before,
      after,
      changes: before === undefined || after === undefined ? [] : diffModels(before, after),
      sent: deltaPaths(entry.request()?.delta),
      notes,
    };
  }
}

// ---------------------------------------------------------------------------
// What the commands show
// ---------------------------------------------------------------------------

const clock = (at: number): string => {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

/** `#7  12:03:44  SAVE` - the picker's label. */
export function roundtripLabel(summary: RoundtripSummary): string {
  return `#${summary.seq}  ${clock(summary.at)}  ${summary.event}`;
}

/** `Z_APP · 342 ms · 1.2 kB` - the picker's description. */
export function roundtripDescription(summary: RoundtripSummary): string {
  return [
    summary.className,
    `${summary.durationMs} ms`,
    formatBytes(summary.bytes),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The event's arguments on one line, or that there are none. */
export function formatArgs(args: Json[]): string {
  return args.length ? `arguments: ${shown(args, 200)}` : "no arguments";
}

/** The picker's detail: the arguments, and what is missing. */
export function roundtripDetail(summary: RoundtripSummary): string {
  return [formatArgs(summary.args), ...summary.notes].join(" - ");
}

/** How many changes the header lists before it says "and N more". */
const HEADER_CHANGES = 40;

/**
 * The comment block above both sides of the diff: the event with its
 * arguments, and the changed paths as a list. Identical on both sides, so
 * the diff editor marks the model and nothing else.
 */
export function roundtripHeader(entry: Roundtrip, models: RoundtripModels): string[] {
  const summary = entry.summary();
  const lines = [
    `Roundtrip ${roundtripLabel(summary)} - ${summary.durationMs} ms, ${formatBytes(summary.bytes)}`,
    `${summary.className ? `${summary.className}, ` : ""}POST ${redactQueryCredentials(entry.path)}`,
    summary.event === "app start" ? "app start" : `event ${summary.event}, ${formatArgs(summary.args)}`,
  ];
  if (models.sent.length) {
    lines.push(`sent with the request (edited in the browser): ${models.sent.join(", ")}`);
  }
  for (const note of [...summary.notes, ...models.notes]) {
    lines.push(`note: ${note}`);
  }
  if (models.before !== undefined && models.after !== undefined) {
    const count = (kind: ModelChange["kind"]) => models.changes.filter((c) => c.kind === kind).length;
    lines.push(
      models.changes.length
        ? `the backend changed ${count("changed")}, added ${count("added")}, removed ${count("removed")}:`
        : "the backend changed nothing in the model"
    );
    for (const change of models.changes.slice(0, HEADER_CHANGES)) {
      lines.push(`  ${formatChange(change)}`);
    }
    if (models.changes.length > HEADER_CHANGES) {
      lines.push(`  ... and ${models.changes.length - HEADER_CHANGES} more`);
    }
  }
  return lines;
}

/** A JSONC document: `//` header lines, then the value pretty-printed. */
export function jsoncDocument(header: string[], value: Json | undefined, missing: string): string {
  const head = header.map((line) => `// ${line}`).join("\n");
  const body = value === undefined ? `// ${missing}` : JSON.stringify(value, null, 2);
  return `${head}\n${body}\n`;
}

/** A body as a document: pretty JSON when it is JSON, else as it came. */
export function bodyDocument(header: string[], text: string | undefined, missing: string): string {
  if (text === undefined) {
    return jsoncDocument(header, undefined, missing);
  }
  try {
    return jsoncDocument(header, JSON.parse(text), missing);
  } catch {
    return `${header.map((line) => `// ${line}`).join("\n")}\n${text}\n`;
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/** What the confirmation names - every replay asks, every time. */
export interface ReplayQuestion {
  system: string;
  className: string;
  event: string;
  message: string;
  detail: string;
}

export interface ReplayDeps {
  /** False in Restricted Mode. */
  isTrusted(): boolean;
  /** True when the active system's profile is a production system. */
  isProduction(): boolean;
  /** The modal question; false or undefined means no. */
  confirm(question: ReplayQuestion): Promise<boolean | undefined>;
  /** The running proxy's base url (token included), undefined when stopped. */
  proxyBase(): string | undefined;
  /** Whether the roundtrip is still in the ring - it is emptied when the
   *  proxy stops or the system changes. */
  isStored(entry: Roundtrip): boolean;
  /** One POST to the proxy's loopback origin. */
  request(
    url: string,
    init: { method: "POST"; headers: Record<string, string>; body: string }
  ): Promise<{ status: number; body: string }>;
}

export type ReplayResult =
  | { status: number; body: string; durationMs: number }
  | { refused: string }
  | { cancelled: true };

/** The question a replay asks - exported so its wording is testable. */
export function replayQuestion(
  entry: Roundtrip,
  target: { system: string; className?: string }
): ReplayQuestion {
  const summary = entry.summary();
  const className = summary.className ?? target.className ?? "(unknown class)";
  const what =
    summary.event === "app start"
      ? `the start of ${className}`
      : `the event "${summary.event}" of ${className}`;
  return {
    system: target.system,
    className,
    event: summary.event,
    message: `Replay ${what} on ${target.system}?`,
    detail:
      `The stored request of roundtrip #${summary.seq} is sent to ${target.system} again, ` +
      `and the event runs again for real: whatever its handler does - saving, posting, ` +
      `deleting, sending - happens a second time, under your user. ` +
      `${formatArgs(summary.args)}.`,
  };
}

/**
 * Sends a stored request once more, through the auth proxy's own loopback
 * origin - the path every roundtrip of the preview takes, so the credentials
 * and the TLS decision stay the proxy's.
 *
 * The order of the refusals is the point: Restricted Mode and a production
 * system are refused BEFORE anything is asked, so no dialog can be clicked
 * through, and nothing is sent without a yes.
 */
export async function replayRoundtrip(
  entry: Roundtrip,
  target: { system: string; className?: string },
  deps: ReplayDeps
): Promise<ReplayResult> {
  if (!deps.isTrusted()) {
    return {
      refused:
        "a replay runs an event on the system as you - it is not available in Restricted Mode. Trust the workspace first.",
    };
  }
  if (deps.isProduction()) {
    return {
      refused: `${target.system} is a production system - a replay would run the event there a second time, so it is refused.`,
    };
  }
  const body = entry.requestText();
  if (body === undefined) {
    return {
      refused: `the request of roundtrip #${entry.seq} was not stored (${entry.summary().notes.join("; ")}) - there is nothing to send again.`,
    };
  }
  if (!deps.proxyBase() || !deps.isStored(entry)) {
    return {
      refused:
        "the roundtrip belongs to a proxy session that has ended - run the app again first.",
    };
  }
  if (!(await deps.confirm(replayQuestion(entry, target)))) {
    return { cancelled: true };
  }
  // asked again after the dialog: the proxy may have stopped or switched
  // systems while it was open, and the ring was emptied with it
  const base = deps.proxyBase();
  if (!base || !deps.isStored(entry)) {
    return {
      refused:
        "the auth proxy stopped or the system changed while the question was open - nothing was sent.",
    };
  }
  const startedAt = Date.now();
  const answer = await deps.request(base + entry.path, {
    method: "POST",
    // identity: the answer is read as text here, not by a browser
    headers: { ...entry.replayHeaders(), "accept-encoding": "identity" },
    body,
  });
  return { status: answer.status, body: answer.body, durationMs: Date.now() - startedAt };
}
