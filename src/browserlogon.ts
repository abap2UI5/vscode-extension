import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Readable, Writable } from "stream";
import {
  AuthStrategy,
  ClassifiedAnswer,
  InteractiveLogonRequired,
  StrategyTexts,
  TICKET_COOKIE,
  UnauthorizedAnswer,
  UnauthorizedVerdict,
} from "./authstrategy";
import { CdpEvent, CdpPipe } from "./cdp";
import { killTree } from "./childproc";
import { looksLikeLogonPage } from "./connectcheck";
import { expandTemplate, withoutLogonParams } from "./urls";

/*
 * browserlogon - the browser logon of `auth: "browser"` (docs/auth.md 3.1).
 *
 * `vscode`-free. The user logs on in a Chromium the extension starts and
 * controls over the DevTools protocol (`cdp.ts`, `--remote-debugging-pipe`:
 * no port), headed, with a throwaway profile directory that is deleted
 * afterwards. Whatever the system's logon wants - a SAML 2.0 identity
 * provider, SPNEGO, a certificate from the OS store, the ICF form - happens
 * in that window. Once a top-level answer of the system's origin is an app
 * page (not the logon form) and the session cookie exists, the session
 * cookies are read (`Network.getCookies` - HttpOnly ones included), the
 * browser is closed, and the proxy replays them (`BrowserLogonStrategy`).
 *
 * Decisions (docs/auth.md section 6): the cookies are kept in MEMORY only
 * (`BrowserSessions`), never in the SecretStorage, a file or `globalState`;
 * only `MYSAPSSO2` and `SAP_SESSIONID_*` of the system's host are kept,
 * every other cookie of the browser (the identity provider's, tracking, the
 * system's `sap-usercontext`) dies with the profile directory. Renewal is
 * interactive: an expired session is "Log On Again", never a silent browser
 * from a flow the user is not looking at.
 */

/** How long the user has to finish the logon in the browser. */
export const LOGON_TIMEOUT_MS = 5 * 60_000;

/** The ICF security session cookie: `SAP_SESSIONID_<SID>_<client>`. */
export const SESSION_COOKIE_RE = /^SAP_SESSIONID_[A-Za-z0-9]+_\d+$/;

/** The prefix of every throwaway profile directory - what a later start
 *  recognises as a leftover of a crashed logon. */
export const PROFILE_PREFIX = "abap2ui5-logon-";

/** Whether a cookie is one the browser logon keeps and replays. */
export function isSessionCookieName(name: string): boolean {
  return name === TICKET_COOKIE || SESSION_COOKIE_RE.test(name);
}

/** A cookie as `Network.getCookies` reports it (the fields read here). */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  session?: boolean;
}

/** Whether a cookie's domain covers `host` (exact, or a parent domain of a
 *  domain cookie). */
function domainCovers(domain: string, host: string): boolean {
  const bare = domain.replace(/^\./, "").toLowerCase();
  const target = host.toLowerCase();
  return target === bare || (domain.startsWith(".") && target.endsWith(`.${bare}`));
}

/**
 * The cookies the logon keeps out of everything the browser holds for the
 * system: `MYSAPSSO2` and `SAP_SESSIONID_*`, of the system's host, with a
 * value and not already expired. Everything else is dropped.
 */
export function sessionCookiesOf(
  cookies: readonly BrowserCookie[],
  origin: string,
  now: number = Date.now()
): Record<string, string> {
  const host = new URL(origin).hostname;
  const kept: Record<string, string> = {};
  for (const cookie of cookies) {
    if (!isSessionCookieName(cookie.name) || !cookie.value) {
      continue;
    }
    if (!domainCovers(cookie.domain, host)) {
      continue;
    }
    if (typeof cookie.expires === "number" && cookie.expires > 0 && cookie.expires * 1000 <= now) {
      continue;
    }
    kept[cookie.name] = cookie.value;
  }
  return kept;
}

/** Whether the kept cookies are a logon: a security session, or a logon
 *  ticket the system accepts on its own. */
export function isLoggedOnCookies(cookies: Record<string, string>): boolean {
  return Object.keys(cookies).some(isSessionCookieName);
}

/**
 * Whether one top-level answer in the browser ends the logon: it comes from
 * the system's origin, is a 200, and is not the ICF logon form. (A redirect
 * on the way, the identity provider's pages, a 401 - all keep waiting.) The
 * session cookie is checked separately.
 */
export function isAppAnswer(
  answer: { url: string; status: number; body: string },
  origin: string
): boolean {
  let answerOrigin: string;
  try {
    answerOrigin = new URL(answer.url).origin;
  } catch {
    return false;
  }
  return answerOrigin === origin && answer.status === 200 && !looksLikeLogonPage(answer.body);
}

/**
 * Whether an answer the proxy got means the browser logon ran out: a
 * redirect that leaves the system's origin (to the identity provider) or
 * goes to its SAML 2.0 endpoints, or an HTML page where data was expected
 * (the logon form instead of the roundtrip's JSON or ADT's XML). A 401 is
 * `onUnauthorized`'s business.
 */
export function browserAnswerVerdict(origin: string, answer: ClassifiedAnswer): "ok" | "expired" {
  if (answer.status >= 300 && answer.status < 400 && answer.location) {
    let target: URL;
    try {
      target = new URL(answer.location, origin);
    } catch {
      return "ok";
    }
    if (target.origin !== origin) {
      return "expired";
    }
    return /^\/sap\/saml2\//i.test(target.pathname) ? "expired" : "ok";
  }
  if (
    answer.status === 200 &&
    answer.expectsData &&
    /^\s*text\/html/i.test(answer.contentType ?? "")
  ) {
    return "expired";
  }
  return "ok";
}

export const BROWSER_TEXTS: StrategyTexts = Object.freeze({
  rejected: Object.freeze({
    page:
      "abap2UI5: the system did not accept the browser logon. The extension " +
      "stopped forwarding requests with it. Press F9 (or run \"abap2UI5: Log " +
      'On in Browser") to log on again.',
    error: "the system did not accept the browser logon",
  }),
  expired: Object.freeze({
    page:
      "abap2UI5: the browser logon to the system has expired. The extension " +
      "stopped forwarding requests with it. Choose \"Log On Again\" (or press " +
      "F9) to log on in the browser again, then the app reloads.",
    error: "the browser logon to the system has expired",
  }),
});

/**
 * One origin's browser logon, in memory: the session cookies and whether a
 * strategy found them dead. Shared by every strategy built for the origin
 * (F9, the connection check, the MCP flow), so a sliding cookie one of them
 * took over and an expiry one of them saw are what the next one starts from.
 * The cookies sit in a `#private` field: neither `JSON.stringify` nor
 * `util.inspect` prints them.
 */
export class BrowserSession {
  readonly obtainedAt: number;
  #cookies: Record<string, string>;
  #expired = false;

  constructor(cookies: Record<string, string>, obtainedAt: number = Date.now()) {
    this.#cookies = { ...cookies };
    this.obtainedAt = obtainedAt;
  }

  get expired(): boolean {
    return this.#expired;
  }

  /** Called when an answer said the session ran out. */
  markExpired(): void {
    this.#expired = true;
  }

  cookies(): Record<string, string> {
    return { ...this.#cookies };
  }

  /** A `Set-Cookie` of the system for one of the session's cookies: a new
   *  value replaces the old one, an empty value (a deletion) drops it. */
  update(name: string, value: string): void {
    if (!isSessionCookieName(name)) {
      return;
    }
    if (value) {
      this.#cookies[name] = value;
    } else {
      delete this.#cookies[name];
    }
  }

  /** The cookie NAMES, for a log line - never a value. */
  describe(): string {
    return Object.keys(this.#cookies).sort().join(", ") || "no cookies";
  }
}

/** The browser logons of this window, per origin - memory only. */
export class BrowserSessions {
  readonly #byOrigin = new Map<string, BrowserSession>();

  /** The live session of `origin`; an expired one counts as none. */
  get(origin: string): BrowserSession | undefined {
    const session = this.#byOrigin.get(origin);
    return session && !session.expired ? session : undefined;
  }

  set(origin: string, session: BrowserSession): void {
    this.#byOrigin.set(origin, session);
  }

  forget(origin: string): void {
    this.#byOrigin.delete(origin);
  }

  clear(): void {
    this.#byOrigin.clear();
  }
}

/** The window's store - "Clear Stored SAP Credentials" empties it too. */
export const browserSessions = new BrowserSessions();

/**
 * The proxy's half of the browser logon: no header, the session cookies
 * merged into every request's `Cookie` header, a `Set-Cookie` for one of
 * them taken over (the proxy keeps those and `MYSAPSSO2` out of the answers
 * to the preview), and expiry seen from the answers - a 401, a redirect to
 * the identity provider, a logon form where data was expected. Expired, not
 * rejected: there is no password to lock, but a dead session is not
 * replayed either.
 */
export class BrowserLogonStrategy implements AuthStrategy {
  readonly kind = "browser";
  readonly #origin: string;
  readonly #session: BrowserSession;

  constructor(origin: string, session: BrowserSession) {
    this.#origin = origin;
    this.#session = session;
  }

  get texts(): StrategyTexts {
    return BROWSER_TEXTS;
  }

  requestHeaders(): Record<string, string> {
    return {};
  }

  requestCookies(): Record<string, string> {
    return this.#session.cookies();
  }

  takeSetCookie(name: string, value: string): void {
    this.#session.update(name, value);
  }

  onUnauthorized(_answer: UnauthorizedAnswer): UnauthorizedVerdict {
    this.#session.markExpired();
    return "expired";
  }

  classifyAnswer(answer: ClassifiedAnswer): "ok" | "expired" {
    const verdict = browserAnswerVerdict(this.#origin, answer);
    if (verdict === "expired") {
      this.#session.markExpired();
    }
    return verdict;
  }
}

/**
 * The page the browser opens for a profile's launch-URL template: the
 * abap2UI5 service itself (its start page) - the query pair that names the
 * app class is dropped, `sap-client` and the rest stay, `sap-user` /
 * `sap-password` never travel. A `{class}` elsewhere is left empty.
 */
export function logonUrlOf(template: string): string {
  const hash = template.indexOf("#");
  const body = hash < 0 ? template : template.slice(0, hash);
  const q = body.indexOf("?");
  let url = body;
  if (q >= 0) {
    const kept = body
      .slice(q + 1)
      .split("&")
      .filter((pair) => pair && !/\{class\}/i.test(pair));
    url = body.slice(0, q) + (kept.length ? `?${kept.join("&")}` : "");
  }
  return withoutLogonParams(expandTemplate(url, ""));
}

/** The refusal of a flow without a UI (the MCP tools) for an origin with no
 *  live browser logon - it names the two places that open the browser. */
export function browserLogonNeeded(host: string): InteractiveLogonRequired {
  return new InteractiveLogonRequired(
    `no valid browser logon for ${host} - press F9 in VS Code or run ` +
      '"abap2UI5: Log On in Browser" first'
  );
}

/** What there is to start: the setting's executable, else the render gate's
 *  Chromium. Undefined when neither exists - `noBrowserMessage` says why. */
export function pickExecutable(
  configured: string | undefined,
  renderGateChromium: string | undefined,
  exists: (file: string) => boolean = fs.existsSync
): { executable?: string; problem?: string } {
  const setting = configured?.trim();
  if (setting) {
    return exists(setting)
      ? { executable: setting }
      : {
          problem:
            `abap2ui5.logon.browserExecutable names "${setting}", which does not exist - ` +
            "point it at a Chrome, Edge or Chromium executable, or clear it to use the render gate's Chromium",
        };
  }
  if (renderGateChromium) {
    return { executable: renderGateChromium };
  }
  return {
    problem:
      "the browser logon needs a Chromium-based browser: install the render gate's " +
      'Chromium ("abap2UI5: Install Render Gate"), or set abap2ui5.logon.browserExecutable ' +
      "to your Chrome or Edge",
  };
}

/** Why a browser logon ended without a session. */
export type BrowserLogonFailure = "timeout" | "closed" | "aborted" | "failed";

export class BrowserLogonError extends Error {
  constructor(
    readonly reason: BrowserLogonFailure,
    message: string
  ) {
    super(message);
    this.name = "BrowserLogonError";
  }
}

export interface BrowserLogonOptions {
  /** The browser to start (Chromium, Chrome, Edge). */
  executable: string;
  /** The page the browser opens - the system's launch URL. */
  url: string;
  /** The system's origin; defaults to the url's. */
  origin?: string;
  timeoutMs?: number;
  /** Where the throwaway profile directory is created (default: the OS
   *  temp directory). */
  profileRoot?: string;
  /** TESTS ONLY: `--headless=new`. The product starts the browser headed -
   *  the user has to see the identity provider. */
  headless?: boolean;
  /** Ends the logon as "aborted" (the progress notification's Cancel). */
  signal?: AbortSignal;
  /** Progress lines - never a cookie, never a URL's query. */
  log?: (message: string) => void;
  /** TESTS ONLY: called once the browser shows the page, with a way to
   *  close its window the way a user would. */
  onWindow?: (window: { close(): Promise<void> }) => void;
}

/** The arguments the browser is started with - the profile directory, the
 *  pipe, no first-run UI, no OS keyring prompt. */
export function browserArgs(profileDir: string, options: { headless?: boolean; root?: boolean }): string[] {
  return [
    ...(options.root ? ["--no-sandbox"] : []),
    ...(options.headless ? ["--headless=new"] : []),
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-extensions",
    // the system's page is navigated to over the protocol, once the network
    // is watched - it never stands in the argument vector
    "about:blank",
  ];
}

/**
 * Deletes profile directories of earlier logons that a crash left behind -
 * those older than `maxAgeMs` (a logon still running in another window is
 * younger than its timeout).
 */
export function removeStaleProfiles(
  root: string,
  maxAgeMs: number = LOGON_TIMEOUT_MS + 60_000,
  now: number = Date.now()
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(PROFILE_PREFIX)) {
      continue;
    }
    const dir = path.join(root, entry);
    try {
      if (now - fs.statSync(dir).mtimeMs < maxAgeMs) {
        continue;
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed++;
    } catch {
      // still held by something - the next start tries again
    }
  }
  return removed;
}

/** A top-level document answer the browser received. */
interface DocumentAnswer {
  requestId: string;
  url: string;
  status: number;
}

/**
 * Runs the browser logon: starts the browser on a fresh profile, opens
 * `url`, and resolves with the session cookies once the system answered an
 * app page and the session cookie exists. Rejects with a
 * {@link BrowserLogonError} on timeout, a closed window, an abort or a
 * browser that would not start. The browser is closed and the profile
 * directory deleted on every path.
 */
export async function runBrowserLogon(options: BrowserLogonOptions): Promise<Record<string, string>> {
  const origin = options.origin ?? new URL(options.url).origin;
  const log = options.log ?? (() => undefined);
  const root = options.profileRoot ?? os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(root, PROFILE_PREFIX));
  const posix = process.platform !== "win32";
  let child: ChildProcess | undefined;
  let cdp: CdpPipe | undefined;
  try {
    child = spawn(
      options.executable,
      browserArgs(profileDir, {
        headless: options.headless,
        root: posix && typeof process.getuid === "function" && process.getuid() === 0,
      }),
      {
        // fd 3: what the browser reads, fd 4: what it writes
        stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
        // its own process group, so the whole tree can be killed
        detached: posix,
        windowsHide: false,
      }
    );
    const started = child;
    const spawnFailed = new Promise<never>((_, reject) => {
      started.once("error", (err) =>
        reject(new BrowserLogonError("failed", `the browser could not be started: ${err.message}`))
      );
    });
    spawnFailed.catch(() => undefined);
    cdp = new CdpPipe(started.stdio[4] as Readable, started.stdio[3] as Writable);
    log(`logon: browser started for ${origin}`);
    return await Promise.race([watchLogon(cdp, started, origin, options, log), spawnFailed]);
  } finally {
    await closeBrowser(cdp, child);
    removeProfile(profileDir);
  }
}

/** The protocol half of the logon - see `runBrowserLogon`. */
async function watchLogon(
  cdp: CdpPipe,
  child: ChildProcess,
  origin: string,
  options: BrowserLogonOptions,
  log: (message: string) => void
): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    let settled = false;
    let targetId: string | undefined;
    let sessionId: string | undefined;
    let lastDocument: DocumentAnswer | undefined;
    let checking: Promise<void> = Promise.resolve();
    const timer = setTimeout(
      () =>
        finish(
          new BrowserLogonError(
            "timeout",
            `the browser logon did not finish within ${Math.round(
              (options.timeoutMs ?? LOGON_TIMEOUT_MS) / 1000
            )} s`
          )
        ),
      options.timeoutMs ?? LOGON_TIMEOUT_MS
    );
    const onAbort = () => finish(new BrowserLogonError("aborted", "the browser logon was cancelled"));
    const finish = (outcome: Error | Record<string, string>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stopListening();
      if (outcome instanceof Error) {
        reject(outcome);
      } else {
        resolve(outcome);
      }
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort);
    const closed = () =>
      finish(new BrowserLogonError("closed", "the browser window was closed before the logon finished"));
    child.once("exit", closed);
    cdp.onClose(closed);

    /** One finished top-level answer: is this the app, and is there a session? */
    const check = async (answer: DocumentAnswer) => {
      if (settled || !sessionId) {
        return;
      }
      let body = "";
      try {
        const got = await cdp.send("Network.getResponseBody", { requestId: answer.requestId }, sessionId);
        body = got.base64Encoded ? Buffer.from(String(got.body), "base64").toString("utf8") : String(got.body ?? "");
      } catch {
        // a body the browser no longer holds: judged on status and origin
      }
      if (!isAppAnswer({ url: answer.url, status: answer.status, body }, origin)) {
        return;
      }
      const got = await cdp.send(
        "Network.getCookies",
        { urls: [answer.url, `${origin}/`] },
        sessionId
      );
      const cookies = sessionCookiesOf((got.cookies ?? []) as BrowserCookie[], origin);
      if (isLoggedOnCookies(cookies)) {
        log(`logon: logged on - keeping ${Object.keys(cookies).sort().join(", ")}`);
        finish(cookies);
      }
    };

    const stopListening = cdp.onEvent((event: CdpEvent) => {
      if (event.method === "Target.targetDestroyed" && event.params.targetId === targetId) {
        closed();
        return;
      }
      if (event.method === "Target.detachedFromTarget" && event.params.sessionId === sessionId) {
        closed();
        return;
      }
      if (event.sessionId !== sessionId) {
        return;
      }
      if (
        event.method === "Network.responseReceived" &&
        event.params.type === "Document" &&
        event.params.frameId === targetId
      ) {
        lastDocument = {
          requestId: String(event.params.requestId),
          url: String(event.params.response?.url ?? ""),
          status: Number(event.params.response?.status ?? 0),
        };
        return;
      }
      if (
        event.method === "Network.loadingFinished" &&
        lastDocument &&
        event.params.requestId === lastDocument.requestId
      ) {
        const answer = lastDocument;
        checking = checking.then(() => check(answer)).catch(() => undefined);
      }
    });

    void (async () => {
      try {
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        // the window's first tab shows up a moment after the pipe does -
        // and a busy machine makes that moment longer
        for (let tries = 0; !targetId && tries < 50 && !settled; tries++) {
          const { targetInfos } = await cdp.send("Target.getTargets");
          targetId = (targetInfos as Array<{ type: string; targetId: string }>).find(
            (info) => info.type === "page"
          )?.targetId;
          if (!targetId) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!targetId) {
          ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }));
        }
        ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Network.enable", {}, sessionId);
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Page.navigate", { url: options.url }, sessionId);
        log("logon: waiting for the logon in the browser window");
        options.onWindow?.({
          close: async () => {
            await cdp.send("Target.closeTarget", { targetId });
          },
        });
      } catch (err) {
        finish(
          new BrowserLogonError(
            "failed",
            `the browser could not be driven: ${err instanceof Error ? err.message : String(err)}`
          )
        );
      }
    })();
  });
}

/** Closes the browser - politely over the protocol, then by force. */
async function closeBrowser(cdp: CdpPipe | undefined, child: ChildProcess | undefined): Promise<void> {
  if (!child) {
    return;
  }
  const exited =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => child.once("exit", () => resolve()));
  if (cdp && !cdp.closed) {
    await Promise.race([
      cdp.send("Browser.close").catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  const forced = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5_000)),
  ]);
  if (forced) {
    killTree(child);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  }
  cdp?.dispose();
}

/** Deletes the profile - it holds the session cookies (and the identity
 *  provider's) on disk while the browser runs. */
function removeProfile(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // held by a process that outlived the kill - `removeStaleProfiles`
    // deletes it at the next logon
  }
}
