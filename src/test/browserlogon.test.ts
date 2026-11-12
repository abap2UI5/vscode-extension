import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { AddressInfo } from "net";
import { PassThrough } from "stream";
import { inspect } from "util";
import {
  BROWSER_TEXTS,
  BrowserLogonError,
  BrowserLogonStrategy,
  BrowserSession,
  BrowserSessions,
  PROFILE_PREFIX,
  browserAnswerVerdict,
  browserArgs,
  browserLogonNeeded,
  isAppAnswer,
  isLoggedOnCookies,
  isSessionCookieName,
  logonUrlOf,
  pickExecutable,
  removeStaleProfiles,
  runBrowserLogon,
  sessionCookiesOf,
} from "../browserlogon";
import { CdpPipe } from "../cdp";
import { InteractiveLogonRequired } from "../authstrategy";
import { SapProxy } from "../proxy";
import { classifyStatus, relogonOffer } from "../connectcheck";
import { redact } from "../report";

/*
 * The browser logon of `auth: "browser"` (docs/auth.md 3.1): the decisions
 * without a browser, the DevTools pipe over fake streams, and the real thing -
 * a Chromium started over `--remote-debugging-pipe` against a fake SAP system
 * whose root sends an unauthenticated request to a fake identity provider on
 * another host, which sends it straight back (SSO without user input) to a
 * callback that sets the session cookies. Headless ONLY here; the product
 * starts the browser headed.
 */

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const ORIGIN = "https://sap.example:44300";

test("only MYSAPSSO2 and SAP_SESSIONID_* of the system's host are kept", () => {
  assert.ok(isSessionCookieName("MYSAPSSO2"));
  assert.ok(isSessionCookieName("SAP_SESSIONID_ABC_100"));
  assert.ok(!isSessionCookieName("sap-usercontext"));
  assert.ok(!isSessionCookieName("SAP_SESSIONID_"));
  assert.ok(!isSessionCookieName("MYSAPSSO2X"));
  const now = Date.parse("2026-11-12T10:00:00Z");
  const kept = sessionCookiesOf(
    [
      { name: "SAP_SESSIONID_ABC_100", value: "s", domain: "sap.example" },
      { name: "MYSAPSSO2", value: "t", domain: ".example" },
      { name: "sap-usercontext", value: "sap-client=100", domain: "sap.example" },
      { name: "idp_session", value: "i", domain: "idp.example" },
      // another host's session, an empty one, an expired one
      { name: "SAP_SESSIONID_XYZ_200", value: "o", domain: "other.example" },
      { name: "SAP_SESSIONID_EMP_100", value: "", domain: "sap.example" },
      { name: "SAP_SESSIONID_OLD_100", value: "x", domain: "sap.example", expires: now / 1000 - 1 },
    ],
    ORIGIN,
    now
  );
  assert.deepEqual(kept, { SAP_SESSIONID_ABC_100: "s", MYSAPSSO2: "t" });
  assert.ok(isLoggedOnCookies(kept));
  assert.ok(isLoggedOnCookies({ MYSAPSSO2: "t" }));
  assert.ok(!isLoggedOnCookies({}));
});

test("the logon ends at a 200 of the system's origin that is not the logon form", () => {
  const app = { url: `${ORIGIN}/sap/bc/z2ui5?sap-client=100`, status: 200, body: "<script id='sap-ui-bootstrap'>z2ui5</script>" };
  assert.ok(isAppAnswer(app, ORIGIN));
  assert.ok(!isAppAnswer({ ...app, url: "https://idp.example/login" }, ORIGIN));
  assert.ok(!isAppAnswer({ ...app, status: 401 }, ORIGIN));
  assert.ok(!isAppAnswer({ ...app, body: '<form id="logonForm">' }, ORIGIN));
  assert.ok(!isAppAnswer({ ...app, url: "not a url" }, ORIGIN));
});

test("expiry: a redirect off the origin or to SAML 2.0, an HTML page where data was expected", () => {
  const base = { status: 302, expectsData: false };
  assert.equal(browserAnswerVerdict(ORIGIN, { ...base, location: "https://idp.example/sso?x=1" }), "expired");
  assert.equal(browserAnswerVerdict(ORIGIN, { ...base, location: "/sap/saml2/sp/sso" }), "expired");
  assert.equal(browserAnswerVerdict(ORIGIN, { ...base, location: "/sap/bc/z2ui5?x" }), "ok");
  assert.equal(browserAnswerVerdict(ORIGIN, { ...base, location: `${ORIGIN}/other` }), "ok");
  assert.equal(browserAnswerVerdict(ORIGIN, { ...base }), "ok");
  const html = { status: 200, contentType: "text/html; charset=utf-8" };
  assert.equal(browserAnswerVerdict(ORIGIN, { ...html, expectsData: true }), "expired");
  assert.equal(browserAnswerVerdict(ORIGIN, { ...html, expectsData: false }), "ok");
  assert.equal(browserAnswerVerdict(ORIGIN, { status: 200, contentType: "application/json", expectsData: true }), "ok");
});

test("the strategy: cookies only, a sliding session, expiry marks the shared session, nothing printable", () => {
  const session = new BrowserSession({ SAP_SESSIONID_ABC_100: "sid-secret", MYSAPSSO2: "ticket-secret" });
  const strategy = new BrowserLogonStrategy(ORIGIN, session);
  assert.equal(strategy.kind, "browser");
  assert.deepEqual(strategy.requestHeaders(), {});
  assert.equal(strategy.texts, BROWSER_TEXTS);
  assert.deepEqual(strategy.requestCookies(), { SAP_SESSIONID_ABC_100: "sid-secret", MYSAPSSO2: "ticket-secret" });
  strategy.takeSetCookie("SAP_SESSIONID_ABC_100", "sid-2");
  strategy.takeSetCookie("other", "ignored");
  strategy.takeSetCookie("MYSAPSSO2", ""); // deleted by the system
  assert.deepEqual(strategy.requestCookies(), { SAP_SESSIONID_ABC_100: "sid-2" });
  assert.equal(session.describe(), "SAP_SESSIONID_ABC_100");
  for (const printed of [JSON.stringify(strategy), inspect(strategy, { showHidden: true, depth: 5 }), JSON.stringify(session), inspect(session, { showHidden: true })]) {
    assert.ok(!printed.includes("sid-"), printed);
  }
  const sessions = new BrowserSessions();
  sessions.set(ORIGIN, session);
  assert.equal(sessions.get(ORIGIN), session);
  assert.equal(strategy.classifyAnswer({ status: 200, expectsData: false }), "ok");
  assert.equal(sessions.get(ORIGIN), session);
  assert.equal(strategy.classifyAnswer({ status: 302, location: "https://idp.example/", expectsData: false }), "expired");
  assert.ok(session.expired);
  assert.equal(sessions.get(ORIGIN), undefined, "an expired session counts as none");
  const other = new BrowserSession({ MYSAPSSO2: "t" });
  assert.equal(new BrowserLogonStrategy(ORIGIN, other).onUnauthorized({}), "expired");
  assert.ok(other.expired);
  sessions.set(ORIGIN, new BrowserSession({ MYSAPSSO2: "t" }));
  sessions.forget(ORIGIN);
  assert.equal(sessions.get(ORIGIN), undefined);
});

test("the MCP refusal names F9 and the command; the messages name the browser", () => {
  const refusal = browserLogonNeeded("sap.example:44300");
  assert.ok(refusal instanceof InteractiveLogonRequired);
  assert.match(refusal.message, /no valid browser logon for sap\.example:44300/);
  assert.match(refusal.message, /F9/);
  assert.match(refusal.message, /Log On in Browser/);
  const offer = relogonOffer("browser", 302, "", true, false);
  assert.equal(offer.button, "Log On Again");
  assert.match(offer.message, /browser logon/);
  // basic keeps its wording
  assert.doesNotMatch(relogonOffer("basic", 401, "", true, false).message, /browser/);
  for (const status of [302, 401]) {
    const step = classifyStatus({ status, path: "/sap/bc/z2ui5", auth: "browser" });
    assert.equal(step.ok, false);
    assert.match(step.fix ?? "", /Log On in Browser/);
    assert.doesNotMatch(step.fix ?? "", /openMode/);
  }
});

test("the logon page: the service itself, sap-client kept, no class, no password", () => {
  assert.equal(
    logonUrlOf("https://h:1/sap/bc/z2ui5?app_start={class}&sap-client=100"),
    "https://h:1/sap/bc/z2ui5?sap-client=100"
  );
  assert.equal(logonUrlOf("https://h/sap/bc/z2ui5?app_start={class}"), "https://h/sap/bc/z2ui5");
  assert.equal(
    logonUrlOf("https://h/sap/bc/z2ui5?sap-user=u&sap-password=p&sap-client=001&app_start={CLASS}"),
    "https://h/sap/bc/z2ui5?sap-client=001"
  );
});

test("which browser: the setting first (must exist), else the render gate's Chromium, else how to get one", () => {
  const exists = (file: string) => file === "/usr/bin/chrome";
  assert.deepEqual(pickExecutable("/usr/bin/chrome", "/gate/chrome", exists), { executable: "/usr/bin/chrome" });
  assert.match(pickExecutable("/nope", "/gate/chrome", exists).problem ?? "", /does not exist/);
  assert.deepEqual(pickExecutable("  ", "/gate/chrome", exists), { executable: "/gate/chrome" });
  const none = pickExecutable(undefined, undefined, exists);
  assert.equal(none.executable, undefined);
  assert.match(none.problem ?? "", /Install Render Gate/);
  assert.match(none.problem ?? "", /abap2ui5\.logon\.browserExecutable/);
});

test("browser arguments: the pipe, the throwaway profile, headless only when asked, no system URL", () => {
  const args = browserArgs("/tmp/p", {});
  assert.ok(args.includes("--remote-debugging-pipe"));
  assert.ok(args.includes("--user-data-dir=/tmp/p"));
  assert.ok(!args.some((a) => a.startsWith("--headless")), "the product starts the browser headed");
  assert.ok(!args.some((a) => a.startsWith("--remote-debugging-port")), "no port");
  assert.equal(args[args.length - 1], "about:blank");
  assert.ok(browserArgs("/tmp/p", { headless: true, root: true }).includes("--headless=new"));
  assert.ok(browserArgs("/tmp/p", { root: true }).includes("--no-sandbox"));
});

test("leftover profiles of a crashed logon are deleted once they are old", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "abap2ui5-test-"));
  try {
    const old = path.join(root, `${PROFILE_PREFIX}old`);
    const fresh = path.join(root, `${PROFILE_PREFIX}fresh`);
    const foreign = path.join(root, "something-else");
    for (const dir of [old, fresh, foreign]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "Cookies"), "x");
    }
    const past = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(old, past, past);
    fs.utimesSync(foreign, past, past);
    assert.equal(removeStaleProfiles(root), 1);
    assert.deepEqual(fs.readdirSync(root).sort(), [`${PROFILE_PREFIX}fresh`, "something-else"]);
    assert.equal(removeStaleProfiles(path.join(root, "missing")), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the bug report redacts a cookie list the DevTools protocol would answer with", () => {
  const text = redact(
    'cdp: {"cookies":[{"name":"SAP_SESSIONID_ABC_100","value":"sid-secret","domain":"h"},' +
      '{"name": "MYSAPSSO2", "value": "ticket-secret"},{"name":"other","value":"keep"}]}'
  );
  assert.ok(!text.includes("sid-secret"), text);
  assert.ok(!text.includes("ticket-secret"), text);
  assert.match(text, /SAP_SESSIONID_ABC_100/);
  assert.match(text, /"value":"keep"/);
});

// ---------------------------------------------------------------------------
// The pipe
// ---------------------------------------------------------------------------

test("CdpPipe: NUL-framed messages, split and joined chunks, errors name the method only", async () => {
  const fromBrowser = new PassThrough();
  const toBrowser = new PassThrough();
  const cdp = new CdpPipe(fromBrowser, toBrowser);
  const written: string[] = [];
  toBrowser.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
  const events: string[] = [];
  cdp.onEvent((event) => events.push(`${event.method}@${event.sessionId ?? "-"}`));
  const first = cdp.send("Target.getTargets");
  const second = cdp.send("Network.getCookies", { urls: ["x"] }, "S1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    written.join("").split("\0").filter(Boolean).map((m) => JSON.parse(m)),
    [
      { id: 1, method: "Target.getTargets", params: {} },
      { id: 2, method: "Network.getCookies", params: { urls: ["x"] }, sessionId: "S1" },
    ]
  );
  // one answer split over two chunks, an event and an error in one chunk
  fromBrowser.write('{"id":1,"result":{"targetInfos":[]');
  fromBrowser.write('}}\0{"method":"Page.loadEventFired","params":{},"sessionId":"S1"}\0{"id":2,"error":{"message":"secret-free"}}\0');
  assert.deepEqual(await first, { targetInfos: [] });
  await assert.rejects(second, /Network\.getCookies: secret-free/);
  assert.deepEqual(events, ["Page.loadEventFired@S1"]);
  // a closed pipe fails what waits and what comes
  let closedSeen = false;
  cdp.onClose(() => (closedSeen = true));
  const waiting = cdp.send("Browser.close");
  fromBrowser.end();
  await assert.rejects(waiting, /Browser\.close: the browser is gone/);
  assert.ok(closedSeen && cdp.closed);
  await assert.rejects(cdp.send("Page.navigate"), /the browser is gone/);
});

// ---------------------------------------------------------------------------
// The real thing
// ---------------------------------------------------------------------------

/** A Chromium to run: ABAP2UI5_TEST_CHROMIUM, else a playwright install. */
function testChromium(): string | undefined {
  const named = process.env.ABAP2UI5_TEST_CHROMIUM;
  if (named) {
    return fs.existsSync(named) ? named : undefined;
  }
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, "/opt/pw-browsers", path.join(os.homedir(), ".cache", "ms-playwright")];
  for (const root of roots) {
    if (!root) {
      continue;
    }
    let builds: string[] = [];
    try {
      builds = fs.readdirSync(root).filter((e) => /^chromium-\d+$/.test(e));
    } catch {
      continue;
    }
    for (const build of builds) {
      for (const layout of [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"], ["chrome-win", "chrome.exe"], ["chrome-win64", "chrome.exe"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"], ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"]]) {
        const candidate = path.join(root, build, ...layout);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

const CHROMIUM = testChromium();
const SKIP = CHROMIUM
  ? false
  : "no Chromium found (set ABAP2UI5_TEST_CHROMIUM or install playwright's chromium)";

const APP_PAGE =
  '<html><head><script id="sap-ui-bootstrap">/* sap-ui-core.js */</script></head>' +
  "<body>z2ui5 app</body></html>";

interface Landscape {
  system: string;
  idp: string;
  /** Cookie headers the system received, in order. */
  seen: Array<{ path: string; cookie?: string }>;
  /** Valid session ids. */
  sessions: Set<string>;
  /** false: the identity provider waits for a user who never comes. */
  autoLogon: boolean;
  close(): void;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  );
}

/** The fake SAP system on 127.0.0.1 and the fake identity provider on
 *  `localhost` - another host, so their cookies are another host's too. */
async function landscape(): Promise<Landscape> {
  const land: Landscape = {
    system: "",
    idp: "",
    seen: [],
    sessions: new Set(),
    autoLogon: true,
    close: () => undefined,
  };
  let issued = 0;
  let renewed = 0;
  const sessionOf = (cookie: string | undefined) =>
    /(?:^|;\s*)SAP_SESSIONID_ABC_100=([^;]+)/.exec(cookie ?? "")?.[1];
  const system = http.createServer((req, res) => {
    land.seen.push({ path: req.url ?? "", cookie: req.headers.cookie });
    const url = new URL(req.url ?? "/", land.system);
    if (url.pathname === "/sap/saml2/sp/acs") {
      issued++;
      const sid = `sid-${issued}`;
      land.sessions.add(sid);
      res
        .writeHead(302, {
          location: `${land.system}/sap/bc/z2ui5?sap-client=100`,
          "set-cookie": [
            `SAP_SESSIONID_ABC_100=${sid}; path=/; HttpOnly`,
            `MYSAPSSO2=ticket-${issued}; path=/; HttpOnly`,
          ],
        })
        .end();
      return;
    }
    const sid = sessionOf(req.headers.cookie);
    if (!sid || !land.sessions.has(sid)) {
      const back = `${land.system}/sap/saml2/sp/acs`;
      res
        .writeHead(302, {
          location: `${land.idp}/login?return=${encodeURIComponent(back)}`,
          "set-cookie": "sap-usercontext=sap-client=100; path=/",
        })
        .end();
      return;
    }
    if (url.pathname !== "/sap/bc/z2ui5") {
      res.writeHead(404).end(); // the favicon and friends - no renewal there
      return;
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    // a sliding session: the system renews both cookies, plus one of the app's own
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": [
          `SAP_SESSIONID_ABC_100=${sid}; path=/; HttpOnly`,
          `MYSAPSSO2=renewed-${++renewed}; path=/; HttpOnly`,
          "app-state=1; path=/",
        ],
      })
      .end(APP_PAGE);
  });
  const idp = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", land.idp);
    const back = url.searchParams.get("return") ?? "";
    const page = land.autoLogon
      ? `<html><body>signing you on<script>location.replace(${JSON.stringify(back)})</script></body></html>`
      : "<html><body><form>user <input name=u></form></body></html>";
    res
      .writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "idp_session=idp-secret; path=/; HttpOnly",
      })
      .end(page);
  });
  land.system = `http://127.0.0.1:${await listen(system)}`;
  land.idp = `http://localhost:${await listen(idp)}`;
  land.close = () => {
    for (const server of [system, idp]) {
      server.closeAllConnections();
      server.close();
    }
  };
  return land;
}

function request(
  url: string,
  options: { method?: string; headers?: http.OutgoingHttpHeaders } = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? "GET", headers: options.headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function emptyRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "abap2ui5-logon-test-"));
}

test("browser logon end to end: SSO in a real Chromium, cookies replayed by the proxy, kept from the iframe, expiry", { skip: SKIP, timeout: 90_000 }, async () => {
  const land = await landscape();
  const root = emptyRoot();
  const proxy = new SapProxy();
  try {
    const lines: string[] = [];
    const cookies = await runBrowserLogon({
      executable: CHROMIUM!,
      url: `${land.system}/sap/bc/z2ui5?sap-client=100`,
      profileRoot: root,
      headless: true,
      timeoutMs: 45_000,
      log: (m) => lines.push(m),
    });
    // the session and the ticket (the app page renewed it once already) -
    // nothing of the IdP, nothing else of the system
    assert.deepEqual(cookies, { SAP_SESSIONID_ABC_100: "sid-1", MYSAPSSO2: "renewed-1" });
    assert.deepEqual(fs.readdirSync(root), [], "the throwaway profile is gone");
    assert.ok(!lines.join("\n").includes("sid-1"), "no cookie value in the log");
    assert.ok(!lines.join("\n").includes("renewed-1"), "no cookie value in the log");

    const session = new BrowserSession(cookies);
    const strategy = new BrowserLogonStrategy(land.system, session);
    await proxy.start(land.system, strategy);
    const before = land.seen.length;
    const page = await request(`${proxy.origin}/sap/bc/z2ui5?sap-client=100`, {
      headers: { accept: "text/html", cookie: "app-state=0" },
    });
    assert.equal(page.status, 200);
    assert.match(page.body, /z2ui5 app/);
    const sent = land.seen[before].cookie ?? "";
    assert.match(sent, /SAP_SESSIONID_ABC_100=sid-1/);
    assert.match(sent, /MYSAPSSO2=renewed-1/);
    assert.match(sent, /app-state=0/, "the client's own cookie passes");
    assert.doesNotMatch(sent, /idp_session|sap-usercontext/, "the browser's other cookies stay behind");
    // the iframe gets the app's cookie - not the session, not the ticket
    const toIframe = (page.headers["set-cookie"] ?? []).join("\n");
    assert.match(toIframe, /app-state=1/);
    assert.doesNotMatch(toIframe, /MYSAPSSO2|SAP_SESSIONID/);
    // ...which the strategy took over instead (a sliding session)
    assert.deepEqual(strategy.requestCookies(), { SAP_SESSIONID_ABC_100: "sid-1", MYSAPSSO2: "renewed-2" });
    const roundtrip = await request(`${proxy.origin}/sap/bc/z2ui5?sap-client=100`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    assert.equal(roundtrip.status, 200);
    assert.match(land.seen[land.seen.length - 1].cookie ?? "", /MYSAPSSO2=renewed-2/);

    // the system ends the session: the next request is sent to the IdP again
    land.sessions.clear();
    const expired = await request(`${proxy.origin}/sap/bc/z2ui5?sap-client=100`, {
      headers: { accept: "text/html" },
    });
    assert.equal(expired.body, BROWSER_TEXTS.expired.page);
    assert.doesNotMatch(expired.headers.location ?? "", /localhost/, "the iframe is not sent off to the IdP");
    assert.ok(session.expired);
    // and the proxy stops asking the system with the dead session
    const count = land.seen.length;
    const after = await request(`${proxy.origin}/sap/bc/z2ui5?sap-client=100`, { headers: { accept: "text/html" } });
    assert.equal(after.body, BROWSER_TEXTS.expired.page);
    assert.equal(land.seen.length, count);
  } finally {
    await proxy.stop();
    land.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser logon: a user who never finishes runs into the timeout", { skip: SKIP, timeout: 60_000 }, async () => {
  const land = await landscape();
  land.autoLogon = false;
  const root = emptyRoot();
  try {
    await assert.rejects(
      runBrowserLogon({
        executable: CHROMIUM!,
        url: `${land.system}/sap/bc/z2ui5?sap-client=100`,
        profileRoot: root,
        headless: true,
        timeoutMs: 4_000,
      }),
      (err: unknown) => err instanceof BrowserLogonError && err.reason === "timeout"
    );
    assert.deepEqual(fs.readdirSync(root), [], "the throwaway profile is gone");
  } finally {
    land.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser logon: closing the window cancels; so does the abort signal", { skip: SKIP, timeout: 90_000 }, async () => {
  const land = await landscape();
  land.autoLogon = false;
  const root = emptyRoot();
  try {
    await assert.rejects(
      runBrowserLogon({
        executable: CHROMIUM!,
        url: `${land.system}/sap/bc/z2ui5?sap-client=100`,
        profileRoot: root,
        headless: true,
        timeoutMs: 45_000,
        onWindow: (window) => {
          setTimeout(() => void window.close().catch(() => undefined), 500);
        },
      }),
      (err: unknown) => err instanceof BrowserLogonError && err.reason === "closed"
    );
    assert.deepEqual(fs.readdirSync(root), [], "the throwaway profile is gone after a close");

    const abort = new AbortController();
    await assert.rejects(
      runBrowserLogon({
        executable: CHROMIUM!,
        url: `${land.system}/sap/bc/z2ui5?sap-client=100`,
        profileRoot: root,
        headless: true,
        timeoutMs: 45_000,
        signal: abort.signal,
        onWindow: () => setTimeout(() => abort.abort(), 300),
      }),
      (err: unknown) => err instanceof BrowserLogonError && err.reason === "aborted"
    );
    assert.deepEqual(fs.readdirSync(root), [], "the throwaway profile is gone after a cancel");
  } finally {
    land.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser logon: a program that is no browser fails cleanly", { timeout: 30_000 }, async () => {
  const root = emptyRoot();
  try {
    await assert.rejects(
      runBrowserLogon({
        executable: path.join(root, "no-such-browser"),
        url: "http://127.0.0.1:9/",
        profileRoot: root,
        timeoutMs: 10_000,
      }),
      (err: unknown) => err instanceof BrowserLogonError && (err.reason === "failed" || err.reason === "closed")
    );
    assert.deepEqual(fs.readdirSync(root).filter((e) => e.startsWith(PROFILE_PREFIX)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
