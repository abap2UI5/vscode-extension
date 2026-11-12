import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { inspect } from "util";
import { SapProxy } from "../proxy";
import { SERVER_DIRS } from "../repolayout";
import {
  decideStart,
  FAILED_PREFIX,
  LAUNCHER_FILE,
  launcherEnv,
  LocalBackendAuth,
  LocalBackendError,
  LocalHostCommand,
  localTemplate,
  mockNote,
  newToken,
  parseLauncherLine,
  projectRootFor,
  READY_PREFIX,
  resolveLocalHost,
  runtimePinFor,
  sourceFingerprint,
  sourceFolderFor,
  startLocalHost,
  TOKEN_HEADER,
} from "../localbackend";

/*
 * The "Local (transpiled)" system: which program serves the workspace's
 * classes, which folder it collects, how its one readiness line is read, when
 * F9 builds again - and the launcher itself (src/localbackend-host.mjs, copied
 * next to this bundle), first against a stub mcp-server, then, opt-in,
 * against the real pinned one.
 */

const ROOT = path.resolve(__dirname, "..");
const LAUNCHER = path.join(__dirname, LAUNCHER_FILE);
const PIN = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  localBackend?: { mcpServer?: string };
}).localBackend?.mcpServer ?? "";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a2ui5-local-"));
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// --------------------------------------------------------------- the pin

test("the mcp-server pin is one exact version", () => {
  assert.match(PIN, /^\d+\.\d+\.\d+$/, "package.json localBackend.mcpServer");
});

// ------------------------------------------------------------ the ladder

const root = path.join(path.sep, "repos");
const launcher = path.join(path.sep, "ext", "dist", LAUNCHER_FILE);
const checkoutFiles = (dir: string) => [
  path.join(root, dir, "lib", "npm-backend.mjs"),
  path.join(root, dir, "lib", "npm-host.mjs"),
  path.join(root, dir, "scripts", "ci-unit.mjs"),
];

test("an mcp-server checkout under the repos root is driven from disk", () => {
  const files = new Set(checkoutFiles(SERVER_DIRS[0]));
  const cmd = resolveLocalHost({
    reposRoot: root,
    serverDirs: SERVER_DIRS,
    pin: "1.0.0",
    launcher,
    exists: (f) => files.has(f),
  });
  assert.equal(cmd.source, "local checkout");
  assert.equal(cmd.cmd, "node");
  assert.deepEqual(cmd.args, [launcher]);
  assert.equal(cmd.env.ABAP2UI5_LOCAL_MCP, path.join(root, SERVER_DIRS[0]));
  assert.equal(cmd.shell, false);
});

test("a checkout without the library the launcher imports is not one - npx at the pin", () => {
  const files = new Set(checkoutFiles(SERVER_DIRS[0]).slice(0, 2));
  const cmd = resolveLocalHost({
    reposRoot: root,
    serverDirs: SERVER_DIRS,
    pin: "1.0.0",
    launcher,
    exists: (f) => files.has(f),
    platform: "linux",
  });
  assert.equal(cmd.source, "npx");
  assert.equal(cmd.cmd, "npx");
  assert.deepEqual(cmd.args, ["--yes", "-p", "@abap2ui5/mcp-server@1.0.0", "node", launcher]);
  assert.equal(cmd.env.ABAP2UI5_LOCAL_MCP_VERSION, "1.0.0");
  assert.equal(cmd.shell, false);
});

test("no repos root: npx, through a shell on Windows (npx is a .cmd there)", () => {
  const cmd = resolveLocalHost({
    reposRoot: "  ",
    serverDirs: SERVER_DIRS,
    pin: "1.0.0",
    launcher,
    exists: () => true,
    platform: "win32",
  });
  assert.equal(cmd.source, "npx");
  assert.equal(cmd.shell, true);
});

// ----------------------------------------------------- folder and release

test("the project is the nearest .abapgit.xml up to the workspace folder", () => {
  const ws = path.join(path.sep, "ws");
  const file = path.join(ws, "app", "src", "01", "zcl_a.clas.abap");
  const exists = (f: string) => f === path.join(ws, "app", ".abapgit.xml");
  assert.equal(projectRootFor(file, ws, exists), path.join(ws, "app"));
  assert.equal(projectRootFor(file, ws, () => false), ws);
  assert.equal(projectRootFor(file, undefined, exists), path.dirname(file));
  assert.equal(projectRootFor(file, path.join(path.sep, "other"), exists), path.dirname(file));
});

test("the folder collected: STARTING_FOLDER, else src, else the project", () => {
  const p = path.join(path.sep, "p");
  const file = path.join(p, "abap", "src", "sub", "zcl_a.clas.abap");
  const xml = (folder: string) =>
    `<asx:abap><asx:values><DATA><STARTING_FOLDER>${folder}</STARTING_FOLDER></DATA></asx:values></asx:abap>`;
  assert.deepEqual(
    sourceFolderFor({ projectRoot: p, classFile: file, abapgitXml: xml("/abap/src/"), exists: () => true }),
    { folder: path.join(p, "abap", "src"), from: ".abapgit.xml STARTING_FOLDER" }
  );
  assert.equal(
    sourceFolderFor({ projectRoot: p, classFile: file, abapgitXml: xml("/"), exists: () => true }).folder,
    p
  );
  const inSrc = path.join(p, "src", "zcl_a.clas.abap");
  assert.equal(
    sourceFolderFor({ projectRoot: p, classFile: inSrc, exists: (f) => f === path.join(p, "src") }).folder,
    path.join(p, "src")
  );
  assert.equal(sourceFolderFor({ projectRoot: p, classFile: inSrc, exists: () => false }).folder, p);
  // a class outside the starting folder is built from its own folder
  const outside = path.join(p, "tools", "zcl_b.clas.abap");
  const r = sourceFolderFor({ projectRoot: p, classFile: outside, abapgitXml: xml("/src/"), exists: () => true });
  assert.equal(r.folder, path.join(p, "tools"));
  assert.match(r.from, /own folder/);
});

test("the framework release: the project's pin from 1.145.0 on, else the latest with a note", () => {
  const cfg = (branch: string) =>
    `{ "dependencies": [ { "url": "https://github.com/abap2UI5/abap2UI5", "branch": "${branch}" } ] }`;
  assert.deepEqual(runtimePinFor(cfg("1.148.0")), { version: "1.148.0" });
  assert.deepEqual(runtimePinFor(cfg("v1.145.0")), { version: "1.145.0" });
  assert.match(runtimePinFor(cfg("1.142.0")).note ?? "", /from 1\.145\.0 on/);
  assert.equal(runtimePinFor(cfg("1.142.0")).version, undefined);
  assert.match(runtimePinFor(cfg("main")).note ?? "", /no release/);
  assert.match(runtimePinFor(undefined).note ?? "", /pins no framework/);
});

test("the launcher's environment: token, folder, workspace, port; a user's runtime pin wins", () => {
  const command: LocalHostCommand = {
    cmd: "node", args: [], env: { ABAP2UI5_LOCAL_MCP: "/m" }, shell: false, source: "local checkout", from: "/m",
  };
  const env = launcherEnv({
    base: { PATH: "/bin" }, command, token: "t".repeat(32), source: "/p/src", workspace: "/g/local-backend", port: 4711, runtime: "1.148.0",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ABAP2UI5_LOCAL_MCP, "/m");
  assert.equal(env.ABAP2UI5_LOCAL_TOKEN, "t".repeat(32));
  assert.equal(env.ABAP2UI5_LOCAL_SOURCE, "/p/src");
  assert.equal(env.A2UI5_MCP_WORKSPACE, "/g/local-backend");
  assert.equal(env.ABAP2UI5_LOCAL_PORT, "4711");
  assert.equal(env.A2UI5_MCP_RUNTIME_VERSION, "1.148.0");
  const own = launcherEnv({
    base: { A2UI5_MCP_RUNTIME_VERSION: "1.146.0" }, command, token: "x", source: "s", workspace: "w", runtime: "1.148.0",
  });
  assert.equal(own.A2UI5_MCP_RUNTIME_VERSION, "1.146.0");
  assert.equal(own.ABAP2UI5_LOCAL_PORT, "0");
});

// ------------------------------------------------------- reading the lines

test("the launcher's two lines, and nothing else, are read", () => {
  assert.deepEqual(parseLauncherLine(`${READY_PREFIX}{"port":4711,"runtime":"1.148.0","banner":"b"}\r`), {
    kind: "ready", port: 4711, runtime: "1.148.0", banner: "b",
  });
  assert.deepEqual(parseLauncherLine(`${FAILED_PREFIX}{"reason":"the build failed: x"}`), {
    kind: "failed", reason: "the build failed: x",
  });
  assert.equal(parseLauncherLine(`${READY_PREFIX}{"port":0}`)?.kind, "failed");
  assert.equal(parseLauncherLine(`${READY_PREFIX}not json`), undefined);
  assert.equal(parseLauncherLine("Listening on 3000"), undefined);
  assert.equal(parseLauncherLine(""), undefined);
});

// --------------------------------------------------------- the token

test("the proxy's strategy carries the token in a header, never in a print, and no 401 trips it", () => {
  const token = newToken();
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.notEqual(newToken(), token);
  const auth = new LocalBackendAuth(token);
  assert.equal(auth.kind, "local");
  assert.deepEqual(auth.requestHeaders(), { [TOKEN_HEADER]: token });
  assert.equal(auth.onUnauthorized(), "ignore");
  assert.ok(!JSON.stringify(auth).includes(token));
  assert.ok(!inspect(auth, { showHidden: true, depth: 5 }).includes(token));
});

// ------------------------------------------------- when to build again

test("F9 reuses a host only for the same folder, program and unchanged files", () => {
  const a = { key: "k", fingerprint: "f" };
  assert.equal(decideStart(undefined, a), "start");
  assert.equal(decideStart({ ...a, alive: false }, a), "start");
  assert.equal(decideStart({ ...a, alive: true }, a), "reuse");
  assert.equal(decideStart({ ...a, alive: true }, a, true), "restart");
  assert.equal(decideStart({ ...a, alive: true }, { ...a, fingerprint: "g" }), "restart");
  assert.equal(decideStart({ ...a, alive: true }, { ...a, key: "other" }), "restart");
});

test("the fingerprint moves with the object files and ignores everything else", () => {
  const dir = scratch();
  try {
    write(path.join(dir, "zcl_a.clas.abap"), "CLASS zcl_a.");
    const first = sourceFingerprint(dir);
    assert.equal(sourceFingerprint(dir), first);
    write(path.join(dir, "README.md"), "x");
    write(path.join(dir, "node_modules", "zcl_x.clas.abap"), "x");
    write(path.join(dir, ".hidden", "zcl_y.clas.abap"), "x");
    assert.equal(sourceFingerprint(dir), first);
    write(path.join(dir, "sub", "zcl_b.clas.xml"), "<x/>");
    const second = sourceFingerprint(dir);
    assert.notEqual(second, first);
    write(path.join(dir, "zcl_a.clas.abap"), "CLASS zcl_a. \" changed");
    assert.notEqual(sourceFingerprint(dir), second);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a mock file beside the class is named as NOT applied, never pretended", () => {
  const file = path.join(path.sep, "p", "src", "zcl_a.clas.abap");
  const mock = path.join(path.sep, "p", "src", "zcl_a.mock.json");
  assert.match(mockNote(file, (f) => f === mock) ?? "", /zcl_a\.mock\.json is not applied/);
  assert.equal(mockNote(file, () => false), undefined);
  assert.equal(localTemplate(4711), "http://127.0.0.1:4711/?app_start={class}");
});

// ------------------------------------------ starting a (stub) launcher

function stubCommand(script: string): LocalHostCommand {
  return { cmd: process.execPath, args: [script], env: {}, shell: false, source: "local checkout", from: "stub" };
}

test("a launcher that prints its ready line is up; stop() ends it", async () => {
  const dir = scratch();
  const script = path.join(dir, "stub.js");
  write(
    script,
    `process.stderr.write("transpile: 1 dev object(s)\\n");
     process.stdout.write("some runtime chatter\\n");
     process.stdout.write(${JSON.stringify(READY_PREFIX)} + JSON.stringify({ port: 45678, runtime: "1.148.0", banner: "stub" }) + "\\n");
     process.stdin.resume();`
  );
  const lines: string[] = [];
  try {
    const host = await startLocalHost(stubCommand(script), { cwd: dir, env: process.env, onLog: (l) => lines.push(l), timeoutMs: 20_000 });
    assert.equal(host.port, 45678);
    assert.equal(host.origin, "http://127.0.0.1:45678");
    assert.equal(host.runtime, "1.148.0");
    assert.ok(host.alive);
    assert.ok(lines.includes("transpile: 1 dev object(s)"));
    assert.ok(lines.includes("some runtime chatter"));
    host.stop();
    await host.exited;
    assert.equal(host.alive, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed line, an early exit and a timeout are each a LocalBackendError", async () => {
  const dir = scratch();
  try {
    const failed = path.join(dir, "failed.js");
    write(failed, `process.stdout.write(${JSON.stringify(FAILED_PREFIX)} + JSON.stringify({ reason: "the build failed: syntax" }) + "\\n"); process.exit(1);`);
    await assert.rejects(startLocalHost(stubCommand(failed), { cwd: dir, env: process.env, timeoutMs: 20_000 }), (e: Error) =>
      e instanceof LocalBackendError && e.message === "the build failed: syntax");

    const early = path.join(dir, "early.js");
    write(early, `process.stderr.write("npm ERR! network\\n"); process.exit(3);`);
    await assert.rejects(startLocalHost(stubCommand(early), { cwd: dir, env: process.env, timeoutMs: 20_000 }), (e: Error) =>
      e instanceof LocalBackendError && /exit code 3/.test(e.message) && e.logTail.includes("npm ERR! network"));

    const slow = path.join(dir, "slow.js");
    write(slow, "setInterval(() => {}, 1000);");
    await assert.rejects(startLocalHost(stubCommand(slow), { cwd: dir, env: process.env, timeoutMs: 300 }), (e: Error) =>
      e instanceof LocalBackendError && /not ready/.test(e.message));

    await assert.rejects(
      startLocalHost({ ...stubCommand("x"), cmd: path.join(dir, "no-such-program") }, { cwd: dir, env: process.env, timeoutMs: 5000 }),
      (e: Error) => e instanceof LocalBackendError && /could not start/.test(e.message)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------- the real launcher against a stub mcp-server

/** A directory shaped like mcp-server whose three modules stand in for the
 *  real build and host: what the launcher itself does around them - the
 *  token guard, loopback, the ready line, the environment - is what is tested. */
function stubMcpServer(dir: string): void {
  write(
    path.join(dir, "scripts", "ci-unit.mjs"),
    `import fs from "fs"; import path from "path";
     export function collectObjects([src]) {
       return fs.readdirSync(src).filter((f) => f.endsWith(".clas.abap"))
         .map((f) => ({ name: f.split(".")[0], type: "clas", files: [{ path: path.join(src, f), name: f }] }));
     }
     export function writeObjects(objects, dir) {
       fs.mkdirSync(dir, { recursive: true });
       for (const o of objects) for (const f of o.files) fs.copyFileSync(f.path, path.join(dir, f.name));
       return { written: [], errors: {} };
     }`
  );
  write(
    path.join(dir, "lib", "npm-backend.mjs"),
    `import fs from "fs";
     export async function buildNpm({ inputDir, onLine }) {
       onLine("transpile: " + fs.readdirSync(inputDir).join(","));
       return { ok: true, version: "9.9.9", dir: inputDir };
     }`
  );
  write(
    path.join(dir, "lib", "npm-host.mjs"),
    `import http from "http"; import fs from "fs";
     export async function startHost({ dir, port, host }) {
       const server = http.createServer((req, res) => {
         res.writeHead(200, { "content-type": "application/json" });
         res.end(JSON.stringify({
           url: req.url,
           host: req.headers.host,
           sawToken: Boolean(req.headers["x-abap2ui5-local-token"]),
           envToken: Boolean(process.env.ABAP2UI5_LOCAL_TOKEN),
           apps: fs.readdirSync(dir),
         }));
       });
       await new Promise((r) => server.listen(port, host, r));
       return { server, banner: "stub host on " + host };
     }`
  );
}

function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
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

test("the launcher: token required, loopback only, reached through the proxy", async () => {
  const dir = scratch();
  const mcp = path.join(dir, "mcp");
  const project = path.join(dir, "project", "src");
  stubMcpServer(mcp);
  write(path.join(project, "zcl_a.clas.abap"), "CLASS zcl_a DEFINITION. ENDCLASS.");
  const token = newToken();
  const command: LocalHostCommand = { ...stubCommand(LAUNCHER), env: { ABAP2UI5_LOCAL_MCP: mcp } };
  const proxy = new SapProxy();
  let host;
  try {
    host = await startLocalHost(command, {
      cwd: dir,
      env: launcherEnv({ base: process.env, command, token, source: project, workspace: path.join(dir, "ws") }),
      timeoutMs: 30_000,
    });
    assert.equal(host.runtime, "9.9.9");
    assert.match(host.banner, /stub host on 127\.0\.0\.1/);

    // without the token, or with a wrong one, nothing answers
    assert.equal((await get(`${host.origin}/?app_start=ZCL_A`)).status, 404);
    assert.equal((await get(`${host.origin}/`, { [TOKEN_HEADER]: newToken() })).status, 404);

    // with it, the host's handler runs - and never sees the token: not in the
    // header (stripped), not in its environment (removed before the build)
    const direct = await get(`${host.origin}/?app_start=ZCL_A`, { [TOKEN_HEADER]: token });
    assert.equal(direct.status, 200);
    const seen = JSON.parse(direct.body) as { sawToken: boolean; envToken: boolean; apps: string[] };
    assert.equal(seen.sawToken, false);
    assert.equal(seen.envToken, false);
    assert.deepEqual(seen.apps, ["zcl_a.clas.abap"]);

    // the way the preview reaches it: the proxy, with the token as its strategy
    await proxy.start(host.origin, new LocalBackendAuth(token));
    const proxied = await get(`${proxy.origin}/?app_start=ZCL_A`);
    assert.equal(proxied.status, 200);
    assert.equal((JSON.parse(proxied.body) as { url: string }).url, "/?app_start=ZCL_A");
    assert.equal((JSON.parse(proxied.body) as { host: string }).host, `127.0.0.1:${host.port}`);

    // loopback only: the host is not reachable on another address of this machine
    const other = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (other) {
      await assert.rejects(get(`http://${other}:${host.port}/`, { [TOKEN_HEADER]: token }));
    }

    // a restart asked for the same port gets it
    const port = host.port;
    host.stop();
    await host.exited;
    host = await startLocalHost(command, {
      cwd: dir,
      env: launcherEnv({ base: process.env, command, token, source: project, workspace: path.join(dir, "ws"), port }),
      timeoutMs: 30_000,
    });
    assert.equal(host.port, port);
  } finally {
    host?.stop();
    await proxy.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the launcher refuses an mcp-server without the library, and a run without a token", async () => {
  const dir = scratch();
  const project = path.join(dir, "src");
  write(path.join(project, "zcl_a.clas.abap"), "x");
  write(path.join(dir, "mcp", "lib", "npm-host.mjs"), "export {};");
  const command: LocalHostCommand = { ...stubCommand(LAUNCHER), env: { ABAP2UI5_LOCAL_MCP: path.join(dir, "mcp") } };
  try {
    await assert.rejects(
      startLocalHost(command, {
        cwd: dir,
        env: launcherEnv({ base: process.env, command, token: newToken(), source: project, workspace: path.join(dir, "ws") }),
        timeoutMs: 30_000,
      }),
      (e: Error) => /no mcp-server this extension can drive/.test(e.message) && /npm-backend\.mjs/.test(e.message)
    );
    await assert.rejects(
      startLocalHost(command, {
        cwd: dir,
        env: launcherEnv({ base: process.env, command, token: "", source: project, workspace: path.join(dir, "ws") }),
        timeoutMs: 30_000,
      }),
      (e: Error) => /no request token/.test(e.message)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- the real thing, opt-in

/**
 * The pinned mcp-server: ABAP2UI5_LOCAL_BACKEND_MCP (a checkout or an
 * unpacked package), else the copy npx left in npm's cache
 * (`~/.npm/_npx/<hash>/node_modules/@abap2ui5/mcp-server`) at the pin. CI
 * has neither, so the test skips there; the weekly bump fills the npx cache
 * before its gate runs, so a new pin is proven end to end there.
 */
function realMcpServer(): string | undefined {
  const named = process.env.ABAP2UI5_LOCAL_BACKEND_MCP;
  if (named) {
    return fs.existsSync(path.join(named, "lib", "npm-host.mjs")) ? named : undefined;
  }
  const npx = path.join(process.env.npm_config_cache || path.join(os.homedir(), ".npm"), "_npx");
  let hashes: string[] = [];
  try {
    hashes = fs.readdirSync(npx);
  } catch {
    return undefined;
  }
  for (const hash of hashes) {
    const dir = path.join(npx, hash, "node_modules", "@abap2ui5", "mcp-server");
    try {
      if ((JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string }).version === PIN) {
        return dir;
      }
    } catch {
      /* not this one */
    }
  }
  return undefined;
}

const REAL = realMcpServer();
const realSkip = REAL ? false : `no @abap2ui5/mcp-server@${PIN} (ABAP2UI5_LOCAL_BACKEND_MCP, or npm's npx cache)`;

function post(url: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "sap-contextid-accept": "header" } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test("real local backend: app-template's starter app starts, and an event reaches its handler", { skip: realSkip, timeout: 15 * 60_000 }, async () => {
  const dir = scratch();
  const files = (JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "app-template.json"), "utf8")) as {
    files: Record<string, string>;
  }).files;
  for (const name of [".abapgit.xml", "src/zcl_app_001.clas.abap", "src/zcl_app_001.clas.xml"]) {
    write(path.join(dir, "project", name), files[name]);
  }
  const projectRoot = path.join(dir, "project");
  const source = sourceFolderFor({
    projectRoot,
    classFile: path.join(projectRoot, "src", "zcl_app_001.clas.abap"),
    abapgitXml: files[".abapgit.xml"],
    exists: fs.existsSync,
  });
  const command: LocalHostCommand = { ...stubCommand(LAUNCHER), env: { ABAP2UI5_LOCAL_MCP: REAL! } };
  const token = newToken();
  const proxy = new SapProxy();
  // a workspace kept between runs makes the second one seconds, not a minute
  const workspace = process.env.ABAP2UI5_LOCAL_BACKEND_WORKSPACE || path.join(dir, "ws");
  let host;
  try {
    host = await startLocalHost(command, {
      cwd: projectRoot,
      env: launcherEnv({ base: process.env, command, token, source: source.folder, workspace }),
    });
    await proxy.start(host.origin, new LocalBackendAuth(token));

    const page = await get(`${proxy.origin}/?app_start=ZCL_APP_001`);
    assert.equal(page.status, 200);
    assert.match(page.body, /sap-ui-core\.js/);

    const start = await post(`${proxy.origin}/`, {
      value: { S_FRONT: { ORIGIN: "http://127.0.0.1", PATHNAME: "/", SEARCH: "?app_start=ZCL_APP_001" } },
    });
    assert.equal(start.status, 200);
    const started = JSON.parse(start.body) as { S_FRONT: { ID: string; APP: string } };
    assert.equal(started.S_FRONT.APP, "ZCL_APP_001");
    assert.match(start.body, /<Input value=\\"\{\/NAME\}\\"/);

    const event = await post(`${proxy.origin}/`, {
      value: { S_FRONT: { ID: started.S_FRONT.ID, EVENT: "SAVE", T_EVENT_ARG: [] }, MODEL: { NAME: "Ada" } },
    });
    assert.equal(event.status, 200);
    assert.match(event.body, /Saved, Ada/);
  } finally {
    host?.stop();
    await proxy.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
