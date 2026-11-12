/**
 * How the auth proxy logs a forwarded request on to the system.
 *
 * The proxy (`proxy.ts`) holds ONE strategy per session instead of a prepared
 * header, and asks it what to put on an outgoing request (headers, cookies,
 * TLS options), what to do before sending (`prepare`), and what an answer
 * means for the logon it carries (`onUnauthorized`, `classifyAnswer`). Each
 * mechanism of `docs/auth.md` is one implementation; the proxy has one code
 * path for all of them.
 *
 * `vscode`-free, and free of everything else too: the secret arrives through
 * the constructor, lives in memory only, and is never logged.
 */

/** What the proxy knows about a 401 (or another answer) when it asks the strategy. */
export interface UnauthorizedAnswer {
  /** The system's `WWW-Authenticate` header, verbatim, when it sent one. */
  authenticate?: string;
  /** The `Location` header of a redirect, verbatim (the SYSTEM's, not rebased). */
  location?: string;
  /** The answer's `Content-Type`. */
  contentType?: string;
}

/** What `classifyAnswer` is asked about: any answer the system gave. */
export interface ClassifiedAnswer extends UnauthorizedAnswer {
  status: number;
  /**
   * The request expected data (XML/JSON - ADT, the abap2UI5 roundtrip POST),
   * not a document - an HTML logon form in reply to it is no app page.
   */
  expectsData: boolean;
}

/**
 * What a 401 means for the logon the proxy injects:
 *
 * - `"rejected"` - the system refused what this strategy sends. The proxy
 *   stops repeating it (its retry breaker) until `start( )` hands in a new
 *   logon, so that one wrong secret does not become a burst of failed logons
 *   against a system with a lockout policy.
 * - `"expired"` - the logon was fine and has run out (a session, a token).
 *   The proxy stops forwarding just the same - replaying a dead logon helps
 *   nobody - but says so with the strategy's own `texts.expired`, without
 *   the lockout wording.
 * - `"ignore"` - the 401 says nothing about this strategy's logon; the proxy
 *   keeps forwarding.
 *
 * Either way the answer itself is still reported to the proxy's `onResponse`
 * listener - the strategy decides about the breaker, not about the report.
 */
export type UnauthorizedVerdict = "rejected" | "expired" | "ignore";

/** One verdict's wording: the local answer's body (what an iframe shows) and
 *  the error the proxy's own fetches reject with. */
export interface VerdictText {
  page: string;
  error: string;
}

/** What the proxy says while its breaker holds, per verdict. */
export interface StrategyTexts {
  rejected: VerdictText;
  expired: VerdictText;
}

/** TLS material a strategy presents in the handshake - Node's own option names. */
export interface StrategyTlsOptions {
  pfx?: Buffer;
  cert?: string;
  key?: string;
  passphrase?: string;
}

/**
 * A strategy that cannot go on without the user (a session that ran out, a
 * certificate nobody chose yet) rejects `prepare( )` - or the factory - with
 * this. The hosts map it to their "log on again" offer, and a flow without a
 * UI (the MCP tools) hands the message to the agent as the refusal.
 */
export class InteractiveLogonRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InteractiveLogonRequired";
  }
}

export interface AuthStrategy {
  /** Names the mechanism - for a log line or a message, never a secret. */
  readonly kind: string;
  /**
   * What the proxy says while its breaker holds. Optional for a strategy
   * written before the field existed: the proxy then uses basic
   * authentication's wording (`BASIC_TEXTS`), which is what it always said.
   */
  readonly texts?: StrategyTexts;
  /**
   * The headers to set on EVERY outgoing request to the system (forwarded
   * requests, the WebSocket upgrade, the proxy's own fetches). Names in lower
   * case; a header of the same name the client sent is replaced. Never
   * `cookie` - cookies go through `requestCookies`, which merges.
   */
  requestHeaders(): Record<string, string>;
  /** Called when the system answered 401 to a request carrying those headers. */
  onUnauthorized(answer: UnauthorizedAnswer): UnauthorizedVerdict;
  /**
   * Awaited by the proxy before EVERY request it sends - the place to renew
   * a logon ahead of its expiry. Single-flight is the strategy's business.
   * Rejecting with {@link InteractiveLogonRequired} stops forwarding like an
   * `"expired"` verdict.
   */
  prepare?(signal?: AbortSignal): Promise<void>;
  /**
   * Cookies to send with every request, merged into the client's `Cookie`
   * header: the strategy's value wins for its own names, every other cookie
   * of the client passes. The names are also what the proxy keeps out of the
   * answers it hands the client (with `MYSAPSSO2`, always, for a strategy
   * that has cookies) - offered to `takeSetCookie` instead.
   */
  requestCookies?(): Record<string, string>;
  /** A `Set-Cookie` of the system for one of the strategy's own cookies (a
   *  sliding session). In memory only. */
  takeSetCookie?(name: string, value: string): void;
  /** TLS options for the handshake with the system - a client certificate.
   *  Spread into every request next to the certificate-pin stance. */
  tlsOptions?(): StrategyTlsOptions;
  /**
   * Whether an answer that is NOT a 401 means the logon ran out - a redirect
   * to the identity provider, a 200 logon form where data was expected.
   * `"expired"` stops forwarding (see the verdict); `"ok"` changes nothing.
   */
  classifyAnswer?(answer: ClassifiedAnswer): "ok" | "expired";
}

/**
 * What the proxy has always said about a rejected basic logon - verbatim, the
 * two sentences of the retry breaker that used to sit in `proxy.ts`. Also the
 * fallback for a strategy without `texts`.
 */
export const BASIC_TEXTS: StrategyTexts = Object.freeze({
  rejected: Object.freeze({
    page:
      "abap2UI5: the system rejected the stored user or password. The " +
      "extension stopped repeating the request so the account does not " +
      "get locked. Enter the credentials again to retry.",
    error: "the system rejected the stored credentials",
  }),
  expired: Object.freeze({
    page:
      "abap2UI5: the logon to the system has expired. The extension stopped " +
      "forwarding requests with it. Log on again to retry.",
    error: "the logon to the system has expired",
  }),
});

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

  /** A getter, not a field: `JSON.stringify` of the strategy stays
   *  `{"kind":"basic"}`, as it always printed. */
  get texts(): StrategyTexts {
    return BASIC_TEXTS;
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

/** The client certificate as the strategy holds it: PKCS#12 bytes or a PEM
 *  pair, and the passphrase that opens it. */
export type ClientCertificateMaterial =
  | { pfx: Buffer; passphrase?: string }
  | { cert: string; key: string; passphrase?: string };

export const CERTIFICATE_TEXTS: StrategyTexts = Object.freeze({
  rejected: Object.freeze({
    page:
      "abap2UI5: the system did not accept the client certificate - it is " +
      "not mapped to a user there, or that user may not log on. The " +
      'extension stopped repeating the request. Run "abap2UI5: Choose ' +
      'Client Certificate" to pick another one, then run the app again.',
    error: "the system did not accept the client certificate",
  }),
  expired: Object.freeze({
    page:
      "abap2UI5: the client certificate is no longer accepted. The extension " +
      'stopped forwarding requests with it. Run "abap2UI5: Choose Client ' +
      'Certificate" to pick a current one, then run the app again.',
    error: "the client certificate is no longer accepted",
  }),
});

/**
 * An X.509 client certificate (`auth: "certificate"`): nothing in the
 * headers, the certificate and key in the TLS handshake of every request.
 *
 * The material sits in a `#private` field for the same reason as basic
 * auth's header. A 401 after a handshake that carried the certificate means
 * the system does not map it to a user: `"rejected"` - no password lockout to
 * fear, but a burst of failed logons still fills the security audit log.
 */
export class CertificateAuthStrategy implements AuthStrategy {
  readonly kind = "certificate";
  readonly #material: ClientCertificateMaterial;

  constructor(material: ClientCertificateMaterial) {
    this.#material = { ...material };
  }

  get texts(): StrategyTexts {
    return CERTIFICATE_TEXTS;
  }

  requestHeaders(): Record<string, string> {
    return {};
  }

  onUnauthorized(_answer: UnauthorizedAnswer): UnauthorizedVerdict {
    return "rejected";
  }

  tlsOptions(): StrategyTlsOptions {
    const material = this.#material;
    return "pfx" in material
      ? { pfx: material.pfx, passphrase: material.passphrase }
      : { cert: material.cert, key: material.key, passphrase: material.passphrase };
  }
}

/**
 * The client's `Cookie` header with the strategy's cookies merged in: the
 * strategy wins per name, every other cookie of the client passes in its
 * order, the strategy's are appended. Undefined when nothing is left.
 */
export function mergeCookies(
  clientHeader: string | undefined,
  own: Record<string, string> | undefined
): string | undefined {
  const names = new Set(Object.keys(own ?? {}));
  const kept = String(clientHeader ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      if (!part) {
        return false;
      }
      const eq = part.indexOf("=");
      return !names.has((eq < 0 ? part : part.slice(0, eq)).trim());
    });
  for (const [name, value] of Object.entries(own ?? {})) {
    kept.push(`${name}=${value}`);
  }
  return kept.length ? kept.join("; ") : undefined;
}

/** The cookie name of one `Set-Cookie` line. */
export function setCookieName(line: string): string {
  const pair = line.split(";")[0];
  const eq = pair.indexOf("=");
  return (eq < 0 ? pair : pair.slice(0, eq)).trim();
}

/** The cookie value of one `Set-Cookie` line. */
export function setCookieValue(line: string): string {
  const pair = line.split(";")[0];
  const eq = pair.indexOf("=");
  return eq < 0 ? "" : pair.slice(eq + 1).trim();
}

/** The logon ticket - kept out of the preview's cookie jar whenever the
 *  strategy injects cookies itself (docs/auth.md section 6, "Decided"). */
export const TICKET_COOKIE = "MYSAPSSO2";
