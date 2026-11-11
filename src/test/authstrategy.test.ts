import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import * as net from "net";
import { AddressInfo } from "net";
import { inspect } from "util";
import { AuthStrategy, BasicAuthStrategy } from "../authstrategy";
import { ProxyResponse, SapProxy } from "../proxy";

// A user and a password with non-ASCII characters and colons in the password.
// The literal below is what the proxy sent for them BEFORE the strategy
// existed ("Basic " + base64 of the UTF-8 bytes of `user:pass`), written out
// rather than recomputed, so the test does not repeat the implementation.
const USER = "müller";
const PASS = "pä:ss:wörd€";
const HEADER = "Basic bcO8bGxlcjpww6Q6c3M6d8O2cmTigqw=";

interface FakeSystem {
  origin: string;
  /** The `Authorization` header of every request and upgrade that arrived. */
  seen: { path: string; authorization?: string }[];
  status: number;
  close(): void;
}

async function fakeSystem(status = 200): Promise<FakeSystem> {
  const system: FakeSystem = { origin: "", seen: [], status, close: () => undefined };
  const server = http.createServer((req, res) => {
    system.seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    if (system.status === 401) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="SAP"' }).end("no");
    } else {
      res.writeHead(system.status, { "content-type": "text/plain" }).end("ok");
    }
  });
  server.on("upgrade", (req, socket) => {
    system.seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    socket.end("HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n");
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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { headers }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

/** One WebSocket-style upgrade through the proxy; resolves with the status line. */
function upgrade(proxyOrigin: string, path: string): Promise<string> {
  const url = new URL(proxyOrigin);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${url.pathname}${path} HTTP/1.1\r\n` +
          `host: ${url.host}\r\n` +
          "connection: Upgrade\r\nupgrade: websocket\r\n\r\n"
      );
    });
    let answer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      answer += chunk;
      if (answer.includes("\r\n")) {
        socket.destroy();
        resolve(answer.split("\r\n")[0]);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(answer.split("\r\n")[0]));
  });
}

test("basic auth: the header is 'Basic' plus base64 of the UTF-8 'user:pass'", () => {
  assert.deepEqual(new BasicAuthStrategy("user", "pass").requestHeaders(), {
    authorization: "Basic dXNlcjpwYXNz",
  });
  assert.deepEqual(new BasicAuthStrategy(USER, PASS).requestHeaders(), {
    authorization: HEADER,
  });
  // an empty password is still a password
  assert.deepEqual(new BasicAuthStrategy("user", "").requestHeaders(), {
    authorization: "Basic dXNlcjo=",
  });
});

test("basic auth: the headers are a fresh object per request", () => {
  const strategy = new BasicAuthStrategy("user", "pass");
  const first = strategy.requestHeaders();
  first.authorization = "tampered";
  assert.equal(strategy.requestHeaders().authorization, "Basic dXNlcjpwYXNz");
});

test("basic auth: every 401 means the credentials were rejected", () => {
  const strategy = new BasicAuthStrategy("user", "pass");
  assert.equal(strategy.kind, "basic");
  assert.equal(strategy.onUnauthorized({ authenticate: 'Basic realm="SAP"' }), "rejected");
  // a system that offers no basic auth at all: still no reason to repeat them
  assert.equal(strategy.onUnauthorized({ authenticate: "Negotiate" }), "rejected");
  assert.equal(strategy.onUnauthorized({}), "rejected");
});

test("the strategy does not leak the credentials through JSON or inspect", async () => {
  const strategy = new BasicAuthStrategy(USER, PASS);
  const proxy = new SapProxy();
  const system = await fakeSystem();
  try {
    await proxy.start(system.origin, USER, PASS);
    const printed = [
      JSON.stringify(strategy),
      JSON.stringify({ strategy }),
      inspect(strategy, { depth: 10, showHidden: true }),
      String(strategy),
      Object.keys(strategy).join(","),
      Object.getOwnPropertyNames(strategy).join(","),
      // the proxy that holds one: its own secrets aside, not the credentials
      inspect(proxy, { depth: 10, showHidden: true }),
    ].join("\n");
    for (const secret of [
      PASS,
      USER,
      HEADER,
      HEADER.slice("Basic ".length),
      "wörd",
    ]) {
      assert.ok(!printed.includes(secret), `"${secret}" is not printed`);
    }
    assert.equal(JSON.stringify(strategy), '{"kind":"basic"}');
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("the system receives the same header as before - non-ASCII user, colons in the password", async () => {
  const system = await fakeSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, USER, PASS);

    // a forwarded request - and what the client sent itself is replaced
    const forwarded = await get(`${proxy.origin}/sap/bc/z2ui5`, {
      authorization: "Basic Y2xpZW50OnNlbnQ=",
    });
    assert.equal(forwarded.status, 200);
    // the proxy's own fetch (ADT lookups, the activation watch, app search)
    const direct = await proxy.fetchFromSystem("/sap/bc/adt/probe");
    assert.equal(direct.status, 200);
    // the WebSocket upgrade
    assert.match(await upgrade(proxy.origin, "/sap/bc/apc/ws"), /^HTTP\/1\.1 101/);

    assert.deepEqual(system.seen, [
      { path: "/sap/bc/z2ui5", authorization: HEADER },
      { path: "/sap/bc/adt/probe", authorization: HEADER },
      { path: "/sap/bc/apc/ws", authorization: HEADER },
    ]);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("start( ) takes a strategy as well, and a restart on the same origin swaps it", async () => {
  const system = await fakeSystem();
  const proxy = new SapProxy();
  try {
    const port = await proxy.start(system.origin, new BasicAuthStrategy("first", "one"));
    assert.equal(proxy.isRunning, true);
    await get(`${proxy.origin}/a`);
    assert.equal(await proxy.start(system.origin, "second", "two"), port);
    await get(`${proxy.origin}/b`);
    assert.deepEqual(
      system.seen.map((s) => s.authorization),
      ["Basic Zmlyc3Q6b25l", "Basic c2Vjb25kOnR3bw=="]
    );
  } finally {
    await proxy.stop();
    system.close();
  }
  assert.equal(proxy.isRunning, false);
});

test("the strategy decides whether a 401 trips the retry breaker; the answer is reported either way", async () => {
  const system = await fakeSystem(401);
  const asked: (string | undefined)[] = [];
  const lenient: AuthStrategy = {
    kind: "test",
    requestHeaders: () => ({ "x-test-logon": "token" }),
    onUnauthorized: (answer) => {
      asked.push(answer.authenticate);
      return "ignore";
    },
  };
  const proxy = new SapProxy();
  const reported: ProxyResponse[] = [];
  proxy.onResponse = (response) => reported.push(response);
  try {
    await proxy.start(system.origin, lenient);
    assert.equal((await get(`${proxy.origin}/one`)).status, 401);
    assert.equal((await get(`${proxy.origin}/two`)).status, 401);
    assert.equal((await proxy.fetchFromSystem("/three")).status, 401);
    // nothing was answered locally: all three reached the system
    assert.deepEqual(system.seen.map((s) => s.path), ["/one", "/two", "/three"]);
    assert.deepEqual(asked, ['Basic realm="SAP"', 'Basic realm="SAP"', 'Basic realm="SAP"']);
    assert.equal(reported.length, 3);
    assert.equal(reported[0].authenticate, 'Basic realm="SAP"');

    // basic auth, on the same proxy: the first 401 is the last one sent
    await proxy.start(system.origin, "user", "wrong");
    assert.equal((await get(`${proxy.origin}/four`)).status, 401);
    const local = await get(`${proxy.origin}/five`);
    assert.equal(local.status, 401);
    assert.match(local.body, /rejected the stored user or password/);
    await assert.rejects(proxy.fetchFromSystem("/six"), /rejected the stored credentials/);
    assert.deepEqual(system.seen.map((s) => s.path), ["/one", "/two", "/three", "/four"]);
  } finally {
    await proxy.stop();
    system.close();
  }
});
