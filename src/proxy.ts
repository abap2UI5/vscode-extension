import * as http from "http";
import * as https from "https";
import type { Duplex } from "stream";
import { randomBytes } from "crypto";
import { StringDecoder } from "string_decoder";
import type { TLSSocket } from "tls";
import { URL } from "url";
import {
  CertificateTrustError,
  changedMessage,
  decideTrust,
  explainTlsError,
  mayConnect,
  peerOf,
} from "./certtrust";
import { rebasedLocation } from "./urls";
import { BodyTap, RoundtripBuffer } from "./roundtrips";
import { AuthStrategy, BasicAuthStrategy } from "./authstrategy";
import { AdtClassState, AdtStatusError } from "./proxyadt";
import { allowFraming, INJECT_MAX_BYTES, injectRuntimeHook } from "./proxyhtml";
import {
  decodeBody,
  describeRejection,
  REJECTION_SNIFF_BYTES,
  withUtf8Charset,
} from "./proxybody";
import {
  headerValue,
  HOP_BY_HOP_HEADERS,
  isLoopbackHost,
  rebasedReferer,
  requestHostname,
  rewriteSetCookie,
  TOKEN_COOKIE,
  TOKEN_SEGMENT,
  tokensEqual,
} from "./proxyheaders";

// The free-standing parts live next to this file; everything this module
// exported before the split it still exports, so importers stay as they are.
export { AdtStatusError, parseAdtClassRefs } from "./proxyadt";
export type { AdtClassRef, AdtClassState } from "./proxyadt";
export { allowFraming, injectRuntimeHook, RUNTIME_MESSAGE_MARKER } from "./proxyhtml";
export { decodeBody, describeRejection, withUtf8Charset } from "./proxybody";
export {
  isLoopbackHost,
  rebasedReferer,
  requestHostname,
  rewriteSetCookie,
  TOKEN_COOKIE,
} from "./proxyheaders";

/**
 * Small local reverse proxy: accepts requests on 127.0.0.1 and forwards them
 * to the SAP system, injecting the basic-auth header into EVERY request. That
 * way the embedded browser (webview iframe) needs no login of its own and does
 * not run into a 401.
 *
 * All paths are forwarded transparently (UI5 resources under /sap/public,
 * /sap/bc/ui5_ui5 and so on), since the iframe sends root-relative paths to
 * the proxy automatically.
 */
/** What the system answered to one forwarded request. */
export interface ProxyResponse {
  status: number;
  /** Request path, for the log line. */
  path: string;
  /**
   * The `WWW-Authenticate` header of a rejected request, verbatim. It is the
   * one field that says whether the system offered basic auth at all - a
   * system that answers 401 WITHOUT it is not asking for a password, and no
   * amount of retyping one will help.
   */
  authenticate?: string;
  /**
   * What the rejection page said, flattened to one line and redacted - "User
   * is locked", "Password must be changed", "Logon not possible in client
   * 100". The status alone cannot tell those apart.
   */
  reason?: string;
}

/** One finished request/response pair, as the traffic log records it. The
 *  duration spans first byte out to last byte in - the full roundtrip the
 *  user waits for, not the time to first byte. */
export interface TrafficEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Response body size as received (before any hook injection). */
  bytes: number;
}

/** How long a forwarded request may go QUIET before the proxy gives up - an
 *  inactivity timeout, so a slow but progressing download survives. Without
 *  it a system that accepts the connection and then says nothing holds the
 *  request - and the preview - open with nothing to show for it. */
const FORWARD_TIMEOUT_MS = 120_000;

/** Absolute deadline for the small text answers `fetchFromSystem` asks for -
 *  a socket-inactivity timeout would let a trickling server hold an ADT
 *  lookup open forever. */
const FETCH_TIMEOUT_MS = 8000;

/** Everything asked for via `fetchFromSystem` is a small text answer - once
 *  this much arrived, the rest is not worth downloading. */
const FETCH_BODY_CAP = 256 * 1024;

/** How many minted-but-unused one-shot tokens are kept - see
 *  `SapProxy.singleUseTokens`. The oldest is dropped beyond this. */
const SINGLE_USE_MAX = 8;

export class SapProxy {
  private server?: http.Server;
  private port?: number;
  private target?: URL;
  /** How requests are logged on to the system - see `authstrategy.ts`. It
   *  holds the credentials, in memory only; the proxy never sees them. */
  private auth?: AuthStrategy;
  /**
   * The shared secret in the proxy's own urls. The port is random but
   * scannable, and every request the proxy forwards carries the system
   * credentials - so without a secret any process on this machine, and any
   * web page that reaches loopback, could drive an authenticated session
   * against the SAP system (ADT included). Same construction the system MCP
   * server uses for the same reason (see mcpsystem.ts).
   *
   * It sits in the path rather than in a header because the browser has to
   * carry it on its own: the preview loads the app page, and the app page
   * then asks for `resources/sap-ui-core.js` and posts its roundtrips
   * RELATIVE to that url, so a prefix travels with them at no cost.
   */
  private token?: string;

  /**
   * Secondary tokens, each accepted for exactly ONE authorized request and
   * retired the moment it is used.
   *
   * They exist for the one caller that cannot receive the long-lived token
   * privately: headless Chromium takes the page to shoot only as a command
   * line argument, and an argument vector is readable by every process of
   * this user (`ps`, /proc/<pid>/cmdline). What leaked there used to be the
   * capability token itself - good for an authenticated session against the
   * system for as long as the proxy ran. A one-shot token is spent on the
   * screenshot's very first request, and the page's follow-up requests are
   * carried by the HttpOnly cookie that first authorized answer plants.
   *
   * A minted token that is never used just sits here, so the set is capped -
   * a screenshot that never starts must not grow this without bound.
   */
  private readonly singleUseTokens = new Set<string>();

  /** Live WebSocket tunnels. An upgraded socket no longer belongs to the
   *  http server, so `close( )` neither waits for it nor closes it - stop( )
   *  has to take these down itself or hang on them forever. */
  private readonly tunnels = new Set<Duplex>();

  /**
   * The blanket override: whether requests may proceed to ANY system whose
   * TLS certificate cannot be verified (self-signed, private CA, hostname
   * mismatch), unasked. Off unless the user's own
   * `abap2ui5.allowUnauthorizedCerts` says otherwise - a certificate that
   * does not verify is otherwise accepted only for an origin it was pinned
   * for (`pinFor`, see certtrust.ts).
   */
  allowUnauthorized = false;

  /**
   * The SHA-256 fingerprint the user pinned for an origin, if any. A pinned
   * origin is connected to with verification off, and the peer's fingerprint
   * is compared with the pin on every connection before the request - and
   * with it the credentials - is written (`whenTrusted`).
   */
  pinFor: (origin: string) => string | undefined = () => undefined;

  /** Called when a connection is refused over the system's certificate, with
   *  the message the request failed with - for the log. */
  onTrustRefused?: (message: string) => void;

  /**
   * How a request to `target` treats the certificate: verified by Node,
   * accepted unseen (the blanket override), or accepted only when it is the
   * pinned one.
   */
  private tlsStance(target: URL): { rejectUnauthorized: boolean; pin?: string } {
    if (target.protocol !== "https:" || this.allowUnauthorized) {
      return { rejectUnauthorized: false };
    }
    const pin = this.pinFor(target.origin);
    return pin ? { rejectUnauthorized: false, pin } : { rejectUnauthorized: true };
  }

  /**
   * Runs `send` - the step that writes the request - once the connection may
   * carry it. Without a pin that is at once: Node verifies, or the blanket
   * override is on.
   *
   * With a pin the connection is made unverified, so the check is ours, and
   * it has to come BEFORE the first byte of the request: the headers carry
   * the credentials. A `ClientRequest` writes nothing until its first
   * `write( )`/`end( )`, so holding `send` back until the handshake has
   * produced the peer certificate is what keeps them home. Per request
   * rather than per socket on purpose - a kept-alive socket is checked again
   * each time it is used, whichever agent handed it out.
   */
  private whenTrusted(
    req: http.ClientRequest,
    target: URL,
    pin: string | undefined,
    send: () => void
  ): void {
    if (!pin) {
      send();
      return;
    }
    const refuse = (presented: string) => {
      const err = new CertificateTrustError(
        "CERT_PIN_MISMATCH",
        changedMessage(target.origin, pin, presented)
      );
      this.onTrustRefused?.(err.message);
      req.destroy(err);
    };
    req.once("socket", (socket) => {
      const tlsSocket = socket as TLSSocket;
      if (typeof tlsSocket.getPeerCertificate !== "function") {
        refuse(""); // not a TLS connection at all
        return;
      }
      const check = () => {
        const peer = peerOf(tlsSocket);
        if (peer && mayConnect(decideTrust(peer, pin))) {
          send();
        } else {
          refuse(peer?.fingerprint256 ?? "");
        }
      };
      if (peerOf(tlsSocket)) {
        check(); // a reused connection - the handshake is long done
      } else {
        tlsSocket.once("secureConnect", check);
      }
    });
  }

  /** A request error as callers see it - a certificate Node refused gets the
   *  message that says how to trust it (certtrust.ts), and is reported. */
  private explained(err: unknown, target: URL): Error {
    const explained = explainTlsError(err, target.origin);
    if (explained !== err && explained instanceof CertificateTrustError) {
      this.onTrustRefused?.(explained.message);
    }
    return explained;
  }

  /**
   * Called for every answer the system gives. The proxy is the only place
   * that sees them: inside the iframe a 401 is just a blank or unhelpful
   * page, and the extension used to have nothing to say about it. The host
   * uses this to turn a rejected logon into an actionable message.
   */
  onResponse?: (response: ProxyResponse) => void;

  /**
   * Set when the system rejected the injected credentials with 401.
   *
   * A UI5 page asks for dozens of resources, and the proxy puts the same
   * user and password on every one of them - so ONE wrong password produces a
   * burst of failed logons, and a system with a lockout policy counts every
   * one of them. Eleven in a few seconds is what a single F9 was observed to
   * send. While this is set the proxy answers locally instead of asking the
   * system again; `start( )` clears it, which is what re-entering the
   * credentials (and every F9) goes through.
   */
  private authRejected = false;

  /** Called once per finished response, with the full roundtrip timing -
   *  what feeds the traffic log and the toolbar's roundtrip badge. */
  onTraffic?: (entry: TrafficEntry) => void;

  /**
   * The last roundtrips' request and response bodies - what "Show Roundtrip"
   * and "Replay Roundtrip" read. In memory only (see `roundtrips.ts`), and
   * emptied in `stopNow( )`: a stop and a switch to another system both go
   * through it, so no body outlives the proxy session it was seen in.
   */
  readonly roundtrips = new RoundtripBuffer();

  /** Names the system profile a roundtrip belongs to. Two profiles may share
   *  an origin - then the proxy does not restart between them, and the ring
   *  empties on the first roundtrip under the other name instead. */
  roundtripScope?: () => string;

  /**
   * Serialises start/stop. Both await the network, and two overlapping calls
   * (F9 racing "Run an App from the System", or the 401 re-logon) used to
   * close the same old server and then each assign `this.server` - leaving
   * the loser listening forever with the credentials still injected, on a
   * port nothing could close again.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Starts the proxy (or just refreshes auth if the target stays the same). */
  start(targetOrigin: string, user: string, pass: string): Promise<number>;
  start(targetOrigin: string, auth: AuthStrategy): Promise<number>;
  start(
    targetOrigin: string,
    userOrAuth: string | AuthStrategy,
    pass = ""
  ): Promise<number> {
    const auth =
      typeof userOrAuth === "string"
        ? new BasicAuthStrategy(userOrAuth, pass)
        : userOrAuth;
    return this.serialize(() => this.startNow(targetOrigin, auth));
  }

  /**
   * Whether a 401 from the system trips the retry breaker (`authRejected`) -
   * the strategy's answer. A proxy stopped while the request was under way
   * has no strategy left; the answer then counts as it always did.
   */
  private rejectedBy401(authenticate: string | undefined): boolean {
    return !this.auth || this.auth.onUnauthorized({ authenticate }) === "rejected";
  }

  private async startNow(
    targetOrigin: string,
    auth: AuthStrategy
  ): Promise<number> {
    const target = new URL(targetOrigin);
    // new credentials are a new attempt, whether or not the server restarts
    this.authRejected = false;

    if (this.server && this.target && this.target.origin === target.origin) {
      this.auth = auth;
      return this.port!;
    }

    // assigned after stop( ), which clears the credentials of the proxy it
    // tears down - including, before this order, the ones just handed in
    await this.stopNow();
    this.auth = auth;
    this.target = target;
    this.token = randomBytes(16).toString("base64url");
    // one-shot tokens belong to the proxy that minted them
    this.singleUseTokens.clear();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head)
    );

    try {
      const server = this.server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          // The start-up handler would otherwise also take the first error
          // of a LISTENING server (an accept failing with EMFILE) and leave
          // none for the second - an unhandled "error" on a server takes the
          // whole extension host down.
          server.off("error", reject);
          server.on("error", () => {
            // a failed accept costs that one connection, not the proxy
          });
          resolve();
        });
      });
    } catch (err) {
      // a proxy that never got its port must not LOOK started: the
      // same-origin fast path above would keep handing out
      // `http://127.0.0.1:undefined/...` forever
      await this.stopNow();
      throw err;
    }

    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this.port;
  }

  /**
   * Base url of the running proxy, token included - swap the system's origin
   * for this one and the resulting url is both routed and authorized. Callers
   * do not have to know about the token: it is part of what they replace, and
   * everything the page asks for afterwards is relative to it.
   */
  get origin(): string {
    return `http://127.0.0.1:${this.port}/${TOKEN_SEGMENT}/${this.token}`;
  }

  /** True once start() succeeded, i.e. target and credentials are known. */
  get isRunning(): boolean {
    return !!this.server && !!this.target && !!this.auth;
  }

  /** Which SYSTEM this proxy currently forwards to, normalised - undefined
   *  while it is not running. Callers that remember something about a system
   *  (rather than about the proxy) key it on this, so switching systems does
   *  not carry the old one's verdict over. */
  get systemOrigin(): string | undefined {
    return this.target?.origin;
  }

  /** The cookie name of THIS proxy - see {@link TOKEN_COOKIE} on the port. */
  private get cookieName(): string {
    return `${TOKEN_COOKIE}_${this.port}`;
  }

  /**
   * The system path an incoming request is asking for, or undefined when the
   * request has no business here. Two ways to be authorized, and a request
   * that is neither is answered 404 rather than told what it got wrong.
   */
  private route(req: http.IncomingMessage): string | undefined {
    // Fail closed while the proxy is not fully started: during stop( )'s
    // close window the token is already gone, and `undefined === undefined`
    // used to AUTHORIZE a cookie-less request against the cleared state.
    const token = this.token;
    if (!token || !this.target || !this.auth || this.port === undefined) {
      return undefined;
    }

    // A browser sends the host it connected to. Ours is always loopback, so
    // anything else is a name that resolves here without being ours - which
    // is what DNS rebinding looks like from this side.
    if (!isLoopbackHost(req.headers.host)) {
      return undefined;
    }

    const url = String(req.url ?? "/");
    // Origin-form only. A browser addressing an origin server sends the path
    // (`GET /x HTTP/1.1`); the absolute form (`GET http://127.0.0.1:<port>/x`)
    // is a forward-proxy request nobody legitimately makes here - and it used
    // to fall through to the cookie branch below and be forwarded VERBATIM,
    // token segment included, to the system.
    if (!url.startsWith("/")) {
      return undefined;
    }
    const root = `/${TOKEN_SEGMENT}/`;
    if (url.startsWith(root)) {
      const rest = url.slice(root.length);
      const end = rest.search(/[/?]/);
      const candidate = end === -1 ? rest : rest.slice(0, end);
      // The one-shot token is spent HERE, where authorization is decided:
      // the request it authorizes goes through, its answer plants the
      // cookie the page's follow-up requests ride on, and the token itself
      // is refused from the next request on. Only the prefixed form counts -
      // a one-shot token is never accepted out of a cookie.
      if (tokensEqual(candidate, token) || this.spendSingleUse(candidate)) {
        if (end === -1) {
          return "/";
        }
        // a launch url without a path (`https://host:44300?app_start=...`)
        // leaves the query directly behind the prefix - forwarding it as
        // written would put `GET ?app_start=... HTTP/1.1` on the wire,
        // which servers reject
        return rest[end] === "?" ? "/" + rest.slice(end) : rest.slice(end);
      }
    }

    // No prefix: only the cookie from an earlier authorized answer counts -
    // and only from the page it was planted for. The cookie is host-scoped
    // and SameSite=None (it has to travel from the framed page), so every
    // page in the webview's cookie jar carries it: a foreign <img>, iframe or
    // form on 127.0.0.1:<another port> would ride it, with the Origin rewrite
    // in `prepareForwardHeaders` making the request look same-origin to the
    // system. The browser says where a request comes from: `same-origin` is
    // the app page's own resources and roundtrips, `none` a user-initiated
    // navigation (the headless screenshot), an absent header a client that is
    // not a browser. Anything else is cross-site by its own account.
    const site = headerValue(req.headers["sec-fetch-site"]);
    if (site && site !== "same-origin" && site !== "none") {
      return undefined;
    }
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${this.cookieName}=`));
    if (!cookie || !tokensEqual(cookie.slice(this.cookieName.length + 1), token)) {
      return undefined;
    }
    // A page loaded through a ONE-SHOT url (the screenshot, MCP's
    // run_app_on_system) resolves its relative requests - `resources/...`,
    // and the roundtrip POST to its own `location.href` - against that url,
    // so they carry the spent token's segment. The cookie authorizes them;
    // forwarded with the segment, the system answered 404 to the app's
    // first roundtrip.
    if (url.startsWith(root)) {
      const rest = url.slice(root.length);
      const end = rest.search(/[/?]/);
      if (end === -1) {
        return "/";
      }
      return rest[end] === "?" ? "/" + rest.slice(end) : rest.slice(end);
    }
    return url;
  }

  /**
   * Whether `candidate` is one of the outstanding one-shot tokens - and if
   * so, retires it. Compared in constant time like the long-lived one.
   */
  private spendSingleUse(candidate: string): boolean {
    for (const oneShot of this.singleUseTokens) {
      if (tokensEqual(candidate, oneShot)) {
        this.singleUseTokens.delete(oneShot);
        return true;
      }
    }
    return false;
  }

  /**
   * The same url, authorized by a freshly minted ONE-SHOT token instead of
   * the proxy's long-lived one - for a consumer that cannot keep the url
   * private. Returns the url unchanged when it does not belong to this
   * proxy, or while the proxy is not running: an unrecognised url is not
   * this method's to rewrite.
   *
   * See `singleUseTokens` for why the screenshot needs it.
   */
  singleUseUrl(url: string): string {
    const base = this.origin;
    if (!this.token || this.port === undefined || !url.startsWith(base)) {
      return url;
    }
    if (this.singleUseTokens.size >= SINGLE_USE_MAX) {
      // insertion order: the oldest minted-but-unused token goes first
      const oldest = this.singleUseTokens.values().next().value;
      if (oldest !== undefined) {
        this.singleUseTokens.delete(oldest);
      }
    }
    const oneShot = randomBytes(16).toString("base64url");
    this.singleUseTokens.add(oneShot);
    return (
      `http://127.0.0.1:${this.port}/${TOKEN_SEGMENT}/${oneShot}` +
      url.slice(base.length)
    );
  }

  /**
   * One GET against the system with the credentials the proxy already holds -
   * what the ADT lookups and the UI5-version detection are built on. The
   * body is capped: everything asked for this way is a small text answer.
   *
   * `background` marks a best-effort probe nobody asked for: its 401 must
   * neither trip the retry breaker (`authRejected`) nor raise the re-logon
   * prompt - a probe against the wrong client would otherwise break a
   * launch whose own credentials are fine. `signal` aborts the request, for
   * callers that supersede their own lookups while the user types.
   * `timeoutMs` widens the default deadline, for a caller that would rather
   * wait than misread a slow answer as an unreachable host - the connection
   * check, against an ICF service compiling on its first request.
   */
  fetchFromSystem(
    path: string,
    accept = "application/xml, application/json, */*",
    options: { background?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<{ status: number; body: string; authenticate?: string }> {
    const target = this.target;
    const auth = this.auth;
    if (!target || !auth) {
      return Promise.reject(new Error("proxy not started"));
    }
    if (this.authRejected) {
      // the activation poller runs on a timer, so without this it would keep
      // offering the rejected password long after the user stopped looking
      return Promise.reject(
        new Error("the system rejected the stored credentials")
      );
    }
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const stance = this.tlsStance(target);

    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: target.protocol,
          hostname: requestHostname(target),
          port: target.port || (isHttps ? 443 : 80),
          method: "GET",
          path,
          headers: {
            ...auth.requestHeaders(),
            accept,
          },
          rejectUnauthorized: stance.rejectUnauthorized,
          signal: options.signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let body = "";
          let settled = false;
          res.setEncoding("utf8");
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            // A rejection here used to be silent: these requests happen on a
            // timer rather than on a keystroke, so nothing in the UI said the
            // logon had stopped working.
            const authenticate = headerValue(res.headers["www-authenticate"]);
            if ((status === 401 || status === 403) && !options.background) {
              if (status === 401 && this.rejectedBy401(authenticate)) {
                this.authRejected = true;
              }
              this.onResponse?.({
                status,
                path,
                authenticate,
                reason: describeRejection(body),
              });
            }
            // The header travels with the answer too: the connection check
            // needs it to tell "wrong password" from "no basic auth at all".
            resolve({ status, body, authenticate });
          };
          res.on("data", (chunk: string) => {
            if (body.length < FETCH_BODY_CAP) {
              body += chunk;
            } else {
              // enough arrived to answer with - stop downloading the rest
              finish();
              res.destroy();
            }
          });
          res.on("end", finish);
          // a connection that dies mid-body emits on the RESPONSE stream, and
          // an unhandled "error" there takes the extension host down with it
          res.on("error", (err) => {
            if (!settled) {
              reject(err);
            }
          });
        }
      );
      const deadline = setTimeout(
        () => req.destroy(new Error("request to the system timed out")),
        options.timeoutMs ?? FETCH_TIMEOUT_MS
      );
      req.on("close", () => clearTimeout(deadline));
      req.on("error", (err) => reject(this.explained(err, target)));
      this.whenTrusted(req, target, stance.pin, () => req.end());
    });
  }

  /**
   * Reads the activation state of a class from the system's ADT service
   * (`/sap/bc/adt/oo/classes/<name>`), using the credentials the proxy already
   * injects. The root element's `adtcore:version` attribute is `inactive`
   * while a saved-but-not-activated version exists and flips back to `active`
   * on activation, and `adtcore:changedAt` moves with every change — together
   * the only way to notice an activation done outside this extension, since
   * VS Code has no event for it.
   *
   * Resolves to whatever of the two the answer carried. Rejects with an
   * {@link AdtStatusError} on a non-2xx status.
   */
  async fetchClassState(
    className: string,
    sapClient?: string
  ): Promise<AdtClassState> {
    const path =
      "/sap/bc/adt/oo/classes/" +
      encodeURIComponent(className.toLowerCase()) +
      (sapClient ? `?sap-client=${encodeURIComponent(sapClient)}` : "");
    const { status, body } = await this.fetchFromSystem(path);
    if (status < 200 || status >= 300) {
      throw new AdtStatusError(status);
    }
    // First occurrences in document order sit on the root element.
    const version = body.match(/adtcore:version="(active|inactive)"/);
    const changedAt = body.match(/adtcore:changedAt="([^"]+)"/);
    return {
      version: version ? (version[1] as "active" | "inactive") : undefined,
      changedAt: changedAt ? changedAt[1] : undefined,
    };
  }

  /**
   * The headers a forwarded request leaves this proxy with - the ONE place
   * that decides them, for the plain path and the upgrade path alike.
   *
   * Four things happen here, and all four are security-relevant enough that
   * two copies of them is a liability: the system's `Host`, the injected
   * credentials, the proxy's own token cookie (which stops here - matched by
   * prefix, so another window's port-scoped cookie stops here too), and the
   * `Origin`/`Referer` rewrite that makes the request look same-origin to the
   * system again. The browser addresses the proxy, so it sends 127.0.0.1 in
   * both while the forwarded `Host` is the SAP host, and origin-validating
   * CSRF checks reject that mismatch on every POST ("CSRF validation failed -
   * cross-origin POST rejected").
   *
   * `stripHopByHop` is the one deliberate difference between the two callers:
   * those headers describe the browser's connection to the proxy rather than
   * the request and must not travel on - except on an upgrade, which IS the
   * hop its `Connection`/`Upgrade` pair is about.
   */
  private prepareForwardHeaders(
    incoming: http.IncomingHttpHeaders,
    target: URL,
    proxyOrigin: string,
    options: { stripHopByHop: boolean }
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...incoming };
    if (options.stripHopByHop) {
      for (const name of HOP_BY_HOP_HEADERS) {
        delete headers[name];
      }
    }
    headers.host = target.host;
    Object.assign(headers, this.auth?.requestHeaders());
    if (headers.cookie) {
      const kept = String(headers.cookie)
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith(TOKEN_COOKIE));
      if (kept.length > 0) {
        headers.cookie = kept.join("; ");
      } else {
        delete headers.cookie;
      }
    }
    if (headers.origin) {
      headers.origin = target.origin;
    }
    if (headers.referer) {
      headers.referer = rebasedReferer(String(headers.referer), proxyOrigin, target);
    }
    return headers;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = this.route(req);
    if (path === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (this.authRejected) {
      // Answered here, without touching the system - see `authRejected`. The
      // status is the one the system gave, so the page behaves exactly as it
      // did on the answer that set the flag; the body says why nothing is
      // arriving, since this text is what an iframe ends up showing.
      res
        .writeHead(401, { "content-type": "text/plain; charset=utf-8" })
        .end(
          "abap2UI5: the system rejected the stored user or password. The " +
            "extension stopped repeating the request so the account does not " +
            "get locked. Enter the credentials again to retry."
        );
      this.onTraffic?.({
        method: String(req.method ?? "GET"),
        path,
        status: 401,
        durationMs: 0,
        bytes: 0,
      });
      return;
    }

    // an authorized request that came in prefixed leaves with the cookie, so
    // that an absolute-path resource is authorized too
    const seedCookie = String(req.url ?? "").startsWith(`/${TOKEN_SEGMENT}/`);

    // captured now: a system switch while this request is in flight must not
    // rewrite its response against the NEXT proxy's port and token
    const proxyOrigin = this.origin;
    const cookieName = this.cookieName;
    const token = this.token!;

    // What the traffic log and the status reports are allowed to see. The
    // incoming url carries the token, and those two end up in output channels
    // users paste into issues - which would hand over a working authorized
    // url for as long as the proxy runs. The forwarded path never has it.
    const reportedPath = path;

    const target = this.target!;
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const startedAt = Date.now();
    const stance = this.tlsStance(target);

    // One traffic entry per request, whichever way it ends - completed,
    // failed toward the system, or abandoned by the client.
    let trafficLogged = false;
    const logTraffic = (status: number, bytes: number) => {
      if (trafficLogged) {
        return;
      }
      trafficLogged = true;
      this.onTraffic?.({
        method: String(req.method ?? "GET"),
        path: reportedPath,
        status,
        durationMs: Date.now() - startedAt,
        bytes,
      });
    };

    // A POST is a candidate for the roundtrip ring: its body is collected
    // (up to the cap) while it streams to the system.
    const requestTap = req.method === "POST" ? new BodyTap() : undefined;
    if (requestTap) {
      req.on("data", (chunk: Buffer) => requestTap.push(chunk));
    }

    // Host, credentials, token cookie, Origin/Referer - see
    // `prepareForwardHeaders`, which the upgrade path shares.
    const headers = this.prepareForwardHeaders(req.headers, target, proxyOrigin, {
      stripHopByHop: true,
    });

    // A document request may get the runtime hook injected below. Injecting
    // means reading the body, so ask for it uncompressed - for the handful of
    // HTML documents a UI5 app loads that costs nothing measurable.
    const expectsHtml =
      req.method === "GET" &&
      (/text\/html/i.test(String(req.headers.accept ?? "")) ||
        req.headers["sec-fetch-dest"] === "document" ||
        req.headers["sec-fetch-dest"] === "iframe");
    if (expectsHtml) {
      headers["accept-encoding"] = "identity";
    }

    const options: https.RequestOptions = {
      protocol: target.protocol,
      hostname: requestHostname(target),
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path,
      headers,
      // verified unless this origin's certificate was pinned or the blanket
      // override is on - see `tlsStance`
      rejectUnauthorized: stance.rejectUnauthorized,
    };

    const proxyReq = mod.request(options, (proxyRes) => {
      // An upstream that dies mid-body emits on the RESPONSE stream, and
      // pipe( ) does not forward that to the destination - an unhandled
      // "error" here used to take the whole extension host down. Attached
      // before any branch below can return.
      proxyRes.on("error", () => {
        proxyRes.destroy();
        res.destroy();
      });

      const status = proxyRes.statusCode ?? 0;
      if (status === 401 || status === 403) {
        // Reported after the body rather than at header time: what makes a
        // rejection diagnosable is the sentence inside it, and these two
        // statuses are the only ones where waiting a few milliseconds buys
        // anything. A 401 also stops the burst of retries (`authRejected`).
        if (
          status === 401 &&
          this.rejectedBy401(headerValue(proxyRes.headers["www-authenticate"]))
        ) {
          this.authRejected = true;
        }
        let sniff = "";
        const sniffDecoder = new StringDecoder("utf8");
        proxyRes.on("data", (chunk: Buffer) => {
          const wanted = REJECTION_SNIFF_BYTES - sniff.length;
          if (wanted > 0) {
            // sliced, and through a decoder: a chunk boundary inside a
            // multibyte character must not become a replacement character
            sniff += sniffDecoder.write(chunk.subarray(0, wanted));
          }
        });
        let reported = false;
        const reportRejection = () => {
          if (reported) {
            return;
          }
          reported = true;
          this.onResponse?.({
            status,
            path: reportedPath,
            authenticate: headerValue(proxyRes.headers["www-authenticate"]),
            reason: describeRejection(sniff),
          });
        };
        proxyRes.once("end", reportRejection);
        // an aborted rejection never reaches "end", and a rejection nobody
        // hears about is the state this whole path exists to end
        proxyRes.once("close", reportRejection);
      } else {
        this.onResponse?.({ status, path: reportedPath });
      }
      // The traffic log: measured to the last body byte, so the duration is
      // what the user actually waited for. The extra data listener rides
      // alongside pipe( ) without disturbing it. "close" logs the answers
      // that never reach "end" - a client that gave up mid-body used to
      // leave no line at all, exactly the request one debugs with this log.
      let receivedBytes = 0;
      proxyRes.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });
      proxyRes.on("end", () =>
        logTraffic(proxyRes.statusCode ?? 0, receivedBytes)
      );
      // The roundtrip ring: a POST the system answered 2xx, kept once its
      // last byte is in - and only while the proxy session that saw the
      // request is still the running one (a stop or a system switch in
      // between has emptied the ring, and this answer belongs to the past).
      if (requestTap && status >= 200 && status < 300) {
        const responseTap = new BodyTap();
        proxyRes.on("data", (chunk: Buffer) => responseTap.push(chunk));
        proxyRes.on("end", () => {
          if (this.token !== token) {
            return;
          }
          this.roundtrips.add({
            at: startedAt,
            path: reportedPath,
            status,
            durationMs: Date.now() - startedAt,
            requestHeaders: req.headers,
            requestBody: requestTap.take(),
            requestBytes: requestTap.bytes,
            responseBody: responseTap.take(),
            responseBytes: responseTap.bytes,
            responseEncoding: String(proxyRes.headers["content-encoding"] ?? ""),
            scope: this.roundtripScope?.(),
          });
        });
      }
      proxyRes.on("close", () =>
        logTraffic(proxyRes.statusCode ?? 0, receivedBytes)
      );
      const outHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };

      // hop-by-hop again, on the way back: the system's connection handling
      // is not the browser's
      delete outHeaders.connection;
      delete outHeaders["keep-alive"];

      // Allow framing: otherwise the server forbids embedding via
      // X-Frame-Options / CSP frame-ancestors -> the iframe would stay blank.
      delete outHeaders["x-frame-options"];
      for (const key of [
        "content-security-policy",
        "content-security-policy-report-only",
      ]) {
        const csp = outHeaders[key];
        if (typeof csp === "string") {
          // Node joins two CSP headers with ", " - each is a policy of its
          // own. Split on ";" alone, the directive after the comma went with
          // the dropped frame-ancestors, weakening the second policy.
          const cleaned = csp
            .split(",")
            .map((policy) =>
              policy
                .split(";")
                .filter((d) => !/^\s*frame-ancestors/i.test(d))
                .join(";")
                .trim()
            )
            .filter(Boolean)
            .join(", ");
          if (cleaned) {
            outHeaders[key] = cleaned;
          } else {
            delete outHeaders[key];
          }
        }
      }

      // Rewrite redirects from the SAP host to the proxy - structurally,
      // never by replacing the origin substring (see `rebasedLocation`).
      if (outHeaders.location) {
        outHeaders.location = rebasedLocation(
          String(outHeaders.location),
          target,
          proxyOrigin
        );
      }

      // Make the system's cookies valid on the proxy's origin - Domain, Path
      // and Secure, see `rewriteSetCookie`.
      const setCookie = proxyRes.headers["set-cookie"];
      const cookies = setCookie ? setCookie.map(rewriteSetCookie) : [];
      if (seedCookie) {
        // SameSite=None, not Lax: the page lives in an iframe whose top-level
        // document is the vscode-webview:// origin, so every request the page
        // makes counts as cross-site and a Lax cookie stays home - exactly the
        // absolute-path requests this cookie exists to authorize. None needs
        // Secure to be accepted, and loopback is a trustworthy origin, so
        // Chromium takes the pair over plain http (same reasoning as the SAP
        // session cookies above).
        cookies.push(
          `${cookieName}=${token}; Path=/; HttpOnly; SameSite=None; Secure`
        );
      }
      if (cookies.length > 0) {
        outHeaders["set-cookie"] = cookies;
      }

      // HTML documents get the runtime hook planted (see above). Anything
      // already compressed (a server ignoring accept-encoding) or without a
      // body is streamed through untouched.
      const contentType = String(proxyRes.headers["content-type"] ?? "");
      const injectable =
        expectsHtml &&
        /text\/html/i.test(contentType) &&
        !proxyRes.headers["content-encoding"] &&
        (proxyRes.statusCode ?? 0) !== 304;
      if (!injectable) {
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let passedThrough = false;
      const buffer = (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size <= INJECT_MAX_BYTES) {
          return;
        }
        // Too big to be the app page - flush what is buffered and hand the
        // rest to pipe( ), which honours backpressure where a bare write( )
        // in this listener would buffer the remainder in memory.
        passedThrough = true;
        proxyRes.off("data", buffer);
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        for (const buffered of chunks) {
          res.write(buffered);
        }
        chunks.length = 0;
        proxyRes.pipe(res);
      };
      proxyRes.on("data", buffer);
      proxyRes.on("end", () => {
        if (passedThrough) {
          return; // pipe( ) ends the response itself
        }
        const raw = Buffer.concat(chunks);
        const text = decodeBody(raw, contentType);
        if (text === undefined) {
          // a charset that cannot be decoded here: re-encoding a guess would
          // mangle the page, so it goes out exactly as it came - without the
          // hook, under its own headers
          res.writeHead(proxyRes.statusCode || 502, outHeaders);
          res.end(raw);
          return;
        }
        const body = injectRuntimeHook(allowFraming(text));
        const payload = Buffer.from(body, "utf8");
        // the body leaves as UTF-8 whatever it arrived as, so the declared
        // charset has to move with it - an ISO-8859-1 logon page used to be
        // decoded wrongly and then served under its original charset
        outHeaders["content-type"] = withUtf8Charset(contentType);
        delete outHeaders["transfer-encoding"];
        outHeaders["content-length"] = payload.length;
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        res.end(payload);
      });
    });

    // a system that accepts the connection and then says nothing would
    // otherwise hold this request open for as long as the socket lives
    proxyReq.setTimeout(FORWARD_TIMEOUT_MS, () =>
      proxyReq.destroy(new Error(`no answer within ${FORWARD_TIMEOUT_MS} ms`))
    );

    proxyReq.on("error", (raw) => {
      const err = this.explained(raw, target);
      if (res.writableEnded || res.destroyed) {
        // the client is already gone - nothing left to tell, but the log
        // still gets its line (status 0: no answer reached anybody)
        logTraffic(0, 0);
        return;
      }
      if (res.headersSent) {
        // Mid-body (a reset upstream, the inactivity timeout during a slow
        // stream): the status and part of the body are already out. Ending
        // the response with an error text appended made a truncated script
        // or page look complete - cacheable, and logged as a 502 it was not.
        // Destroying it lets the browser see the failure for what it is.
        logTraffic(res.statusCode, 0);
        res.destroy(err);
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      logTraffic(502, 0);
      res.end("abap2UI5 proxy error: " + err.message);
    });

    // The webview cancels in-flight loads on every reload and navigation.
    // Without this the forwarded request runs to completion (or the two-minute
    // timeout) against a client that stopped listening, holding a work process
    // on the system and - on the injecting path - buffering into nothing.
    res.on("close", () => {
      if (!res.writableEnded) {
        proxyReq.destroy();
      }
    });
    // a body that stops arriving mid-upload otherwise lands as an unhandled
    // "error" on the request stream
    req.on("error", () => proxyReq.destroy());
    res.on("error", () => proxyReq.destroy());

    // held back until a pinned certificate has been compared - piping is
    // what writes the request, credentials included
    this.whenTrusted(proxyReq, target, stance.pin, () => req.pipe(proxyReq));
  }

  /**
   * A WebSocket upgrade, forwarded through the same gate and with the same
   * injected credentials as every other request. Node destroys the socket of
   * any `Upgrade:` request nobody listens for, so an app opening a WebSocket
   * used to die silently in the preview.
   */
  private handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const path = this.route(req);
    if (path === undefined || this.authRejected) {
      socket.destroy();
      return;
    }

    const target = this.target!;
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;

    // The upgrade needs its `Connection`/`Upgrade` pair to travel, so no
    // hop-by-hop stripping here - this IS the hop the pair is about.
    // Everything else is decided exactly as on the plain path.
    const headers = this.prepareForwardHeaders(req.headers, target, this.origin, {
      stripHopByHop: false,
    });

    // Tracked from here on, not from the 101: an upgraded socket no longer
    // belongs to the http server (see `tunnels`), and neither does one whose
    // upgrade is still pending - `close( )` waits for it all the same, so a
    // stop( ) during a pending upgrade used to hang on it forever.
    this.tunnels.add(socket);
    socket.on("close", () => this.tunnels.delete(socket));

    const stance = this.tlsStance(target);
    const proxyReq = mod.request({
      protocol: target.protocol,
      hostname: requestHostname(target),
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path,
      headers,
      rejectUnauthorized: stance.rejectUnauthorized,
    });
    // A system that accepts the connection and never answers the upgrade
    // held both sockets until stop( ) - the plain path has had this limit
    // all along. A timer, not proxyReq.setTimeout: that one is an idle
    // timeout on the socket the tunnel goes on to use.
    const unanswered = setTimeout(
      () => proxyReq.destroy(new Error(`no answer within ${FORWARD_TIMEOUT_MS} ms`)),
      FORWARD_TIMEOUT_MS
    );
    unanswered.unref();
    const answered = () => clearTimeout(unanswered);
    proxyReq.once("upgrade", answered);
    proxyReq.once("response", answered);
    proxyReq.once("close", answered);

    // A client that leaves before the system has answered takes the pending
    // request with it. A FIN counts as leaving: the http server hands the
    // socket over half-open-capable, so a client that merely ended its side
    // never produced a "close" - and the teardown below is only registered
    // once the 101 is in, so both sockets of an upgrade that never completed
    // used to stay open until stop( ).
    const abandon = () => {
      proxyReq.destroy();
      socket.destroy();
    };
    socket.on("close", abandon);
    socket.on("end", abandon);
    socket.on("error", abandon);
    // Read while the answer is pending - a socket nobody reads is paused, and
    // a paused socket surfaces neither the FIN nor the reset. Whatever the
    // client sends before the 101 (a WebSocket client sends nothing, but the
    // protocol is not ours to assume) is kept for the tunnel.
    const early: Buffer[] = [];
    const keepEarly = (chunk: Buffer) => {
      early.push(chunk);
    };
    socket.on("data", keepEarly);

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.off("close", abandon);
      socket.off("end", abandon);
      socket.off("error", abandon);
      socket.off("data", keepEarly);
      if (socket.destroyed || socket.readableEnded) {
        // the client hung up while the system was still deciding: there is
        // nobody to hand the tunnel to, and a tunnel with one end is a leak
        proxySocket.destroy();
        return;
      }
      this.tunnels.add(proxySocket);
      const teardown = () => {
        this.tunnels.delete(socket);
        this.tunnels.delete(proxySocket);
        socket.destroy();
        proxySocket.destroy();
      };
      socket.on("close", teardown);
      proxySocket.on("close", teardown);
      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
      const lines = [
        `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ""}`.trimEnd(),
      ];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        const name = proxyRes.rawHeaders[i];
        const value = proxyRes.rawHeaders[i + 1];
        // the handshake may plant a session cookie exactly as a page does,
        // and it needs the same rebasing onto the proxy's origin - or it is
        // set once and never sent back
        lines.push(
          `${name}: ${name.toLowerCase() === "set-cookie" ? rewriteSetCookie(value) : value}`
        );
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (proxyHead.length) {
        socket.write(proxyHead);
      }
      if (head.length) {
        proxySocket.write(head);
      }
      for (const chunk of early) {
        proxySocket.write(chunk);
      }
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on("response", (proxyRes) => {
      // The system refused the upgrade - relay the refusal and hang up. A 401
      // here is the same rejected logon as on the plain path and is treated
      // the same way: an app that reopens its WebSocket on every failure used
      // to send one failed logon per attempt - the burst `authRejected` exists
      // to stop - while nothing ever offered the user to re-enter the
      // credentials, because nobody reported the answer.
      const status = proxyRes.statusCode ?? 502;
      if (
        status === 401 &&
        this.rejectedBy401(headerValue(proxyRes.headers["www-authenticate"]))
      ) {
        this.authRejected = true;
      }
      this.onResponse?.({
        status,
        path,
        authenticate: headerValue(proxyRes.headers["www-authenticate"]),
      });
      // Ended AND destroyed once the refusal is out: nothing reads this socket
      // any more, and a WebSocket client has its first frame ready to send -
      // unread bytes keep a half-open socket from ever closing, and
      // `server.close( )` waiting on it.
      socket.end(
        `HTTP/1.1 ${status} ${proxyRes.statusMessage ?? ""}\r\n` +
          "connection: close\r\n\r\n",
        () => socket.destroy()
      );
      proxyRes.destroy();
    });
    proxyReq.on("error", (err) => {
      this.explained(err, target); // reported; the client only sees a hangup
      socket.destroy();
    });
    this.whenTrusted(proxyReq, target, stance.pin, () => proxyReq.end());
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopNow());
  }

  private async stopNow(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.target = undefined;
    // the credentials and the token outlived the server they belonged to,
    // and isRunning read true for a proxy that had already been stopped
    this.auth = undefined;
    this.token = undefined;
    this.singleUseTokens.clear();
    // the bodies of the session that ends here go with it
    this.roundtrips.clear();
    for (const tunnel of this.tunnels) {
      tunnel.destroy();
    }
    this.tunnels.clear();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close( ) alone waits for in-flight requests - up to the forward
        // timeout - and a system SWITCH awaits this before it can start, so
        // the connections go down with the server they belonged to
        server.closeAllConnections();
      });
    }
  }

  dispose(): void {
    void this.stop();
  }
}
