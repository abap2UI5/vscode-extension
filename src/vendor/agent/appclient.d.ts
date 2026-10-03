/*
 * Types for the vendored appclient.js (abap2UI5/mcp-server lib/appclient.mjs).
 * Hand-written and THIS repository's own - scripts/vendor-agent.mjs copies
 * the JavaScript, not this file - so a re-vendor that changes an export's
 * shape has to update it here; src/test/agentvendor.test.ts and
 * src/test/agentapps.test.ts exercise it against the real module.
 */
import type { AgentSnapshot } from "./snapshot";

/** A refusal: what was wrong and what is allowed. Becomes an isError result. */
export class AgentError extends Error {
  constructor(message: string);
}

/** The slice of a fetch Response the client reads. */
export interface FetchLikeResponse {
  /** Not read: the status decides. */
  ok?: boolean;
  status: number;
  /** Copied into the transport answer when present. */
  headers?: { entries(): Iterable<[string, string]> };
  text(): Promise<string>;
}

/** The slice of `fetch` the default transport calls: a JSON POST, or the
 *  CSRF token fetch's HEAD (no body). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<FetchLikeResponse>;

/** One request as the client hands it to a `transport`, to be sent as given. */
export interface TransportRequest {
  /** 'POST': a roundtrip. 'HEAD': the CSRF token fetch (`x-csrf-token:
   *  Fetch`, no body). Absent means 'POST'. */
  method?: "POST" | "HEAD";
  /** The serialized request (`{"value":{"S_FRONT":...,"MODEL":...}}`);
   *  absent on a HEAD. */
  body?: string;
  /** What the frontend sends: content-type and sap-contextid-accept, plus
   *  the session's sap-contextid and the x-csrf-token once the backend
   *  handed them out - the client does both handshakes. */
  headers: Record<string, string>;
  /** The client's timeout (`timeoutMs`) - one for a roundtrip and its
   *  token fetch and re-send. */
  signal: AbortSignal;
  /** The S_FRONT.ID the request continues; null for an app start. */
  draftId: string | null;
}

/** A transport's answer: a status outside 2xx is the backend's refusal. */
export interface TransportResponse {
  status: number;
  /** Read for sap-contextid and x-csrf-token (any case, a repeated header
   *  joined). */
  headers?: Record<string, string | string[] | undefined>;
  body: string;
}

/** ONE request; a throw is "the backend did not answer (...)". */
export type AppTransport = (request: TransportRequest) => Promise<TransportResponse>;

/** The app start's ORIGIN/PATHNAME/SEARCH; `search` names the class
 *  (app_start=<app>). */
export interface AppLocation {
  origin: string;
  pathname: string;
  search: string;
}

/** The local backend's hint after "the backend did not answer (...)". */
export const LOCAL_BACKEND_HINT: string;

/** The protocol number the client is written for; another one in a
 *  response is refused. */
export const PROTOCOL: number;
/** A response header, case-insensitively, a repeated one joined; '' when absent. */
export function headerOf(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string
): string;
/** core/Lib.js isValidContextId: never empty, never the text `undefined`. */
export function validContextId(id: unknown): id is string;
export function buildDelta(paths: string[], data: unknown): Record<string, unknown>;
/** The error body as a refusal shows it: verbatim, only shortened. */
export function errorText(status: number, body: string): string;
/** The default transport: one `fetch` of `baseUrl` - the POST of the body,
 *  or the token fetch's HEAD. */
export function fetchTransport(options: { baseUrl: string; fetchImpl?: FetchLike }): AppTransport;

export interface AppClientOptions {
  /** The local backend's root: where the default transport POSTs and what
   *  the default location says. Unused with `transport` and `location`. */
  baseUrl?: string;
  /** The default transport's fetch. */
  fetchImpl?: FetchLike;
  /** Replaces baseUrl/fetchImpl: sends one request as given. */
  transport?: AppTransport;
  /** The app start's location; may throw an AgentError to refuse. */
  location?: (app: string) => AppLocation | Promise<AppLocation>;
  /** Names the backend process a session was started on; a session of
   *  another generation is refused. Absent: no restart detection. */
  generation?: () => unknown;
  /** What follows "the backend did not answer (...) - "; '' for nothing.
   *  Default: LOCAL_BACKEND_HINT. */
  backendHint?: string;
  metadata?: () => unknown;
  maxSessions?: number;
  timeoutMs?: number;
}

export interface ActOptions {
  values?: unknown;
  event?: unknown;
  args?: unknown;
  row?: number;
  maxRows?: number;
}

export interface AppClient {
  start(app: string, options?: { values?: unknown; maxRows?: number }): Promise<AgentSnapshot>;
  describe(session: unknown, options?: { maxRows?: number }): AgentSnapshot;
  act(session: unknown, options?: ActOptions): Promise<AgentSnapshot>;
  sessions(): Array<{ session: string; app: string }>;
}

export function createAppClient(options: AppClientOptions): AppClient;
