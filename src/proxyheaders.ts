/**
 * The header-level rules of the auth proxy: the token segment and cookie,
 * the constant-time token comparison, the loopback `Host` check, and the
 * cookie / referer / host rewrites between the proxy's origin and the
 * system's. Free of state - `SapProxy` holds the token and applies these.
 * `proxy.ts` re-exports the public part and is the module to import from.
 */
import { URL } from "url";
import { createHash, timingSafeEqual } from "crypto";

/** A response header as one string, whatever shape node hands over. */
export function headerValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value.join(", ") : value;
  return text ? text : undefined;
}

/**
 * The host a request to `target` is opened against. `URL.hostname` keeps the
 * brackets of an IPv6 literal (`https://[fd00::10]:44300/` -> `[fd00::10]`),
 * and Node hands that string to getaddrinfo as if it were a name - ENOTFOUND,
 * which the connection check then read as "the hostname does not resolve".
 * The same thing `url.urlToHttpOptions( )` does to the field, kept explicit
 * because three request sites here depend on it.
 */
export function requestHostname(target: URL): string {
  return target.hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * A `Set-Cookie` from the system, made valid on the proxy's origin.
 *
 * Three attributes describe the SYSTEM's authority and break on loopback:
 * `Domain` (the system's host - the browser refuses it for 127.0.0.1),
 * `Path` (a cookie scoped to `/sap/bc/z2ui5` is never sent with the
 * `/__abap2ui5/<token>/sap/bc/z2ui5` requests the page actually makes, so
 * every such session cookie was set and then silently never returned), and
 * `Secure` - which goes unless the cookie needs it: a `SameSite=None` cookie
 * without `Secure` is dropped outright by the webview's Chromium, so stripping
 * it there loses the session cookie of every system configured per SAP's
 * cross-site notes - and loopback counts as a trustworthy origin, so Secure is
 * accepted over http anyway.
 *
 * Exported for the tests; the plain path and the relayed 101 of a WebSocket
 * upgrade both apply it, so a cookie planted on the handshake is as valid as
 * one planted on a page.
 */
export function rewriteSetCookie(cookie: string): string {
  const rebased = cookie
    .replace(/;\s*Domain=[^;]*/i, "")
    .replace(/;\s*Path=[^;]*/i, "; Path=/");
  return /;\s*SameSite\s*=\s*None\b/i.test(rebased)
    ? rebased
    : rebased.replace(/;\s*Secure\b/i, "");
}

/**
 * A `Referer` the browser addressed to the proxy, as the system would have
 * seen it. Rewritten by SHAPE rather than by replacing the long-lived base:
 * a page loaded through a one-shot url (the screenshot) refers to itself as
 * `http://127.0.0.1:<port>/__abap2ui5/<one-shot>/...`, which the base never
 * matched - so the one-shot token, spent but recognisable, travelled on to
 * the system in every follow-up request. Any token-shaped first segment goes;
 * a bare proxy url (a cookie-authorized page) is rebased on its own. A
 * referer that is not this proxy's is left alone.
 */
export function rebasedReferer(
  referer: string,
  proxyOrigin: string,
  target: URL
): string {
  const base = new URL(proxyOrigin).origin; // http://127.0.0.1:<port>
  if (!referer.startsWith(base)) {
    return referer;
  }
  const rest = referer.slice(base.length);
  if (rest && !/^[/?#]/.test(rest)) {
    return referer; // another port that merely starts with these digits
  }
  const prefixed = new RegExp(`^/${TOKEN_SEGMENT}/[A-Za-z0-9_-]+(?=[/?#]|$)`).exec(
    rest
  );
  const path = prefixed ? rest.slice(prefixed[0].length) : rest;
  return target.origin + (path.startsWith("/") ? path : `/${path}`);
}

/** First segment of every url the proxy hands out, so the token that follows
 *  cannot be mistaken for a path on the system. */
export const TOKEN_SEGMENT = "__abap2ui5";

/** Carries the token on requests whose path the proxy never sees prefixed -
 *  an app configured with an absolute bootstrap (`/sap/public/...`) asks for
 *  it from the server root. Planted on the first answer, HttpOnly so the page
 *  itself cannot read it back out. The name carries the PORT: cookies are
 *  host-scoped, not port-scoped, so two windows' proxies (two systems at
 *  once is a supported setup) would otherwise overwrite each other's cookie
 *  and break the other window's absolute-path requests. Exported for the
 *  agent transport (agentapps.ts), which keeps the system's cookies but not
 *  this one. */
export const TOKEN_COOKIE = "__abap2ui5_proxy";

/**
 * Whether two tokens match, in constant time. The gate compares against
 * whatever a caller sent, and a local process gets unlimited low-jitter
 * attempts against loopback - hashing first makes the comparison's timing
 * independent of where the strings diverge.
 */
export function tokensEqual(candidate: string, token: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(token).digest()
  );
}

/** The loopback names a browser can have connected through. Anything else in
 *  the Host header means the request arrived under a different hostname than
 *  the one the proxy hands out - the shape of a DNS rebinding attempt. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

/**
 * Whether a request's `Host` is one this machine's own loopback can be
 * reached under.
 *
 * Exported because EVERY local listener that acts with the system
 * credentials owes its callers this check, not just this one - a port on
 * 127.0.0.1 is reachable by any process on the machine and by any page that
 * resolves a name to loopback. The system MCP server is the second such
 * listener and shares it; a third must too.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  return LOOPBACK_HOST.test(String(host ?? ""));
}

/** The request headers that describe one hop rather than the request, and so
 *  must not travel through a proxy (RFC 7230 section 6.1). `transfer-encoding`
 *  stays: Node manages the framing of what it forwards itself. */
export const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
];
