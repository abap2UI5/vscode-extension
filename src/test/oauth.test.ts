import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { createHash } from "crypto";
import { AddressInfo } from "net";
import { inspect } from "util";
import { InteractiveLogonRequired } from "../authstrategy";
import { ProxyResponse, SapProxy } from "../proxy";
import { oauthLogonNeeded, strategyFor } from "../logon";
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  keyOriginMismatch,
  OAUTH_TEXTS,
  OAuthStrategy,
  OAuthTokenError,
  OAuthTokens,
  parseServiceKey,
  parseTokenAnswer,
  pkceChallenge,
  readCallback,
  readStoredOAuth,
  refreshDueAt,
  ServiceKey,
  ServiceKeyError,
  storedOAuthText,
} from "../oauth";
import { logOnInBrowser, postForm, startCallbackListener } from "../oauthflow";
import { buildReport, redact, ReportInput } from "../report";
import { relogonOffer } from "../connectcheck";

/*
 * auth: "oauth" against a fake UAA and a fake system, both node http on
 * loopback. The fake UAA's /oauth/authorize redirects straight back with a
 * code (a user who is already logged on); the test plays the browser by
 * following that redirect with an HTTP client instead of openExternal.
 */

const CLIENT_ID = "sb-abap-client!b1";
const CLIENT_SECRET = "client-secret-SHOULD-NEVER-PRINT$=";

interface FakeUaa {
  url: string;
  authorizeCalls: number;
  codeGrants: number;
  refreshGrants: number;
  /** Access tokens the fake system accepts. */
  valid: Set<string>;
  /** Every secret the UAA handed out or saw - none may appear in a log. */
  secrets: Set<string>;
  expiresIn: number;
  refuseRefresh: boolean;
  /** Answer the authorize redirect with another state. */
  forgeState: boolean;
  /** Delay of the token answers, to make concurrent renewals overlap. */
  delayMs: number;
  /** Rotate the refresh token on every renewal. */
  rotate: boolean;
  close(): void;
}

async function fakeUaa(): Promise<FakeUaa> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  let counter = 0;
  const uaa: FakeUaa = {
    url: "",
    authorizeCalls: 0,
    codeGrants: 0,
    refreshGrants: 0,
    valid: new Set(),
    secrets: new Set([CLIENT_SECRET]),
    expiresIn: 3600,
    refuseRefresh: false,
    forgeState: false,
    delayMs: 0,
    rotate: true,
    close: () => undefined,
  };
  const issue = (res: http.ServerResponse, withRefresh: boolean) => {
    counter++;
    const access = `access-token-${counter}-${Math.random().toString(36).slice(2)}`;
    uaa.valid.add(access);
    uaa.secrets.add(access);
    const body: Record<string, unknown> = {
      access_token: access,
      token_type: "bearer",
      expires_in: uaa.expiresIn,
    };
    if (withRefresh) {
      const refresh = `refresh-token-${counter}-${Math.random().toString(36).slice(2)}`;
      refreshTokens.add(refresh);
      uaa.secrets.add(refresh);
      body.refresh_token = refresh;
    }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    }, uaa.delayMs);
  };
  const fail = (res: http.ServerResponse, status: number, error: string) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error, error_description: "nope" }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/oauth/authorize") {
      uaa.authorizeCalls++;
      const q = url.searchParams;
      if (
        q.get("response_type") !== "code" ||
        q.get("client_id") !== CLIENT_ID ||
        q.get("code_challenge_method") !== "S256" ||
        !q.get("code_challenge") ||
        !q.get("redirect_uri") ||
        !q.get("state")
      ) {
        res.writeHead(400).end("bad authorize request");
        return;
      }
      const code = `auth-code-${Math.random().toString(36).slice(2)}`;
      uaa.secrets.add(code);
      codes.set(code, { challenge: q.get("code_challenge")!, redirectUri: q.get("redirect_uri")! });
      const back = new URL(q.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", uaa.forgeState ? "forged-state" : q.get("state")!);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (body += c));
      req.on("end", () => {
        const expected = "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
        if (req.headers.authorization !== expected) {
          fail(res, 401, "invalid_client");
          return;
        }
        if (req.headers["content-type"] !== "application/x-www-form-urlencoded") {
          fail(res, 400, "invalid_request");
          return;
        }
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "authorization_code") {
          uaa.codeGrants++;
          const code = form.get("code") ?? "";
          const issued = codes.get(code);
          codes.delete(code); // single use
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256")
            .update(verifier)
            .digest("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
          if (!issued || issued.redirectUri !== form.get("redirect_uri") || issued.challenge !== challenge) {
            fail(res, 400, "invalid_grant");
            return;
          }
          issue(res, true);
          return;
        }
        if (form.get("grant_type") === "refresh_token") {
          uaa.refreshGrants++;
          const token = form.get("refresh_token") ?? "";
          if (uaa.refuseRefresh || !refreshTokens.has(token)) {
            setTimeout(() => fail(res, 401, "invalid_grant"), uaa.delayMs);
            return;
          }
          if (uaa.rotate) {
            refreshTokens.delete(token);
          }
          issue(res, uaa.rotate);
          return;
        }
        fail(res, 400, "unsupported_grant_type");
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  uaa.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  uaa.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return uaa;
}

interface FakeSystem {
  origin: string;
  seen: Array<{ path: string; authorization?: string }>;
  /** Accept no token at all - a key of another system. */
  refuseAll: boolean;
  close(): void;
}

/** A system that answers only a bearer token the fake UAA issued. */
async function fakeSystem(uaa: FakeUaa): Promise<FakeSystem> {
  const system: FakeSystem = { origin: "", seen: [], refuseAll: false, close: () => undefined };
  const server = http.createServer((req, res) => {
    system.seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || !uaa.valid.has(bearer) || system.refuseAll) {
      res.writeHead(401, { "www-authenticate": 'Bearer realm="abap"', "content-type": "text/plain" }).end("no");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end("app page");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  system.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  system.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return system;
}

function get(
  url: string,
  headers: http.OutgoingHttpHeaders = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on("error", reject);
  });
}

/** The browser: follows the UAA's redirect back to the loopback listener. */
async function browser(url: string, seen: string[] = []): Promise<boolean> {
  seen.push(url);
  const authorize = await get(url);
  assert.equal(authorize.status, 302, authorize.body);
  await get(String(authorize.headers.location));
  return true;
}

function keyFor(uaa: FakeUaa, systemUrl: string): ServiceKey {
  return parseServiceKey(
    { url: systemUrl, uaa: { url: uaa.url, clientid: CLIENT_ID, clientsecret: CLIENT_SECRET } },
    { allowLoopbackHttp: true }
  );
}

// ---------------------------------------------------------------------------
// The service key
// ---------------------------------------------------------------------------

test("service key: the documented shapes are accepted, everything else refused with a sentence", () => {
  const plain = {
    url: "https://abc.abap.eu10.hana.ondemand.com",
    uaa: {
      url: "https://sub.authentication.eu10.hana.ondemand.com/",
      clientid: "sb-1",
      clientsecret: "s3cr3t-value",
    },
    abap: { username: "x" },
    binding: { env: "cf" },
  };
  const want = {
    systemUrl: "https://abc.abap.eu10.hana.ondemand.com",
    uaaUrl: "https://sub.authentication.eu10.hana.ondemand.com",
    clientId: "sb-1",
    clientSecret: "s3cr3t-value",
  };
  assert.deepEqual(parseServiceKey(JSON.stringify(plain)), want);
  assert.deepEqual(parseServiceKey("﻿" + JSON.stringify(plain)), want);
  // as the Cloud Foundry CLI prints it
  assert.deepEqual(parseServiceKey({ credentials: plain }), want);
  // no top-level url, but the endpoints block
  const { url: _url, ...noUrl } = plain;
  assert.deepEqual(
    parseServiceKey({ ...noUrl, endpoints: { abap: "https://abc.abap.eu10.hana.ondemand.com" } }),
    want
  );

  const refusals: Array<[unknown, RegExp]> = [
    ["not json", /not JSON/],
    ["[]", /not a JSON object/],
    [{ url: plain.url }, /no "uaa" block/],
    [{ ...plain, uaa: { ...plain.uaa, clientsecret: "" } }, /no "uaa\.clientsecret"/],
    [{ uaa: plain.uaa }, /no "url"/],
    [{ ...plain, url: "http://abc.example.com" }, /"url" is not an https URL/],
    [{ ...plain, uaa: { ...plain.uaa, url: "http://127.0.0.1:1" } }, /"uaa\.url" is not an https URL/],
    [{ ...plain, uaa: { ...plain.uaa, url: "https://u:p@uaa.example.com" } }, /more than a host/],
    [{ ...plain, url: "not a url" }, /"url" is not a URL/],
  ];
  for (const [input, message] of refusals) {
    assert.throws(
      () => parseServiceKey(typeof input === "string" ? input : (input as object)),
      (err: unknown) =>
        err instanceof ServiceKeyError &&
        message.test(err.message) &&
        /"uaa" block|URL|host/.test(err.message) &&
        !err.message.includes("s3cr3t-value"),
      String(message)
    );
  }
  // plain http on loopback only for the local test servers - and only when asked
  assert.equal(
    parseServiceKey({ ...plain, uaa: { ...plain.uaa, url: "http://127.0.0.1:9" } }, { allowLoopbackHttp: true }).uaaUrl,
    "http://127.0.0.1:9"
  );
  assert.throws(() =>
    parseServiceKey({ ...plain, uaa: { ...plain.uaa, url: "http://uaa.example.com" } }, { allowLoopbackHttp: true })
  );

  assert.equal(keyOriginMismatch(want, "https://abc.abap.eu10.hana.ondemand.com"), undefined);
  assert.match(
    keyOriginMismatch(want, "https://abc.abap-web.eu10.hana.ondemand.com") ?? "",
    /for abc\.abap\.eu10.*launch URL is on abc\.abap-web/
  );
});

test("the stored entry keeps the whole key and the refresh token, and reads back tolerantly", () => {
  const serviceKey = { url: "https://a", uaa: { url: "https://u", clientid: "c", clientsecret: "s" }, extra: 1 };
  assert.deepEqual(readStoredOAuth(storedOAuthText({ serviceKey, refreshToken: "r" })), { serviceKey, refreshToken: "r" });
  assert.deepEqual(readStoredOAuth(storedOAuthText({ serviceKey })), { serviceKey });
  for (const junk of [undefined, "", "{", "[]", '{"serviceKey":1}']) {
    assert.equal(readStoredOAuth(junk), undefined, String(junk));
  }
});

// ---------------------------------------------------------------------------
// The flow's decisions
// ---------------------------------------------------------------------------

test("PKCE S256, the authorize URL and the callback's state check", () => {
  // S256: base64url of the SHA-256 of the verifier, without padding
  const verifier = "dBjftJeZ4CVP-mJ92ZEUOhqBMr4T-8xBkjCU5rHNSi8";
  assert.equal(pkceChallenge(verifier), createHash("sha256").update(verifier).digest("base64url"));
  assert.doesNotMatch(pkceChallenge(verifier), /[+/=]/);
  const pkce = createPkce();
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pkce.challenge, pkceChallenge(pkce.verifier));
  assert.notEqual(createPkce().verifier, pkce.verifier);

  const key: ServiceKey = { systemUrl: "https://s", uaaUrl: "https://uaa.example.com", clientId: "sb-x!b1", clientSecret: "secret" };
  const url = new URL(authorizeUrl(key, { redirectUri: "http://127.0.0.1:5/abc", state: "st", challenge: "ch" }));
  assert.equal(url.origin + url.pathname, "https://uaa.example.com/oauth/authorize");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    response_type: "code",
    client_id: "sb-x!b1",
    redirect_uri: "http://127.0.0.1:5/abc",
    state: "st",
    code_challenge: "ch",
    code_challenge_method: "S256",
  });
  assert.ok(!url.toString().includes("secret"), "the client secret never goes to the browser");

  assert.deepEqual(readCallback(new URLSearchParams("code=c1&state=st"), "st"), { code: "c1" });
  assert.match((readCallback(new URLSearchParams("code=c1&state=other"), "st") as { refused: string }).refused, /state/);
  assert.match((readCallback(new URLSearchParams("code=c1"), "st") as { refused: string }).refused, /state/);
  assert.match(
    (readCallback(new URLSearchParams("error=access_denied&state=st"), "st") as { refused: string }).refused,
    /refused the logon \(access_denied\)/
  );
  assert.match((readCallback(new URLSearchParams("state=st"), "st") as { refused: string }).refused, /no authorization code/);
});

test("token answers: what each failure means, and when a token is renewed", () => {
  const ok = parseTokenAnswer(200, JSON.stringify({ access_token: "a", token_type: "bearer", expires_in: 100, refresh_token: "r" }), 1000);
  assert.deepEqual(ok, { accessToken: "a", refreshToken: "r", obtainedAt: 1000, expiresAt: 101_000 });
  assert.deepEqual(parseTokenAnswer(200, JSON.stringify({ access_token: "a" }), 5), { accessToken: "a", obtainedAt: 5 });
  const kindOf = (status: number, body: string) => {
    try {
      parseTokenAnswer(status, body, 0);
      return "ok";
    } catch (err) {
      assert.ok(err instanceof OAuthTokenError);
      assert.ok(!err.message.includes("secret-description"), "the UAA's description is not quoted");
      return err.kind;
    }
  };
  const e = (error: string) => JSON.stringify({ error, error_description: "secret-description" });
  assert.equal(kindOf(400, e("invalid_grant")), "refused");
  assert.equal(kindOf(401, e("invalid_grant")), "refused");
  assert.equal(kindOf(401, e("invalid_client")), "client");
  assert.equal(kindOf(401, "<html>"), "client");
  assert.equal(kindOf(503, e("temporarily_unavailable")), "transient");
  assert.equal(kindOf(429, ""), "transient");
  assert.equal(kindOf(200, "{}"), "malformed");
  assert.equal(kindOf(200, JSON.stringify({ access_token: "a", token_type: "mac" })), "malformed");

  // 80 % of the lifetime, at the latest a minute before the end
  assert.equal(refreshDueAt({ obtainedAt: 0, expiresAt: 12 * 3600_000 }), 34_560_000);
  assert.equal(refreshDueAt({ obtainedAt: 0, expiresAt: 120_000 }), 60_000);
  assert.equal(refreshDueAt({ obtainedAt: 0, expiresAt: 30_000 }), 0);
  assert.equal(refreshDueAt({ obtainedAt: 0 }), undefined);
});

// ---------------------------------------------------------------------------
// The loopback listener
// ---------------------------------------------------------------------------

test("the callback listener: wrong path 404, foreign Host refused, closed after the first valid callback", async () => {
  const listener = await startCallbackListener({ state: "the-state" });
  const redirect = new URL(listener.redirectUri);
  assert.equal(redirect.hostname, "127.0.0.1");
  assert.match(redirect.pathname, /^\/[0-9a-f]{32}$/);
  const base = `http://127.0.0.1:${redirect.port}`;

  assert.equal((await get(`${base}/`)).status, 404);
  assert.equal((await get(`${base}/oauth/callback?code=c&state=the-state`)).status, 404);
  assert.equal((await get(`${base}${redirect.pathname}x?code=c&state=the-state`)).status, 404);
  // DNS rebinding: the right path under another name is refused outright
  const rebound = await get(`${listener.redirectUri}?code=c&state=the-state`, { host: "attacker.example:80" });
  assert.equal(rebound.status, 403);

  const answer = await get(`${listener.redirectUri}?code=the-code&state=the-state`);
  assert.equal(answer.status, 200);
  assert.match(answer.body, /close this tab/);
  assert.equal(answer.headers["referrer-policy"], "no-referrer");
  assert.ok(!answer.body.includes("the-code"));
  assert.equal(await listener.code, "the-code");
  // closed: nothing listens any more
  await assert.rejects(get(`${listener.redirectUri}?code=again&state=the-state`), /ECONNREFUSED|ECONNRESET|socket hang up/);
});

test("the callback listener: a wrong state ends the logon; a timeout and an abort too", async () => {
  const forged = await startCallbackListener({ state: "right" });
  const answer = await get(`${forged.redirectUri}?code=c&state=wrong`);
  assert.equal(answer.status, 400);
  await assert.rejects(forged.code, /state/);
  await assert.rejects(get(`${forged.redirectUri}?code=c&state=right`));

  const slow = await startCallbackListener({ state: "s", timeoutMs: 30 });
  await assert.rejects(slow.code, /did not come back/);

  const abort = new AbortController();
  const cancelled = await startCallbackListener({ state: "s", signal: abort.signal });
  abort.abort();
  await assert.rejects(cancelled.code, /cancelled/);
});

// ---------------------------------------------------------------------------
// The whole logon, the proxy, renewal
// ---------------------------------------------------------------------------

test("full logon: browser, code exchange with PKCE, and the proxy sends the bearer", async () => {
  const uaa = await fakeUaa();
  const system = await fakeSystem(uaa);
  const proxy = new SapProxy();
  const opened: string[] = [];
  try {
    const key = keyFor(uaa, system.origin);
    const tokens = await logOnInBrowser({ key, openBrowser: (url) => browser(url, opened), post: postForm });
    assert.equal(uaa.authorizeCalls, 1);
    assert.equal(uaa.codeGrants, 1);
    assert.ok(tokens.refreshToken);
    assert.ok(uaa.valid.has(tokens.accessToken));
    assert.ok(!opened[0].includes(CLIENT_SECRET), "the browser never sees the client secret");

    const stored: Array<string | undefined> = [];
    const strategy = new OAuthStrategy({ key, tokens, post: postForm, onRefreshToken: (t) => void stored.push(t) });
    await proxy.start(system.origin, strategy);
    assert.equal(proxy.authKind, "oauth");
    const page = await get(`${proxy.origin}/sap/bc/z2ui5`);
    assert.equal(page.status, 200);
    assert.equal(system.seen[0].authorization, `Bearer ${tokens.accessToken}`);
    const fetched = await proxy.fetchFromSystem("/sap/bc/adt/x");
    assert.equal(fetched.status, 200);
    assert.equal(uaa.refreshGrants, 0, "a fresh token is not renewed");
    assert.deepEqual(stored, []);
    // the strategy prints nothing secret
    const printed = JSON.stringify(strategy) + inspect(strategy, { showHidden: true, depth: 5 });
    for (const secret of [CLIENT_SECRET, tokens.accessToken, tokens.refreshToken!]) {
      assert.ok(!printed.includes(secret));
    }
  } finally {
    await proxy.stop();
    system.close();
    uaa.close();
  }
});

test("a forged state and a wrong PKCE verifier are refused", async () => {
  const uaa = await fakeUaa();
  try {
    const key = keyFor(uaa, "https://system.example.com");
    uaa.forgeState = true;
    await assert.rejects(
      logOnInBrowser({ key, openBrowser: (url) => browser(url).catch(() => true), post: postForm }),
      /state/
    );
    assert.equal(uaa.codeGrants, 0, "a forged callback's code is never exchanged");
    uaa.forgeState = false;

    // a code obtained with one challenge cannot be redeemed with another verifier
    const listener = await startCallbackListener({ state: "s" });
    const right = createPkce();
    const authorize = await get(
      authorizeUrl(key, { redirectUri: listener.redirectUri, state: "s", challenge: right.challenge })
    );
    await get(String(authorize.headers.location));
    const code = await listener.code;
    await assert.rejects(
      exchangeCode(key, { code, redirectUri: listener.redirectUri, verifier: createPkce().verifier }, postForm),
      (err: unknown) => err instanceof OAuthTokenError && err.kind === "refused"
    );
    // a wrong client secret is the key's problem, not the logon's
    const listener2 = await startCallbackListener({ state: "s" });
    const again = await get(
      authorizeUrl(key, { redirectUri: listener2.redirectUri, state: "s", challenge: right.challenge })
    );
    await get(String(again.headers.location));
    await assert.rejects(
      exchangeCode(
        { ...key, clientSecret: "wrong" },
        { code: await listener2.code, redirectUri: listener2.redirectUri, verifier: right.verifier },
        postForm
      ),
      (err: unknown) => err instanceof OAuthTokenError && err.kind === "client"
    );
  } finally {
    uaa.close();
  }
});

test("renewal before expiry: once for all concurrent requests, the rotated refresh token persisted", async () => {
  const uaa = await fakeUaa();
  const system = await fakeSystem(uaa);
  const proxy = new SapProxy();
  try {
    const key = keyFor(uaa, system.origin);
    let clock = 1_000_000;
    uaa.expiresIn = 600; // 10 min: due at 8 min
    const tokens = await logOnInBrowser({ key, openBrowser: (url) => browser(url), now: () => clock });
    const stored: Array<string | undefined> = [];
    const logged: string[] = [];
    const strategy = new OAuthStrategy({
      key,
      tokens,
      post: postForm,
      now: () => clock,
      onRefreshToken: (t) => void stored.push(t),
      log: (m) => logged.push(m),
    });
    await proxy.start(system.origin, strategy);
    clock += 7 * 60_000;
    assert.equal((await get(`${proxy.origin}/a`)).status, 200);
    assert.equal(uaa.refreshGrants, 0, "not due yet");

    clock += 2 * 60_000; // past 80 %
    uaa.delayMs = 50;
    const answers = await Promise.all([
      get(`${proxy.origin}/b1`),
      get(`${proxy.origin}/b2`),
      get(`${proxy.origin}/b3`),
      proxy.fetchFromSystem("/b4"),
      proxy.fetchFromSystem("/b5"),
    ]);
    assert.deepEqual(answers.map((a) => a.status), [200, 200, 200, 200, 200]);
    assert.equal(uaa.refreshGrants, 1, "single-flight: one renewal for five waiting requests");
    const renewed = system.seen.slice(1).map((s) => s.authorization);
    assert.equal(new Set(renewed).size, 1);
    assert.notEqual(renewed[0], `Bearer ${tokens.accessToken}`);
    assert.equal(stored.length, 1);
    assert.ok(stored[0] && stored[0] !== tokens.refreshToken, "the rotated refresh token is persisted");
    assert.ok(logged.some((m) => /renewed, valid for 10 min/.test(m)));
  } finally {
    await proxy.stop();
    system.close();
    uaa.close();
  }
});

test("a refused renewal is the proxy's expired path - no lockout wording - and forgets the refresh token", async () => {
  const uaa = await fakeUaa();
  const system = await fakeSystem(uaa);
  const proxy = new SapProxy();
  const reported: ProxyResponse[] = [];
  proxy.onResponse = (r) => reported.push(r);
  try {
    const key = keyFor(uaa, system.origin);
    let clock = 0;
    const tokens = await logOnInBrowser({ key, openBrowser: (url) => browser(url), now: () => clock });
    const stored: Array<string | undefined> = [];
    const strategy = new OAuthStrategy({ key, tokens, post: postForm, now: () => clock, onRefreshToken: (t) => void stored.push(t) });
    await proxy.start(system.origin, strategy);
    uaa.refuseRefresh = true;
    clock += 3600_000;
    const page = await get(`${proxy.origin}/app`);
    assert.equal(page.status, 401);
    assert.equal(page.body, OAUTH_TEXTS.expired.page);
    assert.doesNotMatch(page.body, /lock/i);
    assert.equal(system.seen.length, 0, "nothing reached the system with a dead token");
    assert.deepEqual(stored, [undefined], "the refused refresh token is forgotten");
    assert.ok(reported.some((r) => r.expired && r.status === 401));
    const offer = relogonOffer("oauth", 401, "", true, false);
    assert.equal(offer.button, "Log On Again");
    assert.doesNotMatch(offer.message, /lock/i);
    // the breaker holds: later requests are answered locally, the UAA is not asked again
    const grants = uaa.refreshGrants;
    assert.equal((await get(`${proxy.origin}/app2`)).body, OAUTH_TEXTS.expired.page);
    await assert.rejects(proxy.fetchFromSystem("/adt"), new RegExp(OAUTH_TEXTS.expired.error));
    assert.equal(uaa.refreshGrants, grants);

    // the editor's own flows get the same answer from prepare( )
    const direct = new OAuthStrategy({ key, refreshToken: "revoked", post: postForm });
    await assert.rejects(direct.prepare(), (err: unknown) => err instanceof InteractiveLogonRequired);
  } finally {
    await proxy.stop();
    system.close();
    uaa.close();
  }
});

test("a 401 to a valid-looking token renews once; a 401 to the renewed one is rejected", async () => {
  const uaa = await fakeUaa();
  const system = await fakeSystem(uaa);
  const proxy = new SapProxy();
  try {
    const key = keyFor(uaa, system.origin);
    const tokens = await logOnInBrowser({ key, openBrowser: (url) => browser(url) });
    await proxy.start(system.origin, new OAuthStrategy({ key, tokens, post: postForm }));
    uaa.valid.delete(tokens.accessToken); // revoked on the server
    assert.equal((await get(`${proxy.origin}/one`)).status, 401);
    assert.equal((await get(`${proxy.origin}/two`)).status, 200, "renewed once, then accepted");
    assert.equal(uaa.refreshGrants, 1);

    // a system that takes none of this key's tokens
    system.refuseAll = true;
    await get(`${proxy.origin}/three`); // 401: renew once
    assert.equal((await get(`${proxy.origin}/four`)).status, 401); // 401 to the renewed token
    const held = await get(`${proxy.origin}/five`);
    assert.equal(held.body, OAUTH_TEXTS.rejected.page);
    assert.match(held.body, /Load Service Key/);
    assert.equal(uaa.refreshGrants, 2, "no burst of renewals");
  } finally {
    await proxy.stop();
    system.close();
    uaa.close();
  }
});

test("the MCP path: a refresh token works without a browser, none gets the refusal naming F9", async () => {
  const uaa = await fakeUaa();
  const system = await fakeSystem(uaa);
  const proxy = new SapProxy();
  try {
    const key = keyFor(uaa, system.origin);
    const tokens = await logOnInBrowser({ key, openBrowser: (url) => browser(url) });
    const authorizeCalls = uaa.authorizeCalls;
    // a strategy started from the stored refresh token alone renews in prepare( )
    const fromStore = await strategyFor({ auth: "oauth" }, system.origin, {
      basicCredentials: async () => assert.fail("no password"),
      clientCertificate: async () => assert.fail("no certificate"),
      oauthLogon: async () => ({ key, refreshToken: tokens.refreshToken, post: postForm }),
    });
    assert.ok(fromStore instanceof OAuthStrategy);
    await proxy.start(system.origin, fromStore);
    assert.equal((await proxy.fetchFromSystem("/adt")).status, 200);
    assert.equal(uaa.authorizeCalls, authorizeCalls, "no browser was involved");

    const refusal = oauthLogonNeeded("abc.example.com", true);
    assert.ok(refusal instanceof InteractiveLogonRequired);
    assert.match(refusal.message, /F9/);
    assert.match(oauthLogonNeeded("abc.example.com", false).message, /Load Service Key/);
    await assert.rejects(
      strategyFor({ auth: "oauth" }, system.origin, {
        basicCredentials: async () => undefined,
        clientCertificate: async () => undefined,
        oauthLogon: async () => {
          throw oauthLogonNeeded("abc.example.com", true);
        },
      }),
      /F9/
    );
  } finally {
    await proxy.stop();
    system.close();
    uaa.close();
  }
});

// ---------------------------------------------------------------------------
// Nothing secret in logs or the bug report
// ---------------------------------------------------------------------------

test("no token, secret or code in the log lines or in the bug report", async () => {
  const uaa = await fakeUaa();
  const system = await fakeSystem(uaa);
  const proxy = new SapProxy();
  const lines: string[] = [];
  proxy.onResponse = (r) => lines.push(`proxy: ${r.status} ${r.path} ${r.reason ?? ""}`);
  try {
    const key = keyFor(uaa, system.origin);
    let clock = 0;
    const opened: string[] = [];
    const tokens: OAuthTokens = await logOnInBrowser({ key, openBrowser: (url) => browser(url, opened), now: () => clock });
    const strategy = new OAuthStrategy({ key, tokens, post: postForm, now: () => clock, log: (m) => lines.push(m) });
    await proxy.start(system.origin, strategy);
    clock += 3600_000;
    await get(`${proxy.origin}/renew`);
    uaa.refuseRefresh = true;
    clock += 2 * 3600_000;
    await get(`${proxy.origin}/expired`);
    assert.ok(lines.some((l) => /renewed/.test(l)) && lines.some((l) => /refused/.test(l)));
    for (const line of lines) {
      for (const secret of uaa.secrets) {
        assert.ok(!line.includes(secret), `a log line carries a secret: ${line}`);
      }
    }

    // and what a log line could quote, should one ever: the report removes it
    const code = [...uaa.secrets].find((s) => s.startsWith("auth-code-"))!;
    const refresh = [...uaa.secrets].find((s) => s.startsWith("refresh-token-"))!;
    const callback = new URL(opened[0]).searchParams.get("redirect_uri")!;
    const quoted = [
      `GET ${callback}?code=${code}&state=abc123`,
      `authorize: ${opened[0]}`,
      `token body: grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(callback)}&code_verifier=verif-123`,
      `token body: grant_type=refresh_token&refresh_token=${refresh}`,
      `answer: {"access_token":"${tokens.accessToken}","refresh_token":"${refresh}","expires_in":3600}`,
      `stored: ${storedOAuthText({ serviceKey: { url: system.origin, uaa: { url: uaa.url, clientid: CLIENT_ID, clientsecret: CLIENT_SECRET } }, refreshToken: refresh })}`,
      `stored camel: {"refreshToken":"${refresh}","accessToken":"${tokens.accessToken}","code":"${code}"}`,
      `request: Authorization: Bearer ${tokens.accessToken}`,
      `request: authorization: Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
    ];
    const input: ReportInput = {
      extensionVersion: "0.31.0",
      vscodeVersion: "1.101.0",
      platform: "linux x64",
      host: "desktop",
      workspaceFolders: [],
      documents: [],
      settings: {},
      renderGate: { installed: false },
      systems: { configured: 1, active: "BTP", proxyRunning: true, logon: [{ name: "BTP", auth: "oauth" }], proxyLogon: "oauth" },
      relatedExtensions: [],
      recentLog: [...lines, ...quoted],
    };
    const report = buildReport(input);
    const token = new URL(callback).pathname.slice(1);
    for (const secret of [...uaa.secrets, token, "verif-123", "abc123"]) {
      assert.ok(!report.includes(secret), `the report carries ${secret.slice(0, 14)}...`);
    }
    assert.match(report, /oauth/);
    // the shape survives where it is the diagnostic part
    assert.match(redact(`GET ${callback}?code=${code}`), /127\.0\.0\.1:\d+\/<token>\?code=<redacted>/);
  } finally {
    await proxy.stop();
    system.close();
    uaa.close();
  }
});
