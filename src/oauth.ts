import { createHash, randomBytes } from "crypto";
import {
  AuthStrategy,
  ClassifiedAnswer,
  InteractiveLogonRequired,
  StrategyTexts,
  UnauthorizedAnswer,
  UnauthorizedVerdict,
} from "./authstrategy";
import { tokensEqual } from "./proxyheaders";

/*
 * oauth - OAuth 2.0 with a service key (`auth: "oauth"`, docs/auth.md 3.3):
 * the SAP BTP ABAP Environment logon.
 *
 * `vscode`-free, and free of I/O: every decision of the flow lives here -
 * which service key shapes are accepted, the authorize URL, PKCE and the
 * `state` check, the token requests and what their answers mean, when a
 * token is renewed, which failure means "log on again" - and the strategy
 * the proxy holds. The loopback listener and the HTTP client are
 * `oauthflow.ts`; the VS Code plumbing is `oauthprompt.ts`.
 *
 * Secrets: the client secret, the code, the PKCE verifier and both tokens
 * never appear in a message or a log line written here, and the strategy
 * keeps them in `#private` fields that neither serialize nor print.
 */

/** A service key as the flow uses it - read out of the key the user loaded. */
export interface ServiceKey {
  /** The system URL of the key (`url`, else `endpoints.abap`). */
  systemUrl: string;
  /** The UAA (`uaa.url`), without a trailing slash. */
  uaaUrl: string;
  clientId: string;
  clientSecret: string;
}

/** A service key file that cannot be used, with the sentence that says why. */
export class ServiceKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceKeyError";
  }
}

/** A service key file is a few KB; anything far beyond is not one. */
export const SERVICE_KEY_MAX_BYTES = 256 * 1024;

const KEY_SHAPE =
  'a service key of an ABAP Environment instance has "url" and a "uaa" block with "url", ' +
  '"clientid" and "clientsecret"';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(hostname);
}

/**
 * Parses and checks a service key. Accepted shapes (docs/auth.md 3.3):
 *
 * - the key itself: `{ "url": ..., "uaa": { "url", "clientid", "clientsecret" } }`
 *   - other fields (`abap`, `binding`, `systemid`, ...) are carried along
 *   and ignored;
 * - the same wrapped in `{ "credentials": { ... } }`, as the Cloud Foundry
 *   CLI prints a key *(verify)*;
 * - without a top-level `url` but with `endpoints.abap`, which then is the
 *   system URL *(verify)*.
 *
 * Both URLs must be `https` - `allowLoopbackHttp` admits plain http on
 * 127.0.0.1/localhost for the local test servers only, never a real host.
 * Everything else is refused with a sentence that names what is missing and
 * never quotes a value of the key.
 */
export function parseServiceKey(
  input: string | unknown,
  options: { allowLoopbackHttp?: boolean } = {}
): ServiceKey {
  let raw: unknown = input;
  if (typeof input === "string") {
    if (input.length > SERVICE_KEY_MAX_BYTES) {
      throw new ServiceKeyError(`the file is too large for a service key - ${KEY_SHAPE}`);
    }
    try {
      raw = JSON.parse(input.replace(/^﻿/, ""));
    } catch {
      throw new ServiceKeyError(`the file is not JSON - ${KEY_SHAPE}`);
    }
  }
  if (!isRecord(raw)) {
    throw new ServiceKeyError(`the file is not a JSON object - ${KEY_SHAPE}`);
  }
  const key = !isRecord(raw.uaa) && isRecord(raw.credentials) ? raw.credentials : raw;
  const uaa = key.uaa;
  if (!isRecord(uaa)) {
    throw new ServiceKeyError(`the key has no "uaa" block - ${KEY_SHAPE}`);
  }
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const endpoints = isRecord(key.endpoints) ? key.endpoints : undefined;
  const systemUrl = text(key.url) ?? text(endpoints?.abap);
  const missing = [
    systemUrl ? undefined : '"url"',
    text(uaa.url) ? undefined : '"uaa.url"',
    text(uaa.clientid) ? undefined : '"uaa.clientid"',
    text(uaa.clientsecret) ? undefined : '"uaa.clientsecret"',
  ].filter((name): name is string => !!name);
  if (missing.length) {
    throw new ServiceKeyError(`the key has no ${missing.join(", ")} - ${KEY_SHAPE}`);
  }
  const checkUrl = (value: string, name: string): URL => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ServiceKeyError(`the key's "${name}" is not a URL`);
    }
    const local = options.allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname);
    if (url.protocol !== "https:" && !local) {
      throw new ServiceKeyError(`the key's "${name}" is not an https URL - refused`);
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ServiceKeyError(`the key's "${name}" carries more than a host and a path - refused`);
    }
    return url;
  };
  const system = checkUrl(systemUrl!, key.url !== undefined ? "url" : "endpoints.abap");
  const uaaUrl = checkUrl(text(uaa.url)!, "uaa.url");
  return {
    systemUrl: system.origin,
    uaaUrl: (uaaUrl.origin + uaaUrl.pathname).replace(/\/+$/, ""),
    clientId: text(uaa.clientid)!,
    clientSecret: text(uaa.clientsecret)!,
  };
}

/**
 * Whether the key was issued for the system at `origin`. Undefined when it
 * was; otherwise the sentence the "use it anyway" question shows. On the
 * ABAP Environment the key's `url` is the API host and the HTTP services may
 * be served from another host of the instance *(verify)*, so a mismatch is
 * asked about rather than refused.
 */
export function keyOriginMismatch(key: ServiceKey, origin: string): string | undefined {
  if (key.systemUrl === origin) {
    return undefined;
  }
  const host = (value: string) => {
    try {
      return new URL(value).host;
    } catch {
      return value;
    }
  };
  return `the service key is for ${host(key.systemUrl)}, the system's launch URL is on ${host(origin)}`;
}

// ---------------------------------------------------------------------------
// What is stored: the key and the refresh token, one SecretStorage entry
// ---------------------------------------------------------------------------

/** The SecretStorage entry `abap2ui5.oauth:<origin>` holds, as data. */
export interface StoredOAuth {
  /** The whole service key as the user loaded it (it carries the client
   *  secret - which is why it lives in the SecretStorage and nowhere else). */
  serviceKey: unknown;
  refreshToken?: string;
}

/** The entry as written. */
export function storedOAuthText(stored: StoredOAuth): string {
  return JSON.stringify(
    stored.refreshToken
      ? { serviceKey: stored.serviceKey, refreshToken: stored.refreshToken }
      : { serviceKey: stored.serviceKey }
  );
}

/** The entry as read - undefined for nothing, or for something that is not
 *  this shape (it is then treated as "no key loaded"). */
export function readStoredOAuth(text: string | undefined): StoredOAuth | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || !isRecord(value.serviceKey)) {
      return undefined;
    }
    return typeof value.refreshToken === "string" && value.refreshToken
      ? { serviceKey: value.serviceKey, refreshToken: value.refreshToken }
      : { serviceKey: value.serviceKey };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The authorization-code flow: PKCE, state, the authorize URL, the callback
// ---------------------------------------------------------------------------

function base64url(bytes: Buffer): string {
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE pair (RFC 7636, `S256`): 32 random bytes as the verifier. */
export function createPkce(random: (size: number) => Buffer = randomBytes): {
  verifier: string;
  challenge: string;
} {
  const verifier = base64url(random(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

/** The `S256` challenge of a verifier. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** A fresh `state` for one logon. */
export function createState(random: (size: number) => Buffer = randomBytes): string {
  return base64url(random(16));
}

/** The URL the user's browser is sent to. */
export function authorizeUrl(
  key: ServiceKey,
  request: { redirectUri: string; state: string; challenge: string }
): string {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: key.clientId,
    redirect_uri: request.redirectUri,
    state: request.state,
    code_challenge: request.challenge,
    code_challenge_method: "S256",
  });
  return `${key.uaaUrl}/oauth/authorize?${query.toString()}`;
}

/**
 * What the redirect back to the loopback listener says: the code, or why the
 * logon is refused. The `state` must be this logon's (compared in constant
 * time) - an answer without it, or with another one, is a forged or a stale
 * callback and ends the logon. The UAA's own `error` is named by its code
 * only (a word of letters and underscores); its description is not quoted.
 */
export function readCallback(
  query: URLSearchParams,
  expectedState: string
): { code: string } | { refused: string } {
  const state = query.get("state");
  if (!state || !tokensEqual(state, expectedState)) {
    return {
      refused: "the answer to the browser logon did not carry this logon's state - refused",
    };
  }
  const error = query.get("error");
  if (error) {
    const code = /^[A-Za-z_]{1,64}$/.test(error) ? error : "an unknown error";
    return { refused: `the UAA refused the logon (${code})` };
  }
  const code = query.get("code");
  if (!code) {
    return { refused: "the answer to the browser logon carried no authorization code" };
  }
  return { code };
}

// ---------------------------------------------------------------------------
// The token endpoint
// ---------------------------------------------------------------------------

/** One form POST - injected, so the flow is testable and free of I/O. */
export type TokenPost = (
  url: string,
  headers: Record<string, string>,
  body: string
) => Promise<{ status: number; body: string }>;

/** The tokens one answer of the token endpoint carried. */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** When the answer arrived (ms). */
  obtainedAt: number;
  /** `obtainedAt` + `expires_in`; undefined when the answer named none. */
  expiresAt?: number;
}

/**
 * Why the token endpoint gave no token:
 *
 * - `refused` - the grant is no good any more (`invalid_grant`, an expired or
 *   revoked refresh token, a code used twice): log on again;
 * - `client` - the UAA refused the key's client id or secret
 *   (`invalid_client`, a 401): load a current service key;
 * - `transient` - the UAA or the network failed (5xx, 429, no answer): try
 *   again later, the logon itself may be fine;
 * - `malformed` - an answer that is no token answer.
 */
export type TokenFailureKind = "refused" | "client" | "transient" | "malformed";

export class OAuthTokenError extends Error {
  constructor(
    readonly kind: TokenFailureKind,
    message: string
  ) {
    super(message);
    this.name = "OAuthTokenError";
  }
}

/** The client authentication of the token requests: HTTP basic with the
 *  key's client id and secret, as they are (the tools that log on to the
 *  ABAP Environment send them unencoded). */
export function clientAuthorization(key: ServiceKey): string {
  return "Basic " + Buffer.from(`${key.clientId}:${key.clientSecret}`).toString("base64");
}

/** The form body that exchanges a code. */
export function codeGrantBody(code: string, redirectUri: string, verifier: string): string {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }).toString();
}

/** The form body that renews with a refresh token. */
export function refreshGrantBody(refreshToken: string): string {
  return new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString();
}

/**
 * What one answer of the token endpoint means. A 200 must carry a string
 * `access_token` (and, if it names a `token_type`, `bearer`); `expires_in`
 * becomes `expiresAt`. A failure is classified by status and the OAuth
 * `error` code (RFC 6749 5.2) - the message names the code, never a value.
 */
export function parseTokenAnswer(
  status: number,
  body: string,
  now: number
): OAuthTokens {
  let json: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(body);
    json = isRecord(value) ? value : undefined;
  } catch {
    json = undefined;
  }
  if (status === 200) {
    const access = json?.access_token;
    const type = json?.token_type;
    if (typeof access !== "string" || !access || (type !== undefined && String(type).toLowerCase() !== "bearer")) {
      throw new OAuthTokenError("malformed", "the UAA's answer carried no bearer token");
    }
    const expiresIn = Number(json?.expires_in);
    const refresh = json?.refresh_token;
    return {
      accessToken: access,
      ...(typeof refresh === "string" && refresh ? { refreshToken: refresh } : {}),
      obtainedAt: now,
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: now + expiresIn * 1000 } : {}),
    };
  }
  const rawError = json?.error;
  const error = typeof rawError === "string" && /^[A-Za-z_]{1,64}$/.test(rawError) ? rawError : undefined;
  const said = error ? ` (${error})` : "";
  if (status >= 500 || status === 429 || status === 0) {
    return failure("transient", `the UAA could not answer (HTTP ${status})${said}`);
  }
  if (error === "invalid_client" || (status === 401 && !error)) {
    return failure(
      "client",
      `the UAA refused the service key's client credentials (HTTP ${status})${said}`
    );
  }
  if (status >= 400 && status < 500) {
    return failure("refused", `the UAA refused the logon (HTTP ${status})${said}`);
  }
  return failure("malformed", `the UAA answered HTTP ${status}${said}`);
}

function failure(kind: TokenFailureKind, message: string): never {
  throw new OAuthTokenError(kind, message);
}

/** The token URL of a key. */
export function tokenUrl(key: ServiceKey): string {
  return `${key.uaaUrl}/oauth/token`;
}

const FORM_HEADERS = {
  "content-type": "application/x-www-form-urlencoded",
  accept: "application/json",
};

/** Exchanges an authorization code (with its PKCE verifier) for tokens. */
export async function exchangeCode(
  key: ServiceKey,
  grant: { code: string; redirectUri: string; verifier: string },
  post: TokenPost,
  now: () => number = Date.now
): Promise<OAuthTokens> {
  const answer = await postOrTransient(post, key, codeGrantBody(grant.code, grant.redirectUri, grant.verifier));
  return parseTokenAnswer(answer.status, answer.body, now());
}

/** Renews with a refresh token. The answer may or may not carry a new one. */
export async function refreshTokens(
  key: ServiceKey,
  refreshToken: string,
  post: TokenPost,
  now: () => number = Date.now
): Promise<OAuthTokens> {
  const answer = await postOrTransient(post, key, refreshGrantBody(refreshToken));
  return parseTokenAnswer(answer.status, answer.body, now());
}

async function postOrTransient(
  post: TokenPost,
  key: ServiceKey,
  body: string
): Promise<{ status: number; body: string }> {
  try {
    return await post(tokenUrl(key), { ...FORM_HEADERS, authorization: clientAuthorization(key) }, body);
  } catch (err) {
    // the network's words only - a request error names the host, never the body
    const code = (err as { code?: unknown })?.code;
    throw new OAuthTokenError(
      "transient",
      `the UAA could not be reached${typeof code === "string" ? ` (${code})` : ""}`
    );
  }
}

/** A minute's margin before the token's own expiry. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * When a token is renewed ahead of its expiry: at 80 % of its lifetime, and
 * at the latest a minute before it runs out (never before it was obtained).
 * Undefined when the answer named no lifetime - such a token is only renewed
 * after the system refused it.
 */
export function refreshDueAt(tokens: Pick<OAuthTokens, "obtainedAt" | "expiresAt">): number | undefined {
  if (tokens.expiresAt === undefined) {
    return undefined;
  }
  const lifetime = tokens.expiresAt - tokens.obtainedAt;
  return tokens.obtainedAt + Math.max(0, Math.min(lifetime * 0.8, lifetime - REFRESH_MARGIN_MS));
}

/** Minutes a token is valid for, for a log line - never the token. */
export function describeLifetime(tokens: Pick<OAuthTokens, "obtainedAt" | "expiresAt">): string {
  if (tokens.expiresAt === undefined) {
    return "the UAA named no lifetime";
  }
  const minutes = Math.round((tokens.expiresAt - tokens.obtainedAt) / 60_000);
  return `valid for ${minutes} min`;
}

// ---------------------------------------------------------------------------
// The strategy
// ---------------------------------------------------------------------------

export const OAUTH_TEXTS: StrategyTexts = Object.freeze({
  rejected: Object.freeze({
    page:
      "abap2UI5: the system did not accept the OAuth token, also after renewing it - the " +
      "service key may belong to another system, or your user may not use this service. " +
      'The extension stopped repeating the request. Run "abap2UI5: Load Service Key" to ' +
      "load the key of this system, then run the app again.",
    error: "the system did not accept the OAuth token",
  }),
  expired: Object.freeze({
    page:
      "abap2UI5: the OAuth logon to the system has expired and could not be renewed. The " +
      "extension stopped forwarding requests with it. Log on again to retry.",
    error: "the OAuth logon to the system has expired",
  }),
});

/** What an `OAuthStrategy` starts from. */
export interface OAuthMaterial {
  key: ServiceKey;
  /** Tokens already obtained (by the browser logon or a refresh). Without
   *  them the first `prepare( )` renews with `refreshToken`. */
  tokens?: OAuthTokens;
  /** The refresh token to renew with, when `tokens` carries none. */
  refreshToken?: string;
  post: TokenPost;
  now?: () => number;
  /** A renewal brought a new refresh token (persist it), or the stored one
   *  was refused (`undefined`: forget it, so "Log On Again" runs the browser
   *  logon instead of the same refusal). */
  onRefreshToken?: (refreshToken: string | undefined) => void | Promise<void>;
  /** One line per renewal - never a token. */
  log?: (message: string) => void;
}

/**
 * OAuth 2.0 with a service key (`auth: "oauth"`): `Authorization: Bearer
 * <access token>` on every request, renewed with the refresh token in
 * `prepare( )` before it runs out (`refreshDueAt`), once for all requests
 * waiting at that moment (single-flight).
 *
 * - A renewal the UAA refuses (an expired or revoked refresh token, a
 *   rotated client secret) rejects `prepare( )` with
 *   {@link InteractiveLogonRequired}: the proxy's `expired` path, "Log On
 *   Again" in the editor, the refusal naming F9 for the MCP tools - and the
 *   stored refresh token is dropped, so logging on again opens the browser.
 * - A renewal that fails on the network or a 5xx keeps a token that is still
 *   valid; an expired one makes the request fail (502) and the next one
 *   tries again - the logon may be fine.
 * - A 401 from the system: the token is renewed once before the next request
 *   (`ignore`); a 401 to that renewed token, before the system accepted it
 *   even once, means the system does not accept this key's tokens at all
 *   (`rejected`). Without a refresh token a 401 is
 *   `expired`: only a new logon can help.
 */
export class OAuthStrategy implements AuthStrategy {
  readonly kind = "oauth";
  readonly #key: ServiceKey;
  readonly #post: TokenPost;
  readonly #now: () => number;
  readonly #onRefreshToken?: (refreshToken: string | undefined) => void | Promise<void>;
  readonly #log?: (message: string) => void;
  #tokens: OAuthTokens | undefined;
  #refreshToken: string | undefined;
  #inflight: Promise<void> | undefined;
  /** Renew before the next request whatever the clock says (after a 401). */
  #force = false;
  /** The current token comes from a renewal a 401 forced. */
  #fromForced = false;

  constructor(material: OAuthMaterial) {
    this.#key = { ...material.key };
    this.#post = material.post;
    this.#now = material.now ?? Date.now;
    this.#onRefreshToken = material.onRefreshToken;
    this.#log = material.log;
    this.#tokens = material.tokens ? { ...material.tokens } : undefined;
    this.#refreshToken = material.tokens?.refreshToken ?? material.refreshToken;
  }

  get texts(): StrategyTexts {
    return OAUTH_TEXTS;
  }

  requestHeaders(): Record<string, string> {
    return this.#tokens ? { authorization: `Bearer ${this.#tokens.accessToken}` } : {};
  }

  onUnauthorized(_answer: UnauthorizedAnswer): UnauthorizedVerdict {
    if (!this.#refreshToken) {
      return "expired";
    }
    if (this.#fromForced) {
      return "rejected";
    }
    this.#force = true;
    return "ignore";
  }

  /**
   * Not about expiry: an answer the system accepted (below 400) shows the
   * current token works, so a later 401 earns one renewal again. Never
   * `"expired"` - a redirect is handed on as the system sent it.
   */
  classifyAnswer(answer: ClassifiedAnswer): "ok" | "expired" {
    if (answer.status < 400) {
      this.#fromForced = false;
    }
    return "ok";
  }

    prepare(_signal?: AbortSignal): Promise<void> {
    if (!this.#due()) {
      return Promise.resolve();
    }
    // one renewal for every request that arrives while it runs; a caller
    // that gives up (its signal) does not cancel it for the others
    this.#inflight ??= this.#renew().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  #due(): boolean {
    if (!this.#tokens || this.#force) {
      return true;
    }
    const due = refreshDueAt(this.#tokens);
    return due !== undefined && this.#now() >= due;
  }

  #stillValid(): boolean {
    const tokens = this.#tokens;
    return !!tokens && !this.#force && (tokens.expiresAt === undefined || this.#now() < tokens.expiresAt);
  }

  async #renew(): Promise<void> {
    const forced = this.#force;
    const refreshToken = this.#refreshToken;
    if (!refreshToken) {
      if (this.#stillValid()) {
        return; // nothing to renew with - the token serves until it runs out
      }
      this.#tokens = undefined;
      throw new InteractiveLogonRequired(OAUTH_TEXTS.expired.error);
    }
    let tokens: OAuthTokens;
    try {
      tokens = await refreshTokens(this.#key, refreshToken, this.#post, this.#now);
    } catch (err) {
      const kind = err instanceof OAuthTokenError ? err.kind : "transient";
      const reason = err instanceof Error ? err.message : String(err);
      if (kind === "transient" || kind === "malformed") {
        if (this.#stillValid()) {
          this.#log?.(`logon: renewing the OAuth token failed - ${reason}; the current token is still valid`);
          return;
        }
        this.#log?.(`logon: renewing the OAuth token failed - ${reason}`);
        throw new Error(`${OAUTH_TEXTS.expired.error} and could not be renewed - ${reason}`);
      }
      // refused or the client: only a new logon (or a new key) helps
      this.#log?.(`logon: renewing the OAuth token was refused - ${reason}`);
      this.#tokens = undefined;
      this.#refreshToken = undefined;
      await this.#tell(undefined);
      throw new InteractiveLogonRequired(
        kind === "client"
          ? `${reason} - run "abap2UI5: Load Service Key" with a current key, then log on again`
          : `${OAUTH_TEXTS.expired.error} - ${reason}`
      );
    }
    this.#tokens = tokens;
    this.#force = false;
    this.#fromForced = forced;
    this.#log?.(`logon: OAuth token renewed, ${describeLifetime(tokens)}`);
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) {
      this.#refreshToken = tokens.refreshToken;
      await this.#tell(tokens.refreshToken);
    }
  }

  async #tell(refreshToken: string | undefined): Promise<void> {
    try {
      await this.#onRefreshToken?.(refreshToken);
    } catch {
      // best effort: a failed write costs a browser logon later, not this request
    }
  }
}
