import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import { AddressInfo } from "net";
import {
  allowFraming,
  decodeBody,
  describeRejection,
  injectRuntimeHook,
  SapProxy,
  withUtf8Charset,
} from "../proxy";

test("the hook lands right after <head>, before the UI5 bootstrap", () => {
  const html =
    `<!DOCTYPE html><html><head><script src="sap-ui-core.js"></script></head><body></body></html>`;
  const out = injectRuntimeHook(html);
  const hook = out.indexOf("__abap2ui5Runtime");
  assert.ok(hook > 0, "the hook is planted");
  assert.ok(hook < out.indexOf("sap-ui-core.js"), "and before the bootstrap");
  assert.ok(out.indexOf("<head>") < hook);
});

test("without a <head> the hook goes after <html>", () => {
  const out = injectRuntimeHook(`<html lang="en"><body>x</body></html>`);
  assert.ok(out.indexOf(`<html lang="en">`) < out.indexOf("__abap2ui5Runtime"));
  assert.ok(out.indexOf("__abap2ui5Runtime") < out.indexOf("<body>"));
});

test("a fragment that is still markup gets the hook in front", () => {
  const out = injectRuntimeHook(`<!doctype html><p>error page</p>`);
  assert.ok(out.startsWith("<script>"));
});

test("something that is not HTML at all stays untouched", () => {
  const body = `{"not": "html"}`;
  assert.equal(injectRuntimeHook(body), body);
});

test("the hook is injected once", () => {
  const out = injectRuntimeHook(`<html><head></head></html>`);
  assert.equal(out.split("abap2ui5-runtime-hook").length - 1, 1);
});

// ---------------------------------------------------------------------------
// TLS verification - the abap2ui5.allowUnauthorizedCerts plumbing
// ---------------------------------------------------------------------------

/* A self-signed certificate for 127.0.0.1/localhost (valid until 2126),
 * playing the SAP dev system the setting exists for: not signed by any CA
 * the trust store knows. */
const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC9prmhH0BqKfRF
8tVrGj+T8hmIiR0+tOLDAK7P1H066P5vJ11c+3IH6jJQdjHiafdHgWNH1d8fEg1s
XrZrzRoxd419EU9knB0BNHZUyxhzNwyctxeCOGpwNUg3HYvBqDQqE5VvF9mNw1fm
7cAlRS8qtOCT8b39TXncKJG4IcSMp2F3NGN0ZDkk9wJGXvvbUl7zyXEnp7ueNvxx
bHgYilCFnOTGHYN4B+Oz8wcPMyzvtQc9pY1IpIEEsrLNJRe5N6/cL5qSPv4Wsamn
DvgO0NruTIwk+5vCEsH4wlXF+FF6aRl7RplJTYJmPXUbToBS9SAtPOEwQCYMGOwK
c/NCNR2dAgMBAAECggEAAPq0K9qSitR3dt1WOvTE/hwqg8EPgK7O7/UC3L8LEYDk
AB9wKjuAfygiBTaDCJla+0h2AogzxtWL8l1lLEEqy4rDlTEqcN7PKzMskZYF5OG/
I9ex3EyIciwNmNPt0DzF3i9r3rRnvXAUNgn6wMaEGUCbW0WM4Vq4ex7416j8T+yd
ZO7Oe/2aB08IVHs3l5hxqTxA2VgYkkIGbWgyLuNgJskoXeKB/fQF84ZCHWs8eizD
1+vnWbkieOC/YEcdRNHB7kT/h5RSJiRpq+h9qXr0+MCK9WGc5BY0HHophlz0h9O/
jNrvKQd756JEHLG3o4CaRF7E6Vs60rk5adaU4PV+sQKBgQDtlZO4d2LnWFQM9bvW
eYfFJOh3P3Gu8mV9UXgXgDrh3tl0BlCU+aWvC3XraPXnM+l/aTWvCuFfR3IXuvgZ
ZACvOCWjMMuBXc6i83Zl4LzpKs6q3sOPptP62SOQUV8zBHYyESpCjCnsLL8S+k+a
2v/qbBw98DZDWa4akJ/NmzAlbQKBgQDMWgFuj8HTOPQsVlaPvm5OqAx42zQoxVbP
LBc7hw5oyvdE15kUuYCZe+NQd8Qwzxc55icq/Ujw8BWcP+LTI3UYcuwsx18kXrHe
7vtMq4+ZejrWLIIZ0u5xYVoOwBILZgqSvQSwB3qBBHmYb2sydjMJRQo8JmarMfi9
om3sYfYq8QKBgQDLQeBzPJA84/BkdgcRYj+phf3rpzeXOIFjSUO4t1eozYK0JILk
MQByVRe5Ir7d4ietfVEUQ/a0EOenLan77vY28Y4hoyk3sA2Mk0WDu1VjFeBhhttA
FrXcMdCfMz6C4xpLkyvYaxmimFWP4t4f2aR/5aXzx4Jk9GBjEb/loxL5sQKBgF9z
mz+dfpe+/q7HFV/HP5cV/91j5pU0uDvFCIURrLVeOOm7GxIHI/6NU7x+dPGnid3N
l3YJIU0Jl86IONcOtN9art6rsdE3OjY7wr4pVMYHxfvMhmixkhb7tik1pjgUzdOE
3u+qTpp9EJ8XTCch9uzZhtJZzZMhoGJTwKythWLBAoGBANcniS3WWv0vemQcZHq0
YbHgM/XyqSyXNWcSWxnrYcTK0uQXrs70yWyy379ilUcVJQaVWudNjyXdNFAKM3TP
FzspidWDhN3PJaannyhSHu2a+yd7PFRA1RWJDSfid2nPB7L4Wwb314xTnBJS+mPR
HqlzWQi+DeMDJZvRM8VRlbqy
-----END PRIVATE KEY-----`;

const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUVAuW4RycwmgqI0pKttlTP7GhATwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgxMDIxMjEzOFoYDzIxMjYw
NzE3MjEyMTM4WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQC9prmhH0BqKfRF8tVrGj+T8hmIiR0+tOLDAK7P1H06
6P5vJ11c+3IH6jJQdjHiafdHgWNH1d8fEg1sXrZrzRoxd419EU9knB0BNHZUyxhz
NwyctxeCOGpwNUg3HYvBqDQqE5VvF9mNw1fm7cAlRS8qtOCT8b39TXncKJG4IcSM
p2F3NGN0ZDkk9wJGXvvbUl7zyXEnp7ueNvxxbHgYilCFnOTGHYN4B+Oz8wcPMyzv
tQc9pY1IpIEEsrLNJRe5N6/cL5qSPv4WsamnDvgO0NruTIwk+5vCEsH4wlXF+FF6
aRl7RplJTYJmPXUbToBS9SAtPOEwQCYMGOwKc/NCNR2dAgMBAAGjbzBtMB0GA1Ud
DgQWBBT1aWaIrjdeq0jWFZueDyqG6veZHzAfBgNVHSMEGDAWgBT1aWaIrjdeq0jW
FZueDyqG6veZHzAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAq4WpiuaT00TjI3B6gsjX2sQFpU/d
LcrD2qlC+vF83WOGAGl7h5zgYl9gK8PmgDLIYgfZYMKSTBdE0ow/jveQLwdtDPBw
VSBPaLwbpVi7FrL40UG8dDCAWvMnYwWtcybx+W0fuZjPK/FEDot3SWDJbTyFSJAE
9bsLpl6K95pZOKf193k40wStxui/03R4NIKPVqVK8I6OnQ7N+omHIhEiY03OK80C
fYkHKjGur5RcsR7CxUccfV14xsT3wp3vYLmv/Hpz2Vo+y4GLK1C3pwsnjwWL9eBD
mnIc4E8lsievg68XwxDMIhbFuYLcbFC6+A1DYx0xLqtqYcXTATIYN6yXew==
-----END CERTIFICATE-----`;

/** An https "SAP system" answering 200 to everything. */
function selfSignedSystem(): Promise<{ origin: string; close: () => void }> {
  const server = https.createServer(
    { key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("system answer");
    }
  );
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `https://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

/** One GET through the started proxy. */
function throughProxy(
  proxy: SapProxy,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`${proxy.origin}${path}`, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

test("by default the proxy accepts a self-signed system certificate", async () => {
  const system = await selfSignedSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const direct = await proxy.fetchFromSystem("/sap/bc/adt/probe");
    assert.equal(direct.status, 200);
    const proxied = await throughProxy(proxy, "/sap/bc/z2ui5");
    assert.equal(proxied.status, 200);
    assert.equal(proxied.body, "system answer");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("with allowUnauthorized off the self-signed system is refused", async () => {
  const system = await selfSignedSystem();
  const proxy = new SapProxy();
  proxy.allowUnauthorized = false;
  try {
    await proxy.start(system.origin, "user", "pass");
    // the direct fetch rejects with the TLS error...
    await assert.rejects(
      proxy.fetchFromSystem("/sap/bc/adt/probe"),
      (err: Error) => /self[- ]signed|certificate/i.test(err.message)
    );
    // ...and a forwarded request turns into the proxy's 502
    const proxied = await throughProxy(proxy, "/sap/bc/z2ui5");
    assert.equal(proxied.status, 502);
    assert.match(proxied.body, /abap2UI5 proxy error/);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("flipping allowUnauthorized applies to the next request", async () => {
  // the setting listener mutates the running proxy - no restart involved
  const system = await selfSignedSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    proxy.allowUnauthorized = false;
    await assert.rejects(proxy.fetchFromSystem("/probe"));
    proxy.allowUnauthorized = true;
    const ok = await proxy.fetchFromSystem("/probe");
    assert.equal(ok.status, 200);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("ADT search answers reduce to unique class names", () => {
  const { parseAdtClassRefs } = require("../proxy") as typeof import("../proxy");
  const xml = `<?xml version="1.0"?><adtcore:objectReferences xmlns:adtcore="x">
    <adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_APP_ONE" adtcore:description="d"/>
    <adtcore:objectReference adtcore:name="ZCL_APP_TWO" adtcore:type="CLAS/OC"/>
    <adtcore:objectReference adtcore:type="PROG/P" adtcore:name="ZREPORT"/>
    <adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_APP_ONE"/>
  </adtcore:objectReferences>`;
  assert.deepEqual(
    parseAdtClassRefs(xml).map((ref) => ref.name),
    ["ZCL_APP_ONE", "ZCL_APP_TWO"]
  );
});

test("only a loopback Host passes the shared listener gate", () => {
  const { isLoopbackHost } = require("../proxy") as typeof import("../proxy");
  // the names a browser can legitimately have connected through
  assert.ok(isLoopbackHost("127.0.0.1"));
  assert.ok(isLoopbackHost("127.0.0.1:8080"));
  assert.ok(isLoopbackHost("[::1]"));
  assert.ok(isLoopbackHost("[::1]:8080"));
  assert.ok(isLoopbackHost("localhost"));
  assert.ok(isLoopbackHost("LOCALHOST:3000"));
  // anything else is a name that resolves here without being ours - the
  // DNS-rebinding shape the gate exists to refuse
  assert.ok(!isLoopbackHost("evil.example"));
  assert.ok(!isLoopbackHost("127.0.0.1.evil.example"));
  assert.ok(!isLoopbackHost("localhost.evil.example"));
  assert.ok(!isLoopbackHost("127.0.0.2"));
  assert.ok(!isLoopbackHost(""));
  assert.ok(!isLoopbackHost(undefined));
});

test("ADT search answers keep the short text and the package", () => {
  const { parseAdtClassRefs } = require("../proxy") as typeof import("../proxy");
  const xml =
    `<adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_A" ` +
    `adtcore:description="My app" adtcore:packageName="ZPKG"/>` +
    `<adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_B"/>`;
  const refs = parseAdtClassRefs(xml);
  assert.equal(refs[0].name, "ZCL_A");
  assert.equal(refs[0].description, "My app");
  assert.equal(refs[0].packageName, "ZPKG");
  assert.equal(refs[1].name, "ZCL_B");
  assert.equal(refs[1].description, undefined);
  assert.equal(refs[1].packageName, undefined);
});

// ---------------------------------------------------------------------------
// Who may use the proxy - the token, the Host check and the cookie
// ---------------------------------------------------------------------------

/** A plain http "SAP system" that keeps what it was asked for. */
function recordingSystem(): Promise<{
  origin: string;
  seen: { path: string; cookie?: string }[];
  close: () => void;
}> {
  const seen: { path: string; cookie?: string }[] = [];
  const server = http.createServer((req, res) => {
    seen.push({ path: String(req.url), cookie: req.headers.cookie });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("system answer");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => server.close(),
      });
    });
  });
}

/** One GET straight at the proxy's port, so the url and the headers are the
 *  test's to choose - what an attacker has and `throughProxy` does not. */
function rawGet(
  proxy: SapProxy,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; setCookie: string[] }> {
  const port = new URL(proxy.origin).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            setCookie: res.headers["set-cookie"] ?? [],
          })
        );
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/** The `/__abap2ui5/<token>` part of what the proxy hands out. */
const tokenPath = (proxy: SapProxy) => new URL(proxy.origin).pathname;

test("a request without the token never reaches the system", async () => {
  // the port is random but scannable, and every forwarded request carries the
  // system credentials - so this is the difference between a local port and
  // an authenticated session against the SAP system
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await rawGet(proxy, "/sap/bc/z2ui5");
    assert.equal(answer.status, 404);
    assert.deepEqual(system.seen, [], "nothing was forwarded");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a guessed token is refused as well", async () => {
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await rawGet(proxy, "/__abap2ui5/not-the-token/sap/bc/z2ui5");
    assert.equal(answer.status, 404);
    assert.deepEqual(system.seen, []);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("with the token the system is reached, and sees its own path", async () => {
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await throughProxy(proxy, "/sap/bc/z2ui5?app_start=zcl_x");
    assert.equal(answer.status, 200);
    assert.equal(answer.body, "system answer");
    // the token is the proxy's own business - the system is asked for the
    // path it actually serves
    assert.equal(system.seen[0].path, "/sap/bc/z2ui5?app_start=zcl_x");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a foreign Host is refused - the shape of DNS rebinding", async () => {
  // a page on evil.example.com whose name resolves to 127.0.0.1 reaches this
  // port, but it reaches it under its own name
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await rawGet(proxy, `${tokenPath(proxy)}/sap/bc/z2ui5`, {
      host: "evil.example.com",
    });
    assert.equal(answer.status, 404);
    assert.deepEqual(system.seen, []);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("the first answer plants the cookie an absolute path needs", async () => {
  // an app configured with an absolute bootstrap asks for /sap/public/... from
  // the server root, where no prefix of ours can travel with it
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const entry = await rawGet(proxy, `${tokenPath(proxy)}/sap/bc/z2ui5`);
    assert.equal(entry.status, 200);
    const planted = entry.setCookie.find((c) =>
      c.startsWith("__abap2ui5_proxy_")
    );
    assert.ok(planted, "the answer carries the cookie");
    assert.ok(
      planted!.startsWith(`__abap2ui5_proxy_${new URL(proxy.origin).port}=`),
      "named after the port - cookies are host-scoped, two windows are not"
    );
    assert.match(planted!, /HttpOnly/, "the page cannot read it back out");
    // in the preview the page sits in an iframe whose top-level document is
    // the vscode-webview:// origin - every request it makes is cross-site
    // there, and a Lax cookie stays home. None+Secure is what travels, and
    // loopback is trustworthy enough for Chromium to take Secure over http.
    assert.match(planted!, /SameSite=None/, "travels from the framed page");
    assert.match(planted!, /Secure/, "which None requires");

    const cookie = planted!.split(";")[0];
    const absolute = await rawGet(proxy, "/sap/public/bc/ui5_ui5/x.js", {
      cookie,
    });
    assert.equal(absolute.status, 200);
    assert.equal(system.seen[1].path, "/sap/public/bc/ui5_ui5/x.js");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("the proxy's own cookie stops at the proxy", async () => {
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const token = tokenPath(proxy).split("/")[2];
    const port = new URL(proxy.origin).port;
    await rawGet(proxy, `${tokenPath(proxy)}/sap/bc/z2ui5`, {
      // its own cookie, another window's port-scoped one, and a pre-0.24
      // unscoped leftover - none of them is the system's business
      cookie:
        `sap-usercontext=x; __abap2ui5_proxy_${port}=${token}; ` +
        `__abap2ui5_proxy_9999=other; __abap2ui5_proxy=stale`,
    });
    assert.equal(system.seen[0].cookie, "sap-usercontext=x");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("the cookie is port-scoped, so two proxies do not fight over it", async () => {
  // two windows, two systems at once is a supported setup - and cookies are
  // host-scoped, so one shared name meant the second proxy's cookie
  // overwrote the first's and broke its absolute-path requests
  const one = await recordingSystem();
  const two = await recordingSystem();
  const a = new SapProxy();
  const b = new SapProxy();
  try {
    await a.start(one.origin, "user", "pass");
    await b.start(two.origin, "user", "pass");
    const cookieOf = async (proxy: SapProxy) =>
      (await rawGet(proxy, `${tokenPath(proxy)}/entry`)).setCookie
        .find((c) => c.startsWith("__abap2ui5_proxy_"))!
        .split(";")[0];
    const cookieA = await cookieOf(a);
    const cookieB = await cookieOf(b);
    assert.notEqual(cookieA.split("=")[0], cookieB.split("=")[0]);
    // the browser sends BOTH to either port - each proxy takes its own
    const jar = `${cookieA}; ${cookieB}`;
    assert.equal((await rawGet(a, "/abs.js", { cookie: jar })).status, 200);
    assert.equal((await rawGet(b, "/abs.js", { cookie: jar })).status, 200);
    // the other proxy's cookie alone authorizes nothing
    assert.equal((await rawGet(a, "/abs.js", { cookie: cookieB })).status, 404);
  } finally {
    await a.stop();
    await b.stop();
    one.close();
    two.close();
  }
});

test("the gate fails closed while the proxy holds no token", async () => {
  // during stop( )'s close window the token is already cleared, and the
  // cookie comparison used to authorize a cookie-less request with
  // `undefined === undefined` - straight into the cleared state
  const system = await recordingSystem();
  const proxy = new SapProxy();
  const gate = proxy as unknown as {
    route(req: {
      headers: Record<string, string | undefined>;
      url?: string;
    }): string | undefined;
  };
  const cookieless = { headers: { host: "127.0.0.1" }, url: "/sap/bc/z2ui5" };
  try {
    assert.equal(gate.route(cookieless), undefined, "never started");
    await proxy.start(system.origin, "user", "pass");
    assert.equal(gate.route(cookieless), undefined, "running, but no token");
    await proxy.stop();
    assert.equal(gate.route(cookieless), undefined, "stopped");
    assert.equal(
      gate.route({
        headers: { host: "127.0.0.1" },
        url: "/__abap2ui5/undefined/sap/bc/z2ui5",
      }),
      undefined,
      "the cleared token is not addressable by its spelling"
    );
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("stopping takes the credentials with it", async () => {
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    assert.equal(proxy.isRunning, true);
    await proxy.stop();
    assert.equal(proxy.isRunning, false, "no credentials left behind");
  } finally {
    system.close();
  }
});

test("re-entering the same system keeps the proxy usable", async () => {
  // regression: the credentials are handed in before stop( ) runs, and stop( )
  // is what clears them - assigning in that order left a started proxy with
  // no authorization at all
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const first = proxy.origin;
    await proxy.start(system.origin, "user", "changed");
    assert.equal(proxy.origin, first, "same server, same token");
    assert.equal((await throughProxy(proxy, "/probe")).status, 200);
  } finally {
    await proxy.stop();
    system.close();
  }
});

/*
 * The one-shot token behind the screenshot: headless Chromium takes the page
 * only as a command-line argument, and an argument vector is readable by
 * every other process of this user - so what leaks there must be spent by
 * the time anyone reads it.
 */
test("a one-shot url authorizes exactly one request", async () => {
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const url = proxy.singleUseUrl(`${proxy.origin}/sap/bc/z2ui5?app_start=zcl_x`);
    assert.notEqual(url, `${proxy.origin}/sap/bc/z2ui5?app_start=zcl_x`);
    const path = new URL(url).pathname + new URL(url).search;

    const first = await rawGet(proxy, path);
    assert.equal(first.status, 200, "the shot's own request was refused");
    assert.equal(system.seen.length, 1);
    // and the answer plants the cookie the page's follow-ups ride on
    assert.ok(
      first.setCookie.some((c) => c.startsWith("__abap2ui5_proxy_")),
      "no cookie planted - the page could not load its resources"
    );

    const second = await rawGet(proxy, path);
    assert.equal(second.status, 404, "the one-shot token outlived its request");
    assert.equal(system.seen.length, 1, "a second request was forwarded");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a one-shot token is never accepted out of a cookie", async () => {
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const url = proxy.singleUseUrl(`${proxy.origin}/x`);
    const oneShot = new URL(url).pathname.split("/")[2];
    const port = new URL(proxy.origin).port;
    const answer = await rawGet(proxy, "/sap/bc/z2ui5", {
      cookie: `__abap2ui5_proxy_${port}=${oneShot}`,
    });
    assert.equal(answer.status, 404);
    assert.deepEqual(system.seen, []);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("one-shot tokens do not outlive the proxy that minted them", async () => {
  const one = await recordingSystem();
  const two = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(one.origin, "user", "pass");
    const url = proxy.singleUseUrl(`${proxy.origin}/x`);
    const path = new URL(url).pathname;
    await proxy.start(two.origin, "user", "pass");
    const answer = await rawGet(proxy, path);
    assert.equal(answer.status, 404, "a token from the old system still works");
    assert.deepEqual(two.seen, []);
  } finally {
    await proxy.stop();
    one.close();
    two.close();
  }
});

test("a url that is not this proxy's is handed back unchanged", async () => {
  const proxy = new SapProxy();
  // not running: nothing to mint against
  assert.equal(proxy.singleUseUrl("https://host:44300/x"), "https://host:44300/x");
  const system = await recordingSystem();
  try {
    await proxy.start(system.origin, "user", "pass");
    assert.equal(
      proxy.singleUseUrl("https://host:44300/x"),
      "https://host:44300/x"
    );
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a different system gets a different token", async () => {
  const one = await recordingSystem();
  const two = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(one.origin, "user", "pass");
    const before = tokenPath(proxy);
    await proxy.start(two.origin, "user", "pass");
    assert.notEqual(tokenPath(proxy), before, "the old url is dead");
  } finally {
    await proxy.stop();
    one.close();
    two.close();
  }
});

// ---------------------------------------------------------------------------
// Stream lifecycle: what the system does to the extension host
// ---------------------------------------------------------------------------

test("a system that dies mid-body does not take the host down", async () => {
  // regression: the pass-through path piped without an error listener on the
  // response stream, and pipe( ) does not forward a source error - so an ICM
  // resetting the socket mid-answer raised an unhandled "error" event
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "application/javascript",
      "transfer-encoding": "chunked",
    });
    res.write("sap.ui.define(");
    // the connection dies with the body half sent - a chunked answer cut
    // short is what raises the error on the RESPONSE stream
    setTimeout(() => res.socket?.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const proxy = new SapProxy();
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("uncaughtException", onUnhandled);
  try {
    await proxy.start(`http://127.0.0.1:${port}`, "user", "pass");
    // a client that watches both streams, so the only unhandled error left
    // in the process can be the proxy's own
    const settled = await Promise.race([
      new Promise<string>((resolve) => {
        const req = http.get(`${proxy.origin}/resources/x.js`, (res) => {
          res.on("data", () => undefined);
          res.on("error", () => resolve("settled"));
          res.on("end", () => resolve("settled"));
          res.on("close", () => resolve("settled"));
        });
        req.on("error", () => resolve("settled"));
      }),
      new Promise<string>((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, [], "the error stayed inside the proxy");
    assert.equal(settled, "settled", "the client was not left hanging");
  } finally {
    process.off("uncaughtException", onUnhandled);
    await proxy.stop();
    server.close();
  }
});

test("a client that gives up cancels the request to the system", async () => {
  // the webview cancels in-flight loads on every reload; without this the
  // system keeps working on an answer nobody is waiting for
  let aborted = false;
  const server = http.createServer((req, res) => {
    req.on("aborted", () => (aborted = true));
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("start"); // and then never finishes
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const proxy = new SapProxy();
  try {
    await proxy.start(`http://127.0.0.1:${port}`, "user", "pass");
    const proxyPort = new URL(proxy.origin).port;
    await new Promise<void>((resolve) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: proxyPort,
          path: `${tokenPath(proxy)}/slow`,
          method: "GET",
        },
        (res) => {
          res.on("data", () => req.destroy()); // give up on the first byte
          res.on("error", () => undefined);
        }
      );
      req.on("error", () => resolve());
      req.on("close", () => resolve());
      req.end();
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(aborted, true, "the forwarded request was cancelled");
  } finally {
    await proxy.stop();
    server.close();
  }
});

test("the traffic log and the status reports never carry the token", async () => {
  // both end up in output channels users paste into issues, and the token is
  // what authorizes a session against the system
  const system = await recordingSystem();
  const proxy = new SapProxy();
  const paths: string[] = [];
  proxy.onResponse = (r) => paths.push(r.path);
  proxy.onTraffic = (t) => paths.push(t.path);
  try {
    await proxy.start(system.origin, "user", "pass");
    await throughProxy(proxy, "/sap/bc/z2ui5?app_start=zcl_x");
    const token = tokenPath(proxy).split("/")[2];
    assert.ok(paths.length >= 2, "both hooks reported");
    for (const path of paths) {
      assert.ok(!path.includes(token), `no token in ${path}`);
      assert.equal(path, "/sap/bc/z2ui5?app_start=zcl_x");
    }
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a launch url without a path forwards a valid request line", async () => {
  // `https://host:44300?app_start=zcl_x` leaves the query right behind the
  // token, and `GET ?app_start=... HTTP/1.1` is not a request servers accept
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await rawGet(proxy, `${tokenPath(proxy)}?app_start=zcl_x`);
    assert.equal(answer.status, 200);
    assert.equal(system.seen[0].path, "/?app_start=zcl_x");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("the pathless frame URL keeps the token through relative resolution", async () => {
  // proxiedUrl( ) turns `https://host?app_start=X` into `<prefix>/?app_start=X`
  // - token as a DIRECTORY. Both the document and a relative resource the page
  // resolves against it have to route, and the system has to see its own
  // paths, token-free. (Resolved against the old `<prefix>?app_start=X` shape,
  // the browser dropped the token segment and nothing ever loaded - the white
  // preview of issue #60.)
  const system = await recordingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const frameUrl = `http://127.0.0.1:${new URL(proxy.origin).port}${tokenPath(
      proxy
    )}/?app_start=zcl_x`;
    const doc = await rawGet(proxy, new URL(frameUrl).pathname + new URL(frameUrl).search);
    assert.equal(doc.status, 200);
    assert.equal(system.seen[0].path, "/?app_start=zcl_x");

    // what the browser asks for next: `resources/...` relative to the document
    const resource = new URL("resources/sap-ui-core.js", frameUrl);
    const answer = await rawGet(proxy, resource.pathname + resource.search);
    assert.equal(answer.status, 200);
    assert.equal(system.seen[1].path, "/resources/sap-ui-core.js");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a SameSite=None cookie keeps the Secure it needs to survive", async () => {
  // Chromium drops SameSite=None without Secure, so stripping it lost the
  // session cookie of every system configured per SAP's cross-site notes
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "set-cookie": [
        "SAP_SESSIONID_A4H_001=abc; Path=/; Domain=sap.example.com; SameSite=None; Secure",
        "sap-usercontext=sap-client=001; Path=/; Domain=sap.example.com; Secure",
      ],
    });
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const proxy = new SapProxy();
  try {
    await proxy.start(`http://127.0.0.1:${port}`, "user", "pass");
    const answer = await rawGet(proxy, `${tokenPath(proxy)}/probe`);
    const session = answer.setCookie.find((c) => c.startsWith("SAP_SESSIONID"));
    const context = answer.setCookie.find((c) => c.startsWith("sap-usercontext"));
    assert.ok(session?.includes("Secure"), "SameSite=None keeps Secure");
    assert.ok(!session?.includes("Domain="), "the system's domain is gone");
    assert.ok(!context?.includes("Secure"), "an ordinary cookie loses Secure");
  } finally {
    await proxy.stop();
    server.close();
  }
});

test("an ISO-8859-1 page is injected without mangling its umlauts", () => {
  // an old ICM serves its logon and error pages in a single-byte charset;
  // toString("utf8") turned every umlaut on them into a replacement character
  const body = Buffer.from("<html><head></head><body>Anmeldung fehlgeschlagen: Prüfen</body></html>", "latin1");
  const text = decodeBody(body, "text/html; charset=iso-8859-1");
  assert.ok(text.includes("Prüfen"), "decoded with the declared charset");
  assert.equal(
    withUtf8Charset("text/html; charset=iso-8859-1"),
    "text/html; charset=utf-8",
    "and leaves declared as what it now is"
  );
});

test("a body without a declared charset is read as UTF-8", () => {
  const text = decodeBody(Buffer.from("<html>Prüfen</html>", "utf8"), "text/html");
  assert.ok(text.includes("Prüfen"));
  assert.equal(withUtf8Charset("text/html"), "text/html; charset=utf-8");
});

// ---------------------------------------------------------------------------
// A rejected logon: what it says, and how often it says it
// ---------------------------------------------------------------------------

test("the rejection reason comes out of the page title", () => {
  const page =
    `<!DOCTYPE html><html><head><title>Logon Error Message</title></head>` +
    `<body><h1>User is locked</h1></body></html>`;
  assert.equal(describeRejection(page), "Logon Error Message");
});

test("without a title the flattened body has to do", () => {
  const page = `<!DOCTYPE html><html><body><h1>User  is locked.</h1></body></html>`;
  assert.equal(describeRejection(page), "User is locked.");
});

test("an empty rejection body says nothing rather than an empty string", () => {
  assert.equal(describeRejection(""), undefined);
  assert.equal(describeRejection("<html><title> </title></html>"), undefined);
});

test("the rejection reason is redacted before it is logged", () => {
  const reason = describeRejection("Logon to https://sap.internal:44300 failed");
  assert.ok(reason);
  assert.ok(!reason.includes("sap.internal"), reason);
  assert.ok(reason.includes("44300"), "the port is the diagnostic part");
});

/** A system that refuses every logon, the way the ICF does: 401, a realm, and
 *  an HTML page carrying the actual sentence. */
function rejectingSystem(): Promise<{
  origin: string;
  seen: string[];
  close: () => void;
}> {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(String(req.url));
    res.writeHead(401, {
      "content-type": "text/html",
      "www-authenticate": 'Basic realm="SAP NetWeaver Application Server"',
    });
    res.end("<html><head><title>User is locked</title></head></html>");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => server.close(),
      });
    });
  });
}

test("a rejection is reported with the realm and the system's own words", async () => {
  const system = await rejectingSystem();
  const proxy = new SapProxy();
  const seen: { authenticate?: string; reason?: string }[] = [];
  proxy.onResponse = (r) => seen.push(r);
  try {
    await proxy.start(system.origin, "user", "wrong");
    const answer = await throughProxy(proxy, "/sap/bc/z2ui5");
    assert.equal(answer.status, 401);
    assert.equal(seen.length, 1, "reported once, not once per body chunk");
    assert.match(seen[0].authenticate ?? "", /^Basic realm=/);
    assert.equal(seen[0].reason, "User is locked");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("after a 401 the proxy stops asking the system again", async () => {
  // one wrong password used to become one failed logon per resource a UI5
  // page loads, which is what locks an account
  const system = await rejectingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "wrong");
    const first = await throughProxy(proxy, "/sap/bc/z2ui5");
    assert.equal(first.status, 401);
    const second = await throughProxy(proxy, "/sap/public/bc/ui5_ui5/x.js");
    assert.equal(second.status, 401, "the page still sees a 401");
    assert.match(second.body, /stopped repeating the request/);
    assert.deepEqual(system.seen, ["/sap/bc/z2ui5"], "only the first went out");
    await assert.rejects(
      proxy.fetchFromSystem("/sap/bc/adt/probe"),
      /rejected the stored credentials/,
      "and the polling lookups stop too"
    );
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("re-entered credentials let the proxy try again", async () => {
  const system = await rejectingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "wrong");
    await throughProxy(proxy, "/sap/bc/z2ui5");
    await proxy.start(system.origin, "user", "right");
    const retry = await throughProxy(proxy, "/sap/bc/z2ui5");
    assert.equal(retry.status, 401, "this system rejects everyone");
    assert.equal(system.seen.length, 2, "but the attempt was forwarded");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a rejection from the ADT lookups is reported too", async () => {
  // these run on a timer, so a logon that stopped working was silent here
  const system = await rejectingSystem();
  const proxy = new SapProxy();
  const seen: { status: number; reason?: string }[] = [];
  proxy.onResponse = (r) => seen.push(r);
  try {
    await proxy.start(system.origin, "user", "wrong");
    const answer = await proxy.fetchFromSystem("/sap/bc/adt/probe");
    assert.equal(answer.status, 401);
    assert.deepEqual(seen, [
      {
        status: 401,
        path: "/sap/bc/adt/probe",
        authenticate: 'Basic realm="SAP NetWeaver Application Server"',
        reason: "User is locked",
      },
    ]);
  } finally {
    await proxy.stop();
    system.close();
  }
});

// ---------------------------------------------------------------------------
// Frame protection: the preview has to be allowed to frame the app
// ---------------------------------------------------------------------------

test("the bootstrap leaves the proxy with frame options set to allow", () => {
  // verbatim from z2ui5_cl_ui5_http_handler
  const bootstrap =
    `<script id="sap-ui-bootstrap" src="/sap/public/bc/ui5_ui5/resources/sap-ui-core.js" ` +
    `data-sap-ui-compatVersion="edge" data-sap-ui-async="true" ` +
    `data-sap-ui-frameOptions="trusted" data-sap-ui-bindingSyntax="complex"></script>`;
  const out = allowFraming(bootstrap);
  assert.ok(!out.includes("trusted"), out);
  assert.ok(out.includes(`data-sap-ui-frameOptions="allow"`));
  // everything else about the tag survives
  assert.ok(out.includes(`data-sap-ui-bindingSyntax="complex"`));
  assert.ok(out.includes(`data-sap-ui-async="true"`));
});

test("the other spellings and quotings are rewritten too", () => {
  assert.ok(
    allowFraming(`<script data-sap-ui-frame-options='deny'></script>`).includes(
      `data-sap-ui-frame-options="allow"`
    )
  );
  assert.ok(
    allowFraming(`<script data-sap-ui-frameoptions=trusted></script>`).includes(
      `data-sap-ui-frameoptions="allow"`
    )
  );
  // an attribute that merely starts the same way is not this one
  const other = `<script data-sap-ui-frameOptionsConfig="{}"></script>`;
  assert.equal(allowFraming(other), other);
});

test("a page without the attribute is left exactly as it is", () => {
  const html = `<html><head><script src="sap-ui-core.js"></script></head></html>`;
  assert.equal(allowFraming(html), html);
});

/** A system that serves one HTML document, whatever is asked of it. */
function htmlSystem(html: string): Promise<{
  origin: string;
  close: () => void;
}> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

/** Asks the proxy the way the preview iframe does - only a document request
 *  is buffered and rewritten, a plain GET is piped through untouched. */
function throughProxyAsDocument(
  proxy: SapProxy,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(
        `${proxy.origin}${path}`,
        { headers: { "sec-fetch-dest": "document" } },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        }
      )
      .on("error", reject);
  });
}

test("an app page served through the proxy comes out framable", async () => {
  // end to end, because the rewrite only counts if it is on the path the
  // preview actually loads - and only HTML documents go through it
  const server = await htmlSystem(
    `<!DOCTYPE html><html><head>` +
      `<script id="sap-ui-bootstrap" data-sap-ui-frameOptions="trusted"></script>` +
      `</head><body></body></html>`
  );
  const proxy = new SapProxy();
  try {
    await proxy.start(server.origin, "user", "pass");
    const answer = await throughProxyAsDocument(proxy, "/sap/bc/z2ui5");
    assert.ok(answer.body.includes(`data-sap-ui-frameOptions="allow"`), answer.body);
    assert.ok(!answer.body.includes("trusted"));
    // and the runtime hook still lands, on the same body
    assert.ok(answer.body.includes("__abap2ui5Runtime"));
  } finally {
    await proxy.stop();
    server.close();
  }
});

test("a script whose end tag carries a space is still removed", () => {
  // </script > closes a script exactly as </script> does. A pattern that
  // insists on the bare form leaves the element in, the general tag strip
  // below then removes only its tags, and the script BODY is what reaches the
  // output channel - and from there a pasted bug report.
  const page =
    `<!DOCTYPE html><html><body>` +
    `<script >var sid = "SAP_SESSIONID_DEV_100";</script >` +
    `<h1>User is locked</h1></body></html>`;
  const reason = describeRejection(page);
  assert.equal(reason, "User is locked");
  assert.ok(!reason?.includes("SAP_SESSIONID"), reason);
});

test("a style whose end tag carries a space does not reach the log either", () => {
  const page =
    `<!DOCTYPE html><html><body>` +
    `<style\n>.x { color: red }</style\n>` +
    `<h1>Password must be changed</h1></body></html>`;
  assert.equal(describeRejection(page), "Password must be changed");
});

// ---------------------------------------------------------------------------
// fetchFromSystem: the cap, the abort, and the background flag
// ---------------------------------------------------------------------------

test("fetchFromSystem stops downloading a huge answer at the cap", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(Buffer.alloc(2 * 1024 * 1024, 0x61));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const proxy = new SapProxy();
  try {
    await proxy.start(`http://127.0.0.1:${port}`, "user", "pass");
    const { status, body } = await proxy.fetchFromSystem("/big");
    assert.equal(status, 200);
    assert.ok(body.length >= 256 * 1024, "the answerable part is kept");
    assert.ok(body.length < 2 * 1024 * 1024, "the rest is not downloaded");
  } finally {
    await proxy.stop();
    server.close();
  }
});

test("fetchFromSystem can be aborted by its caller", async () => {
  // the app search supersedes its own lookups while the user types
  const server = http.createServer(() => {
    // never answers
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const proxy = new SapProxy();
  try {
    await proxy.start(`http://127.0.0.1:${port}`, "user", "pass");
    const abort = new AbortController();
    const pending = proxy.fetchFromSystem("/slow", undefined, {
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 20);
    await assert.rejects(pending);
  } finally {
    await proxy.stop();
    server.close();
  }
});

test("a background probe's 401 does not trip the retry breaker", async () => {
  // the UI5-version probes run against paths (and possibly a client) the
  // user never asked for - their rejection must not break the launch whose
  // own credentials are fine, and must not raise the re-logon prompt
  const system = await rejectingSystem();
  const proxy = new SapProxy();
  const reported: number[] = [];
  proxy.onResponse = (r) => reported.push(r.status);
  try {
    await proxy.start(system.origin, "user", "pass");
    const probe = await proxy.fetchFromSystem("/version", undefined, {
      background: true,
    });
    assert.equal(probe.status, 401, "the caller still sees the rejection");
    assert.deepEqual(reported, [], "but nobody is prompted over a probe");
    const real = await throughProxy(proxy, "/sap/bc/z2ui5");
    assert.equal(real.status, 401);
    assert.deepEqual(
      system.seen,
      ["/version", "/sap/bc/z2ui5"],
      "the real request still went out - the breaker was not tripped"
    );
  } finally {
    await proxy.stop();
    system.close();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle: stopping under load
// ---------------------------------------------------------------------------

test("stopping does not wait for a request the system never answers", async () => {
  // stop( ) is what a system SWITCH awaits - held hostage by one hanging
  // forward, F9 against the new system used to stall for the full timeout
  const server = http.createServer(() => {
    // accepts and says nothing
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const proxy = new SapProxy();
  try {
    await proxy.start(`http://127.0.0.1:${port}`, "user", "pass");
    const hung = new Promise<void>((resolve) => {
      const req = http.get(`${proxy.origin}/hang`, () => resolve());
      req.on("error", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 50));
    const before = Date.now();
    await proxy.stop();
    assert.ok(Date.now() - before < 2000, "stop did not wait out the forward");
    await hung;
  } finally {
    await proxy.stop();
    server.close();
  }
});

test("a failed forward still writes a traffic entry", async () => {
  const dead = http.createServer();
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  const port = (dead.address() as AddressInfo).port;
  await new Promise<void>((r) => dead.close(() => r()));

  const proxy = new SapProxy();
  const entries: { status: number; path: string }[] = [];
  proxy.onTraffic = (t) => entries.push({ status: t.status, path: t.path });
  try {
    await proxy.start(`http://127.0.0.1:${port}`, "user", "pass");
    const answer = await throughProxy(proxy, "/x");
    assert.equal(answer.status, 502);
    assert.deepEqual(entries, [{ status: 502, path: "/x" }]);
  } finally {
    await proxy.stop();
  }
});

// ---------------------------------------------------------------------------
// WebSocket upgrades: same gate, same credentials
// ---------------------------------------------------------------------------

/** A system with one WebSocket endpoint that echoes what it receives. */
function upgradingSystem(): Promise<{
  origin: string;
  seen: { path?: string; auth?: string }[];
  close: () => void;
}> {
  const seen: { path?: string; auth?: string }[] = [];
  const server = http.createServer((_req, res) => res.end("plain"));
  server.on("upgrade", (req, socket) => {
    seen.push({ path: req.url, auth: String(req.headers.authorization ?? "") });
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
    );
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => server.close(),
      });
    });
  });
}

/** One raw upgrade attempt against the proxy - returns everything the
 *  socket said until it closed or answered the probe payload. */
function rawUpgrade(
  proxy: SapProxy,
  path: string
): Promise<string> {
  const port = Number(new URL(proxy.origin).port);
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: x\r\nSec-WebSocket-Version: 13\r\n\r\n"
      );
    });
    let buffer = "";
    let sent = false;
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("ping")) {
        socket.end();
        resolve(buffer);
        return;
      }
      if (!sent && buffer.includes("\r\n\r\n")) {
        sent = true;
        socket.write("ping");
      }
    });
    socket.on("close", () => resolve(buffer));
    // a refused upgrade may surface as ECONNRESET rather than a clean close
    socket.on("error", () => resolve(buffer));
    setTimeout(() => {
      socket.destroy();
      resolve(buffer);
    }, 3000).unref();
  });
}

test("a WebSocket upgrade is forwarded, credentials injected", async () => {
  const system = await upgradingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await rawUpgrade(proxy, `${tokenPath(proxy)}/sap/bc/apc/ws`);
    assert.match(answer, /^HTTP\/1\.1 101 /, answer);
    assert.ok(answer.endsWith("ping"), "data flows both ways");
    assert.equal(system.seen.length, 1);
    assert.equal(system.seen[0].path, "/sap/bc/apc/ws", "token-free path");
    assert.match(system.seen[0].auth ?? "", /^Basic /, "auth injected");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a WebSocket upgrade without the token is refused", async () => {
  const system = await upgradingSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const answer = await rawUpgrade(proxy, "/sap/bc/apc/ws");
    assert.equal(answer, "", "destroyed without an answer");
    assert.deepEqual(system.seen, [], "nothing was forwarded");
  } finally {
    await proxy.stop();
    system.close();
  }
});
