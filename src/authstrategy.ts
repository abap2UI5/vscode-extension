/**
 * How the auth proxy logs a forwarded request on to the system.
 *
 * The proxy (`proxy.ts`) holds ONE strategy per session instead of a prepared
 * header, and asks it two things: what to put on an outgoing request, and what
 * a 401 from the system means for the logon it carries. Basic authentication
 * is the only implementation; the interface is the seam a further mechanism
 * goes behind without a second code path in the proxy.
 *
 * `vscode`-free, and free of everything else too: the secret arrives through
 * the constructor, lives in memory only, and is never logged.
 */

/** What the proxy knows about a 401 when it asks the strategy. */
export interface UnauthorizedAnswer {
  /** The system's `WWW-Authenticate` header, verbatim, when it sent one. */
  authenticate?: string;
}

/**
 * What a 401 means for the logon the proxy injects:
 *
 * - `"rejected"` - the system refused what this strategy sends. The proxy
 *   stops repeating it (its retry breaker) until `start( )` hands in a new
 *   logon, so that one wrong secret does not become a burst of failed logons
 *   against a system with a lockout policy.
 * - `"ignore"` - the 401 says nothing about this strategy's logon; the proxy
 *   keeps forwarding.
 *
 * Either way the answer itself is still reported to the proxy's `onResponse`
 * listener - the strategy decides about the breaker, not about the report.
 */
export type UnauthorizedVerdict = "rejected" | "ignore";

export interface AuthStrategy {
  /** Names the mechanism - for a log line or a message, never a secret. */
  readonly kind: string;
  /**
   * The headers to set on EVERY outgoing request to the system (forwarded
   * requests, the WebSocket upgrade, the proxy's own fetches). Names in lower
   * case; a header of the same name the client sent is replaced.
   */
  requestHeaders(): Record<string, string>;
  /** Called when the system answered 401 to a request carrying those headers. */
  onUnauthorized(answer: UnauthorizedAnswer): UnauthorizedVerdict;
}

/**
 * Basic authentication: the same `Authorization: Basic …` header on every
 * request, prepared once.
 *
 * The header sits in a `#private` field on purpose: such a field is no
 * property, so neither `JSON.stringify` nor `util.inspect` (not even with
 * `showHidden`) can print the credentials when the proxy, or an object
 * holding it, ends up in a log line or an error report. User and password
 * themselves are not kept at all.
 */
export class BasicAuthStrategy implements AuthStrategy {
  readonly kind = "basic";
  readonly #header: string;

  constructor(user: string, pass: string) {
    // UTF-8, and split at the FIRST colon by the receiver - so a colon in the
    // password is fine, and one in the user name never was
    this.#header = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  }

  requestHeaders(): Record<string, string> {
    return { authorization: this.#header };
  }

  /**
   * Every 401 counts as "these credentials were rejected", whether or not
   * the system offered basic auth in `WWW-Authenticate`: the proxy puts the
   * same user and password on every request, and repeating them is what
   * locks an account. Telling "wrong password" from "this system does not
   * ask for a password at all" is left to whoever reads the reported answer
   * (`ProxyResponse.authenticate`) - it changes the message, not the breaker.
   */
  onUnauthorized(_answer: UnauthorizedAnswer): UnauthorizedVerdict {
    return "rejected";
  }
}
