import { test } from "node:test";
import assert from "node:assert/strict";
import * as https from "https";
import * as http from "http";
import * as net from "net";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { AddressInfo } from "net";
import { X509Certificate } from "crypto";
import type { TLSSocket } from "tls";
import { BasicAuthStrategy, CertificateAuthStrategy } from "../authstrategy";
import {
  choiceFor,
  choiceFrom,
  ClientCertificateError,
  clientCertificateRefusal,
  isPkcs12Path,
  loadClientCertificate,
  withChoice,
} from "../clientcert";
import { describeConnectFailure } from "../connectcheck";
import { SapProxy } from "../proxy";

/*
 * `auth: "certificate"` end to end: a local https "system" that REQUIRES a
 * client certificate issued by its own CA and verifies it, a self-signed
 * server certificate the proxy trusts by pin (certtrust), and the proxy in
 * between. Node's crypto makes keys but cannot sign an X.509 certificate,
 * so the certificates are made with `openssl` into a temp directory at test
 * time; without it the TLS half is skipped with that reason.
 */

function opensslMissing(): string | false {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return false;
  } catch {
    return "no `openssl` on PATH - Node alone cannot sign the X.509 certificates this test needs";
  }
}
const SKIP = opensslMissing();

interface Pki {
  dir: string;
  serverKey: string;
  serverCert: string;
  serverFingerprint: string;
  ca: string;
  clientCert: string; // PEM
  clientKeyEncrypted: string; // PEM, passphrase "pem-pass"
  clientP12: string; // passphrase "pfx-pass"
  strangerCert: string; // self-signed, unknown to the server
  strangerKey: string;
}

let pkiCache: Pki | undefined;
function pki(): Pki {
  if (pkiCache) {
    return pkiCache;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap2ui5-clientcert-"));
  const at = (name: string) => path.join(dir, name);
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem",
    "-days", "3", "-subj", "/CN=Test Client CA");
  run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "client.key", "-out", "client.csr",
    "-subj", "/CN=DEVELOPER");
  run("x509", "-req", "-in", "client.csr", "-CA", "ca.pem", "-CAkey", "ca.key",
    "-CAcreateserial", "-out", "client.pem", "-days", "3");
  run("pkey", "-in", "client.key", "-aes256", "-passout", "pass:pem-pass", "-out", "client.enc.key");
  run("pkcs12", "-export", "-inkey", "client.key", "-in", "client.pem", "-out", "client.p12",
    "-passout", "pass:pfx-pass");
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.pem",
    "-days", "3", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1");
  run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "stranger.key",
    "-out", "stranger.pem", "-days", "3", "-subj", "/CN=STRANGER");
  const serverCert = fs.readFileSync(at("server.pem"), "utf8");
  pkiCache = {
    dir,
    serverKey: fs.readFileSync(at("server.key"), "utf8"),
    serverCert,
    serverFingerprint: new X509Certificate(serverCert).fingerprint256,
    ca: fs.readFileSync(at("ca.pem"), "utf8"),
    clientCert: at("client.pem"),
    clientKeyEncrypted: at("client.enc.key"),
    clientP12: at("client.p12"),
    strangerCert: at("stranger.pem"),
    strangerKey: at("stranger.key"),
  };
  return pkiCache;
}

test.after(() => {
  if (pkiCache) {
    fs.rmSync(pkiCache.dir, { recursive: true, force: true });
  }
});

interface TlsSystem {
  origin: string;
  /** What arrived: path, the client certificate's CN, the Authorization header. */
  seen: Array<{ path: string; cn?: string; authorization?: string }>;
  /** Handshakes the server refused. */
  refusedHandshakes: number;
  close(): void;
}

async function systemRequiringClientCertificate(): Promise<TlsSystem> {
  const keys = pki();
  const system: TlsSystem = { origin: "", seen: [], refusedHandshakes: 0, close: () => undefined };
  const record = (req: http.IncomingMessage) => {
    const peer = (req.socket as TLSSocket).getPeerCertificate();
    system.seen.push({
      path: req.url ?? "",
      cn: peer?.subject?.CN as string | undefined,
      authorization: req.headers.authorization,
    });
  };
  const server = https.createServer(
    {
      key: keys.serverKey,
      cert: keys.serverCert,
      ca: keys.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      record(req);
      res.writeHead(200, { "content-type": "text/plain" }).end("logged on by certificate");
    }
  );
  server.on("upgrade", (req, socket) => {
    record(req);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n");
  });
  server.on("tlsClientError", () => {
    system.refusedHandshakes++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  system.origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  system.close = () => {
    server.closeAllConnections();
    server.close();
  };
  return system;
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function upgrade(proxyOrigin: string, wsPath: string): Promise<string> {
  const url = new URL(proxyOrigin);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        `GET ${url.pathname}${wsPath} HTTP/1.1\r\nhost: ${url.host}\r\n` +
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

const readFile = (file: string) => fs.promises.readFile(file);

/** The proxy as F9 sets it up for this system: the server certificate pinned. */
function pinnedProxy(fingerprint: string): SapProxy {
  const proxy = new SapProxy();
  proxy.pinFor = () => fingerprint;
  return proxy;
}

test("the remembered choice is read tolerantly and kept per origin", () => {
  assert.deepEqual(choiceFrom({ kind: "pfx", path: "/c.p12" }), { kind: "pfx", path: "/c.p12" });
  assert.deepEqual(choiceFrom({ kind: "pem", cert: "/c.pem", key: "/k.pem" }), {
    kind: "pem",
    cert: "/c.pem",
    key: "/k.pem",
  });
  for (const junk of [undefined, null, "x", 1, [], { kind: "pfx" }, { kind: "pem", cert: "/c" }, { kind: "?" }]) {
    assert.equal(choiceFrom(junk), undefined, JSON.stringify(junk));
  }
  const map = withChoice({ broken: 1, "https://a": { kind: "pfx", path: "/a.p12" } }, "https://b", {
    kind: "pfx",
    path: "/b.p12",
  });
  assert.deepEqual(Object.keys(map).sort(), ["https://a", "https://b"]);
  assert.deepEqual(choiceFor(map, "https://b"), { kind: "pfx", path: "/b.p12" });
  assert.equal(choiceFor(map, "https://c"), undefined);
  assert.equal(choiceFor(withChoice(map, "https://a", undefined), "https://a"), undefined);
  assert.equal(choiceFor("not a map", "https://a"), undefined);
  assert.ok(isPkcs12Path("C:\\certs\\me.PFX"));
  assert.ok(isPkcs12Path("/me.p12"));
  assert.ok(!isPkcs12Path("/me.pem"));
});

test("a client certificate refusal is told apart from everything else", () => {
  const required = Object.assign(new Error("ssl alert"), {
    code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED",
  });
  assert.match(clientCertificateRefusal(required, "h:1", "basic") ?? "", /requires a client certificate.*"auth": "certificate"/);
  assert.match(clientCertificateRefusal(required, "h:1", "certificate") ?? "", /did not accept the one presented/);
  assert.equal(clientCertificateRefusal(Object.assign(new Error("x"), { code: "ECONNREFUSED" }), "h", "basic"), undefined);
  assert.equal(clientCertificateRefusal(Object.assign(new Error("x"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }), "h", "basic"), undefined);
});

test("loading checks the passphrase, the key and the expiry before anything is sent", { skip: SKIP }, async () => {
  const keys = pki();
  const pem = { kind: "pem" as const, cert: keys.clientCert, key: keys.clientKeyEncrypted };
  const loaded = await loadClientCertificate(pem, "pem-pass", readFile);
  assert.match(loaded.subject ?? "", /CN=DEVELOPER/);
  // valid for three days: inside the warning window
  assert.match(loaded.warning ?? "", /expires on/);
  const pfx = await loadClientCertificate({ kind: "pfx", path: keys.clientP12 }, "pfx-pass", readFile);
  assert.ok(pfx.validTo, "the expiry of a PKCS#12 file is read too");
  assert.ok("pfx" in pfx.material);

  await assert.rejects(
    loadClientCertificate({ kind: "pfx", path: keys.clientP12 }, "wrong", readFile),
    (err: unknown) => err instanceof ClientCertificateError && /passphrase/.test(err.message)
  );
  await assert.rejects(loadClientCertificate(pem, "wrong", readFile), ClientCertificateError);
  await assert.rejects(
    loadClientCertificate({ kind: "pem", cert: keys.clientCert, key: keys.strangerKey }, undefined, readFile),
    (err: unknown) => err instanceof ClientCertificateError && /does not belong/.test(err.message)
  );
  const inTenDays = new Date(Date.now() + 10 * 86_400_000);
  await assert.rejects(
    loadClientCertificate(pem, "pem-pass", readFile, inTenDays),
    (err: unknown) => err instanceof ClientCertificateError && /expired on/.test(err.message)
  );
  await assert.rejects(
    loadClientCertificate({ kind: "pfx", path: path.join(keys.dir, "gone.p12") }, "x", readFile),
    (err: unknown) => err instanceof ClientCertificateError && /cannot be read \(ENOENT\)/.test(err.message)
  );
  // no message carries the passphrase
  try {
    await loadClientCertificate({ kind: "pfx", path: keys.clientP12 }, "wrong-secret-phrase", readFile);
  } catch (err) {
    assert.ok(!String((err as Error).message).includes("wrong-secret-phrase"));
  }
});

test("with the certificate: every request path logs on, the system sees the certificate and no Authorization", { skip: SKIP }, async () => {
  const keys = pki();
  const system = await systemRequiringClientCertificate();
  // the self-signed server certificate is trusted by PIN, next to the client certificate
  const proxy = pinnedProxy(keys.serverFingerprint);
  try {
    const loaded = await loadClientCertificate(
      { kind: "pem", cert: keys.clientCert, key: keys.clientKeyEncrypted },
      "pem-pass",
      readFile
    );
    await proxy.start(system.origin, new CertificateAuthStrategy(loaded.material));
    const page = await get(`${proxy.origin}/sap/bc/z2ui5`);
    assert.equal(page.status, 200);
    assert.equal(page.body, "logged on by certificate");
    const direct = await proxy.fetchFromSystem("/sap/bc/adt/probe");
    assert.equal(direct.status, 200);
    assert.match(await upgrade(proxy.origin, "/sap/bc/apc/ws"), /^HTTP\/1\.1 101/);
    assert.deepEqual(system.seen, [
      { path: "/sap/bc/z2ui5", cn: "DEVELOPER", authorization: undefined },
      { path: "/sap/bc/adt/probe", cn: "DEVELOPER", authorization: undefined },
      { path: "/sap/bc/apc/ws", cn: "DEVELOPER", authorization: undefined },
    ]);

    // the PKCS#12 form of the same certificate works the same way
    const p12 = await loadClientCertificate({ kind: "pfx", path: keys.clientP12 }, "pfx-pass", readFile);
    await proxy.start(system.origin, new CertificateAuthStrategy(p12.material));
    assert.equal((await get(`${proxy.origin}/again`)).status, 200);
    assert.equal(system.seen.at(-1)?.cn, "DEVELOPER");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("without a certificate the system's refusal is reported as such, on every path", { skip: SKIP }, async () => {
  const keys = pki();
  const system = await systemRequiringClientCertificate();
  const proxy = pinnedProxy(keys.serverFingerprint);
  try {
    await proxy.start(system.origin, new BasicAuthStrategy("user", "pass"));
    const page = await get(`${proxy.origin}/sap/bc/z2ui5`);
    assert.equal(page.status, 502);
    assert.match(page.body, /requires a client certificate/);
    assert.match(page.body, /"auth": "certificate"/);
    let thrown: unknown;
    await assert.rejects(
      proxy.fetchFromSystem("/sap/bc/adt/probe").catch((err) => {
        thrown = err;
        throw err;
      }),
      /requires a client certificate/
    );
    // the connection check's step for that error
    const failure = thrown as { code?: string; message?: string };
    const step = describeConnectFailure({ code: failure.code, message: failure.message });
    assert.equal(step.label, "Client certificate");
    assert.equal(step.ok, false);
    assert.equal(system.seen.length, 0, "no request got through");
    assert.ok(system.refusedHandshakes >= 1);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a certificate the system does not trust is refused, and said so for a certificate profile", { skip: SKIP }, async () => {
  const keys = pki();
  const system = await systemRequiringClientCertificate();
  const proxy = pinnedProxy(keys.serverFingerprint);
  try {
    const stranger = await loadClientCertificate(
      { kind: "pem", cert: keys.strangerCert, key: keys.strangerKey },
      undefined,
      readFile
    );
    await proxy.start(system.origin, new CertificateAuthStrategy(stranger.material));
    // Under TLS 1.3 the server's alert races its close: the client sees
    // either the alert (then the sentence names the certificate) or a bare
    // reset. Either way the request is refused and nothing got through.
    await assert.rejects(proxy.fetchFromSystem("/probe"), (err: unknown) => {
      const message = (err as Error).message;
      return (
        !/openMode/.test(message) &&
        (/did not accept the one presented/.test(message) || /socket hang up|ECONNRESET/.test(message))
      );
    });
    assert.equal(system.seen.length, 0);
    assert.ok(system.refusedHandshakes >= 1, "the server refused the handshake");
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a pin mismatch is still refused before the request, client certificate or not", { skip: SKIP }, async () => {
  const keys = pki();
  const system = await systemRequiringClientCertificate();
  const proxy = pinnedProxy(Array.from({ length: 32 }, () => "0F").join(":"));
  const refused: string[] = [];
  proxy.onTrustRefused = (message) => refused.push(message);
  try {
    const loaded = await loadClientCertificate({ kind: "pfx", path: keys.clientP12 }, "pfx-pass", readFile);
    await proxy.start(system.origin, new CertificateAuthStrategy(loaded.material));
    await assert.rejects(proxy.fetchFromSystem("/probe"), /certificate/i);
    assert.equal((await get(`${proxy.origin}/page`)).status, 502);
    assert.equal(system.seen.length, 0, "nothing was sent to a host presenting another certificate");
    assert.ok(refused.length >= 1);
  } finally {
    await proxy.stop();
    system.close();
  }
});
