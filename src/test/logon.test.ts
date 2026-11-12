import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as net from "net";
import { AddressInfo } from "net";
import { inspect } from "util";
import {
  AuthStrategy,
  BASIC_TEXTS,
  BasicAuthStrategy,
  CERTIFICATE_TEXTS,
  CertificateAuthStrategy,
  InteractiveLogonRequired,
  mergeCookies,
  setCookieName,
  setCookieValue,
} from "../authstrategy";
import { ProxyResponse, SapProxy } from "../proxy";
import { BrowserSession } from "../browserlogon";
import { authKindOf, certificateNeeded, secretKeysFor, strategyFor } from "../logon";
import { AUTH_KINDS, profileFieldsOf, tightenAuth } from "../systemprofile";
import { classifyBody, classifyStatus, describeConnectFailure, relogonOffer } from "../connectcheck";

/*
 * The six additions of docs/auth.md section 7 as the proxy carries them out,
 * against a fake system on plain http: `prepare`, `requestCookies` /
 * `takeSetCookie`, the `expired` verdict and `classifyAnswer`, `texts` - and
 * the factory that turns a profile's `auth` into a strategy. `tlsOptions`
 * needs a TLS server: `clientcert.test.ts`.
 */

interface Seen {
  path: string;
  authorization?: string;
  cookie?: string;
  marker?: string;
}

interface FakeSystem {
  origin: string;
  seen: Seen[];
  /** What the next answers are: status, headers, body. */
  answer: { status: number; headers: http.OutgoingHttpHeaders; body: string };
  close(): void;
}

async function fakeSystem(): Promise<FakeSystem> {
  const system: FakeSystem = {
    origin: "",
    seen: [],
    answer: { status: 200, headers: { "content-type": "text/plain" }, body: "ok" },
    close: () => undefined,
  };
  const record = (req: http.IncomingMessage) =>
    system.seen.push({
      path: req.url ?? "",
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      marker: req.headers["x-logon"] as string | undefined,
    });
  const server = http.createServer((req, res) => {
    record(req);
    res.writeHead(system.answer.status, system.answer.headers).end(system.answer.body);
  });
  server.on("upgrade", (req, socket) => {
    record(req);
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n" +
        "set-cookie: MYSAPSSO2=ticket-from-upgrade; path=/\r\n" +
        "set-cookie: other=1; path=/\r\n\r\n"
    );
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

function upgradeHead(proxyOrigin: string, path: string): Promise<string> {
  const url = new URL(proxyOrigin);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${url.pathname}${path} HTTP/1.1\r\nhost: ${url.host}\r\n` +
          "connection: Upgrade\r\nupgrade: websocket\r\n\r\n"
      );
    });
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      answer += chunk;
      if (answer.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(answer));
  });
}

/** A cookie strategy of the browser-logon shape, for the proxy's half. */
class CookieStrategy implements AuthStrategy {
  readonly kind = "test-cookies";
  readonly texts = {
    rejected: { page: "test: rejected page", error: "test: rejected" },
    expired: { page: "test: your test logon expired - log on again", error: "test: expired" },
  };
  cookies: Record<string, string> = { MYSAPSSO2: "ticket-1", SAP_SESSIONID_X_100: "s-1" };
  taken: Array<[string, string]> = [];
  prepared = 0;
  verdict: "rejected" | "expired" | "ignore" = "expired";
  classify?: AuthStrategy["classifyAnswer"];
  failPrepare?: Error;
  requestHeaders(): Record<string, string> {
    return { "x-logon": `prepared-${this.prepared}` };
  }
  onUnauthorized() {
    return this.verdict;
  }
  async prepare(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.failPrepare) {
      throw this.failPrepare;
    }
    this.prepared++;
  }
  requestCookies(): Record<string, string> {
    return { ...this.cookies };
  }
  takeSetCookie(name: string, value: string): void {
    this.taken.push([name, value]);
  }
  classifyAnswer(answer: Parameters<NonNullable<AuthStrategy["classifyAnswer"]>>[0]) {
    return this.classify ? this.classify(answer) : "ok";
  }
}

test("mergeCookies: the strategy wins per name, the client's other cookies pass", () => {
  assert.equal(
    mergeCookies("a=1; MYSAPSSO2=stale; b=2", { MYSAPSSO2: "fresh" }),
    "a=1; b=2; MYSAPSSO2=fresh"
  );
  assert.equal(mergeCookies(undefined, { s: "1" }), "s=1");
  assert.equal(mergeCookies("a=1", undefined), "a=1");
  assert.equal(mergeCookies("", {}), undefined);
  // a name that only STARTS like the strategy's is another cookie
  assert.equal(mergeCookies("MYSAPSSO2X=keep", { MYSAPSSO2: "t" }), "MYSAPSSO2X=keep; MYSAPSSO2=t");
  assert.equal(setCookieName("MYSAPSSO2=abc=def; path=/; HttpOnly"), "MYSAPSSO2");
  assert.equal(setCookieValue("MYSAPSSO2=abc=def; path=/; HttpOnly"), "abc=def");
});

test("prepare( ) is awaited before every request, and cookies are merged on all three paths", async () => {
  const system = await fakeSystem();
  const proxy = new SapProxy();
  const strategy = new CookieStrategy();
  try {
    await proxy.start(system.origin, strategy);
    const forwarded = await get(`${proxy.origin}/page`, {
      cookie: "app=keep; MYSAPSSO2=from-the-jar; __abap2ui5_proxy_1=x",
    });
    assert.equal(forwarded.status, 200);
    await proxy.fetchFromSystem("/adt");
    assert.match(await upgradeHead(proxy.origin, "/ws"), /^HTTP\/1\.1 101/);
    assert.deepEqual(
      system.seen.map((s) => s.marker),
      ["prepared-1", "prepared-2", "prepared-3"],
      "each request left after its own prepare( )"
    );
    // the client's own cookie passes, the strategy's wins, the token stays home
    assert.equal(system.seen[0].cookie, "app=keep; MYSAPSSO2=ticket-1; SAP_SESSIONID_X_100=s-1");
    assert.equal(system.seen[1].cookie, "MYSAPSSO2=ticket-1; SAP_SESSIONID_X_100=s-1");
    assert.equal(system.seen[2].cookie, "MYSAPSSO2=ticket-1; SAP_SESSIONID_X_100=s-1");
    assert.equal(system.seen[0].authorization, undefined);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("the strategy's cookies and MYSAPSSO2 are kept out of the answers, and handed to takeSetCookie", async () => {
  const system = await fakeSystem();
  system.answer.headers = {
    "content-type": "text/plain",
    "set-cookie": [
      "MYSAPSSO2=renewed-ticket; path=/; domain=.example.com",
      "SAP_SESSIONID_X_100=s-2; path=/",
      "sap-usercontext=sap-client=100; path=/",
    ],
  };
  const proxy = new SapProxy();
  const strategy = new CookieStrategy();
  strategy.cookies = { SAP_SESSIONID_X_100: "s-1" }; // MYSAPSSO2 not among them: still stripped
  try {
    await proxy.start(system.origin, strategy);
    const answer = await get(`${proxy.origin}/page`);
    const planted = (answer.headers["set-cookie"] ?? []).join("\n");
    assert.doesNotMatch(planted, /MYSAPSSO2|renewed-ticket|SAP_SESSIONID|s-2/);
    assert.match(planted, /sap-usercontext=/);
    const head = await upgradeHead(proxy.origin, "/ws");
    assert.doesNotMatch(head, /MYSAPSSO2|ticket-from-upgrade/);
    assert.match(head, /set-cookie: other=1/i);
    assert.deepEqual(strategy.taken, [
      ["MYSAPSSO2", "renewed-ticket"],
      ["SAP_SESSIONID_X_100", "s-2"],
      ["MYSAPSSO2", "ticket-from-upgrade"],
    ]);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("basic auth hands the system's cookies on untouched - MYSAPSSO2 included", async () => {
  const system = await fakeSystem();
  system.answer.headers = { "set-cookie": ["MYSAPSSO2=t; path=/"] };
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await get(`${proxy.origin}/page`, { cookie: "a=1" });
    assert.match((answer.headers["set-cookie"] ?? []).join(), /MYSAPSSO2=t/);
    assert.equal(system.seen[0].cookie, "a=1");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("an 'expired' 401 stops forwarding with the strategy's own text, no lockout wording; start( ) clears it", async () => {
  const system = await fakeSystem();
  system.answer = { status: 401, headers: {}, body: "no" };
  const proxy = new SapProxy();
  const reported: ProxyResponse[] = [];
  proxy.onResponse = (r) => reported.push(r);
  const strategy = new CookieStrategy();
  try {
    await proxy.start(system.origin, strategy);
    assert.equal((await get(`${proxy.origin}/one`)).status, 401);
    const local = await get(`${proxy.origin}/two`);
    assert.equal(local.status, 401);
    assert.equal(local.body, strategy.texts.expired.page);
    assert.doesNotMatch(local.body, /lock/i);
    await assert.rejects(proxy.fetchFromSystem("/three"), /test: expired/);
    assert.deepEqual(system.seen.map((s) => s.path), ["/one"]);
    assert.equal(reported[0].expired, true);

    system.answer = { status: 200, headers: {}, body: "ok" };
    await proxy.start(system.origin, strategy);
    assert.equal((await get(`${proxy.origin}/four`)).status, 200);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("classifyAnswer: a redirect to the IdP is an expiry, answered locally - the iframe is not sent off", async () => {
  const system = await fakeSystem();
  system.answer = {
    status: 302,
    headers: { location: "https://idp.example.com/saml2/sso?x=1" },
    body: "",
  };
  const proxy = new SapProxy();
  const strategy = new CookieStrategy();
  const asked: Array<{ status: number; location?: string; expectsData: boolean }> = [];
  strategy.classify = (answer) => {
    asked.push({ status: answer.status, location: answer.location, expectsData: answer.expectsData });
    return answer.status === 302 && /idp\./.test(answer.location ?? "") ? "expired" : "ok";
  };
  const reported: ProxyResponse[] = [];
  proxy.onResponse = (r) => reported.push(r);
  try {
    await proxy.start(system.origin, strategy);
    const first = await get(`${proxy.origin}/page`, { accept: "text/html" });
    assert.equal(first.status, 401);
    assert.equal(first.headers.location, undefined);
    assert.equal(first.body, strategy.texts.expired.page);
    assert.deepEqual(asked[0], {
      status: 302,
      location: "https://idp.example.com/saml2/sso?x=1",
      expectsData: false,
    });
    assert.ok(reported.some((r) => r.expired && r.status === 302));
    // the breaker holds: nothing more reaches the system
    await get(`${proxy.origin}/again`);
    assert.equal(system.seen.length, 1);

    // a background fetch (the connection check) sees the raw answer and trips nothing
    await proxy.start(system.origin, strategy);
    const raw = await proxy.fetchFromSystem("/probe", "text/html", { background: true });
    assert.equal(raw.status, 302);
    // a routine fetch is refused with the expired text, and the breaker trips
    await assert.rejects(proxy.fetchFromSystem("/adt"), /test: expired/);
    assert.equal(asked.at(-1)?.expectsData, true);
    assert.equal((await get(`${proxy.origin}/x`)).body, strategy.texts.expired.page);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a prepare( ) that needs the user is an expiry with its own message; another failure is a 502", async () => {
  const system = await fakeSystem();
  const proxy = new SapProxy();
  const strategy = new CookieStrategy();
  strategy.failPrepare = new InteractiveLogonRequired("log on again, please");
  const reported: ProxyResponse[] = [];
  proxy.onResponse = (r) => reported.push(r);
  try {
    await proxy.start(system.origin, strategy);
    const local = await get(`${proxy.origin}/page`);
    assert.equal(local.status, 401);
    assert.equal(local.body, strategy.texts.expired.page);
    assert.deepEqual(reported[0], {
      status: 401,
      path: "/page",
      expired: true,
      reason: "log on again, please",
    });
    await assert.rejects(proxy.fetchFromSystem("/adt"), /test: expired/);

    const other = new CookieStrategy();
    other.failPrepare = new Error("token endpoint down");
    await proxy.start(system.origin, other);
    const failed = await get(`${proxy.origin}/page`);
    assert.equal(failed.status, 502);
    assert.match(failed.body, /token endpoint down/);
    await assert.rejects(proxy.fetchFromSystem("/adt"), /token endpoint down/);
    assert.equal(system.seen.length, 0, "nothing reached the system without a prepared logon");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a strategy without texts gets basic auth's wording; basic's texts are the old sentences, verbatim", async () => {
  assert.equal(
    BASIC_TEXTS.rejected.page,
    "abap2UI5: the system rejected the stored user or password. The extension stopped " +
      "repeating the request so the account does not get locked. Enter the credentials again to retry."
  );
  assert.equal(BASIC_TEXTS.rejected.error, "the system rejected the stored credentials");
  assert.equal(new BasicAuthStrategy("u", "p").texts, BASIC_TEXTS);
  assert.doesNotMatch(CERTIFICATE_TEXTS.rejected.page + CERTIFICATE_TEXTS.expired.page, /password|lock/i);
  // the getter keeps the strategy's JSON what it was
  assert.equal(JSON.stringify(new BasicAuthStrategy("u", "p")), '{"kind":"basic"}');
});

test("the certificate strategy sends no header and keeps its key out of JSON and inspect", () => {
  const strategy = new CertificateAuthStrategy({
    cert: "CERT-PEM-TEXT",
    key: "PRIVATE-KEY-TEXT",
    passphrase: "secret-phrase",
  });
  assert.equal(strategy.kind, "certificate");
  assert.deepEqual(strategy.requestHeaders(), {});
  assert.equal(strategy.onUnauthorized({}), "rejected");
  assert.deepEqual(strategy.tlsOptions(), {
    cert: "CERT-PEM-TEXT",
    key: "PRIVATE-KEY-TEXT",
    passphrase: "secret-phrase",
  });
  const printed = [JSON.stringify(strategy), inspect(strategy, { showHidden: true, depth: 10 })].join();
  for (const secret of ["PRIVATE-KEY-TEXT", "secret-phrase", "CERT-PEM-TEXT"]) {
    assert.ok(!printed.includes(secret), secret);
  }
  const pfx = new CertificateAuthStrategy({ pfx: Buffer.from("bytes"), passphrase: "p" });
  assert.deepEqual(Object.keys(pfx.tlsOptions()).sort(), ["passphrase", "pfx"]);
});

test("strategyFor: the profile's auth picks the case, a missing auth is basic, a cancel is undefined", async () => {
  const asked: string[] = [];
  const deps = {
    basicCredentials: async (origin: string) => {
      asked.push(`basic ${origin}`);
      return { user: "u", pass: "p" };
    },
    clientCertificate: async (origin: string) => {
      asked.push(`cert ${origin}`);
      return { cert: "c", key: "k" };
    },
    oauthLogon: async (origin: string) => {
      asked.push(`oauth ${origin}`);
      return {
        key: { systemUrl: origin, uaaUrl: "https://uaa", clientId: "c", clientSecret: "s" },
        refreshToken: "r",
        post: async () => ({ status: 500, body: "" }),
      };
    },
    browserSession: async (origin: string) => {
      asked.push(`browser ${origin}`);
      return new BrowserSession({ SAP_SESSIONID_X_100: "s" });
    },
  };
  const basic = await strategyFor({}, "https://a", deps);
  assert.ok(basic instanceof BasicAuthStrategy);
  assert.deepEqual(basic?.requestHeaders(), { authorization: "Basic dTpw" });
  assert.ok((await strategyFor({ auth: "basic" }, "https://a", deps)) instanceof BasicAuthStrategy);
  const cert = await strategyFor({ auth: "certificate" }, "https://b", deps);
  assert.ok(cert instanceof CertificateAuthStrategy);
  assert.deepEqual(asked, ["basic https://a", "basic https://a", "cert https://b"]);

  const cancelled = {
    basicCredentials: async () => undefined,
    clientCertificate: async () => undefined,
    oauthLogon: async () => undefined,
    browserSession: async () => undefined,
  };
  assert.equal(await strategyFor({}, "https://a", cancelled), undefined);
  assert.equal(await strategyFor({ auth: "certificate" }, "https://a", cancelled), undefined);
  assert.equal(await strategyFor({ auth: "oauth" }, "https://a", cancelled), undefined);
  // every kind a profile may name has a case
  for (const kind of AUTH_KINDS) {
    assert.ok(await strategyFor({ auth: kind }, "https://a", deps), kind);
  }
  assert.equal(authKindOf({}), "basic");
  // a flow without a UI is refused, naming the two places that ask
  await assert.rejects(
    strategyFor({ auth: "certificate" }, "https://a", {
      ...deps,
      clientCertificate: async () => {
        throw certificateNeeded("a:443");
      },
    }),
    (err: unknown) =>
      err instanceof InteractiveLogonRequired && /F9/.test(err.message) && /Choose Client Certificate/.test(err.message)
  );
});

test("secret keys per origin: basic's shape unchanged, one key per further mechanism", () => {
  assert.deepEqual(secretKeysFor("https://h:1"), {
    user: "abap2ui5.user:https://h:1",
    pass: "abap2ui5.pass:https://h:1",
    cert: "abap2ui5.cert:https://h:1",
    session: "abap2ui5.session:https://h:1",
    oauth: "abap2ui5.oauth:https://h:1",
  });
});

test("auth: \"certificate\" is accepted; tightenAuth keeps a shadowed mechanism on its origin", () => {
  assert.deepEqual(profileFieldsOf({ auth: "Certificate" }), { auth: "certificate" });
  const user = [
    { template: "https://cert.example.com:44300/sap/bc/z2ui5?app_start={class}", auth: "certificate" as const },
    { template: "https://plain.example.com/x?{class}", auth: "basic" as const },
  ];
  const workspace = [
    // the same host, another client, no auth - would prompt for a password
    { template: "https://cert.example.com:44300/sap/bc/z2ui5?app_start={class}&sap-client=200" },
    { template: "https://cert.example.com:44300/other?{class}", auth: "basic" as const },
    { template: "https://plain.example.com/x?{class}", auth: "certificate" as const },
    { template: "https://new.example.com/x?{class}" },
  ];
  const tightened = tightenAuth(workspace, user);
  assert.deepEqual(
    tightened.map((p) => p.auth),
    ["certificate", "certificate", "certificate", undefined]
  );
  // nothing shadowed, nothing changed - and a copy, not the input
  const same = tightenAuth(workspace, []);
  assert.deepEqual(same, workspace);
  assert.notEqual(same, workspace);
});

test("T06d: a certificate profile is never sent to openMode external; a basic one learns the auth field", () => {
  const noBasic = classifyStatus({ status: 401, path: "/x" });
  assert.match(noBasic.fix ?? "", /"auth": "certificate"/);
  const certificate401 = classifyStatus({ status: 401, path: "/x", auth: "certificate" });
  assert.doesNotMatch(`${certificate401.detail} ${certificate401.fix}`, /openMode|external|password/);
  assert.match(certificate401.fix ?? "", /CERTRULE|USREXTID/);
  const certificate302 = classifyStatus({ status: 302, path: "/x", auth: "certificate" });
  assert.doesNotMatch(certificate302.fix ?? "", /openMode/);
  assert.match(classifyStatus({ status: 302, path: "/x" }).fix ?? "", /"auth": "certificate"/);
  assert.doesNotMatch(classifyBody('<form id="logonForm">', "certificate").fix ?? "", /password/);

  const required = describeConnectFailure({
    code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
    message: "tlsv13 alert certificate required",
  });
  assert.equal(required.label, "Client certificate");
  assert.match(required.fix ?? "", /"auth": "certificate"/);
  const refused = describeConnectFailure({
    code: "ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE",
    auth: "certificate",
  });
  assert.match(refused.detail, /refused the client certificate/);
  assert.doesNotMatch(refused.fix ?? "", /openMode/);

  const certOffer = relogonOffer("certificate", 401, "", false, false);
  assert.equal(certOffer.button, "Choose Client Certificate");
  assert.doesNotMatch(certOffer.message, /openMode|password/);
  const basicNoOffer = relogonOffer("basic", 401, ": locked", false, false);
  assert.equal(basicNoOffer.button, "Re-enter Credentials");
  assert.match(basicNoOffer.message, /: locked\./);
  assert.match(basicNoOffer.message, /"auth": "certificate"/);
  assert.doesNotMatch(relogonOffer("basic", 401, "", false, true).message, /openMode/);
  const expired = relogonOffer("anything", 401, "", true, false);
  assert.equal(expired.button, "Log On Again");
  assert.doesNotMatch(expired.message, /openMode|password/);
});

test("every flow that starts the proxy gets its logon from the factory, never a bare password", () => {
  // Push and Activate once started the proxy with ensureCredentials' user
  // and password while F9 already went through the factory - on a
  // certificate system it would have sent basic auth. Only the factory's
  // own plumbing may ask for a password.
  const src = path.join(__dirname, "..", "src");
  const callers = fs
    .readdirSync(src)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => /\bensureCredentials\(/.test(fs.readFileSync(path.join(src, f), "utf8")));
  assert.deepEqual(callers.sort(), ["logonprompt.ts", "systems.ts"]);
  for (const f of fs.readdirSync(src).filter((x) => x.endsWith(".ts") && x !== "proxy.ts")) {
    const text = fs.readFileSync(path.join(src, f), "utf8");
    assert.doesNotMatch(text, /proxy\.start\([^)]*\.user\b/, `${f} starts the proxy with a bare user`);
  }
});
