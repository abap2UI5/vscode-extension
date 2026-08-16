import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as https from "https";
import { AddressInfo } from "net";
import { injectRuntimeHook, SapProxy } from "../proxy";

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
  const { parseAdtClassNames } = require("../proxy") as typeof import("../proxy");
  const xml = `<?xml version="1.0"?><adtcore:objectReferences xmlns:adtcore="x">
    <adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_APP_ONE" adtcore:description="d"/>
    <adtcore:objectReference adtcore:name="ZCL_APP_TWO" adtcore:type="CLAS/OC"/>
    <adtcore:objectReference adtcore:type="PROG/P" adtcore:name="ZREPORT"/>
    <adtcore:objectReference adtcore:type="CLAS/OC" adtcore:name="ZCL_APP_ONE"/>
  </adtcore:objectReferences>`;
  assert.deepEqual(parseAdtClassNames(xml), ["ZCL_APP_ONE", "ZCL_APP_TWO"]);
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
      c.startsWith("__abap2ui5_proxy=")
    );
    assert.ok(planted, "the answer carries the cookie");
    assert.match(planted!, /HttpOnly/, "the page cannot read it back out");

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
    await rawGet(proxy, `${tokenPath(proxy)}/sap/bc/z2ui5`, {
      cookie: `sap-usercontext=x; __abap2ui5_proxy=${token}`,
    });
    assert.equal(system.seen[0].cookie, "sap-usercontext=x");
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
