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
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** The slice of `fetch` the client calls: always a JSON POST. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<FetchLikeResponse>;

export function buildDelta(paths: string[], data: unknown): Record<string, unknown>;
export function errorText(status: number, body: string): string;

export interface AppClientOptions {
  /** Where every roundtrip is POSTed (handed to `fetchImpl` as its url). */
  baseUrl: string;
  fetchImpl?: FetchLike;
  /** Names the backend a session was started on; a session of another
   *  generation is refused. */
  generation?: () => unknown;
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
