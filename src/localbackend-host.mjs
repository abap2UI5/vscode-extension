#!/usr/bin/env node
/*
 * The local backend's launcher - what the "Local (transpiled)" system runs.
 * Shipped as dist/localbackend-host.mjs (copied by esbuild.js, never
 * bundled) and started by src/localbackend.ts:
 *
 *   node localbackend-host.mjs                         (mcp-server checkout)
 *   npx --yes -p @abap2ui5/mcp-server@<pin> node localbackend-host.mjs
 *
 * It is glue around mcp-server's own LIBRARY functions, nothing of its own:
 *
 *   1. collectObjects / writeObjects (scripts/ci-unit.mjs, what
 *      abap2ui5-unit does) - every class, interface, table and data element
 *      under ABAP2UI5_LOCAL_SOURCE, flattened into one directory of the
 *      workspace (buildNpm reads only the top level of its input);
 *   2. buildNpm (lib/npm-backend.mjs) - @abap2ui5/node-runtime installed
 *      into the workspace, open-abap-core fetched, the objects transpiled
 *      into <runtime dir>/apps;
 *   3. startHost (lib/npm-host.mjs) - the release booted with those apps,
 *      served on 127.0.0.1 only, behind npm-host's loopback Host/Origin
 *      guard;
 *   4. one more guard in front of it: every request must carry the token
 *      the extension handed in (header x-abap2ui5-local-token, compared in
 *      constant time), anything else is a 404. The extension's auth proxy
 *      adds the header; the webview never talks to this process.
 *
 * mcp-server 1.0.0 has no `serve` bin, so the extension pins the package
 * EXACTLY (package.json `localBackend.mcpServer`) and imports these modules
 * by path - see docs/systemless-preview.md, section 5.
 *
 * Environment (the extension sets it; nothing is read from argv, which every
 * local user can see):
 *   ABAP2UI5_LOCAL_TOKEN        the request token (removed from the
 *                               environment before anything else runs)
 *   ABAP2UI5_LOCAL_SOURCE       the folder to collect
 *   ABAP2UI5_LOCAL_MCP          an mcp-server checkout or package directory;
 *                               unset: the package npx put on PATH, at
 *   ABAP2UI5_LOCAL_MCP_VERSION  this exact version
 *   ABAP2UI5_LOCAL_PORT         the port to try first (a restart keeps its
 *                               port when it can); 0 or unset: any free one
 *   A2UI5_MCP_WORKSPACE         mcp-server's workspace (the runtime install)
 *   A2UI5_MCP_RUNTIME_VERSION   the node-runtime release, when pinned
 *
 * Output: the build's log on stderr, line by line; on stdout exactly one
 * machine-readable line,
 *   ABAP2UI5_LOCAL_READY {"port":<n>,"runtime":"<version>","banner":"..."}
 * or
 *   ABAP2UI5_LOCAL_FAILED {"reason":"..."}
 * (then exit 1). Runs until killed, or until its stdin closes - the
 * extension host that started it is gone then.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const READY = 'ABAP2UI5_LOCAL_READY ';
const FAILED = 'ABAP2UI5_LOCAL_FAILED ';
const TOKEN_HEADER = 'x-abap2ui5-local-token';
const HOST = '127.0.0.1';
const LIBRARY = ['lib/npm-backend.mjs', 'lib/npm-host.mjs', 'scripts/ci-unit.mjs'];

const log = (line) => process.stderr.write(`${line}\n`);

function fail(reason) {
  process.stdout.write(`${FAILED}${JSON.stringify({ reason: String(reason) })}\n`);
  process.exit(1);
}

/** The mcp-server directory: the one named, else the package npx installed -
 *  found through the `node_modules/.bin` directory npx put on PATH, at the
 *  pinned version only. */
function mcpServerDir(env) {
  if (env.ABAP2UI5_LOCAL_MCP) return path.resolve(env.ABAP2UI5_LOCAL_MCP);
  const want = env.ABAP2UI5_LOCAL_MCP_VERSION || '';
  for (const entry of String(env.PATH || '').split(path.delimiter)) {
    if (path.basename(entry) !== '.bin' || path.basename(path.dirname(entry)) !== 'node_modules') continue;
    const dir = path.join(path.dirname(entry), '@abap2ui5', 'mcp-server');
    try {
      const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
      if (!want || version === want) return dir;
    } catch {
      /* not this entry */
    }
  }
  return null;
}

/** The preferred port when nobody holds it, else 0 (any free port). */
function portToUse(preferred) {
  if (!preferred) return Promise.resolve(0);
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(0));
    probe.listen(preferred, HOST, () => probe.close(() => resolve(preferred)));
  });
}

/** In front of everything the host does with a request: the token, or 404. */
function requireToken(server, token) {
  const expected = Buffer.from(token);
  const handlers = server.listeners('request');
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    const given = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    delete req.headers[TOKEN_HEADER];
    for (const h of handlers) h.call(server, req, res);
  });
  // nothing of this host is a WebSocket; an upgrade without the token is not
  // handed on either
  server.removeAllListeners('upgrade');
  server.on('upgrade', (_req, socket) => socket.destroy());
}

async function main() {
  const env = process.env;
  const token = env.ABAP2UI5_LOCAL_TOKEN || '';
  delete env.ABAP2UI5_LOCAL_TOKEN;
  if (token.length < 16) fail('no request token was handed in (ABAP2UI5_LOCAL_TOKEN)');
  const source = env.ABAP2UI5_LOCAL_SOURCE;
  if (!source || !fs.existsSync(source)) fail(`the source folder does not exist: ${source || '(none given)'}`);
  if (!env.A2UI5_MCP_WORKSPACE) fail('no workspace was handed in (A2UI5_MCP_WORKSPACE)');

  const dir = mcpServerDir(env);
  if (!dir) {
    fail(`@abap2ui5/mcp-server${env.ABAP2UI5_LOCAL_MCP_VERSION ? `@${env.ABAP2UI5_LOCAL_MCP_VERSION}` : ''} was not found on PATH - start this script through npx -p, or set ABAP2UI5_LOCAL_MCP`);
  }
  const missing = LIBRARY.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length) fail(`${dir} is no mcp-server this extension can drive: ${missing.join(', ')} missing`);
  const load = (f) => import(pathToFileURL(path.join(dir, f)).href);
  const [backend, host, unit] = await Promise.all(LIBRARY.map(load));
  for (const [mod, name] of [[backend, 'buildNpm'], [host, 'startHost'], [unit, 'collectObjects'], [unit, 'writeObjects']]) {
    if (typeof mod[name] !== 'function') fail(`${dir} exports no ${name} - this mcp-server version is not the one the extension was built against`);
  }
  log(`local backend: mcp-server ${dir}`);

  // 1. the objects, flattened
  const objects = unit.collectObjects([source]);
  if (!objects.some((o) => o.type === 'clas')) fail(`no *.clas.abap under ${source}`);
  const box = path.join(path.resolve(env.A2UI5_MCP_WORKSPACE), 'local-sources');
  fs.rmSync(box, { recursive: true, force: true });
  const { errors } = unit.writeObjects(objects, box);
  for (const [name, why] of Object.entries(errors)) log(`local backend: ${name} left out - ${why}`);
  log(`local backend: ${objects.length - Object.keys(errors).length} object(s) from ${source}`);

  // 2. the build
  const started = Date.now();
  const built = await backend.buildNpm({ inputDir: box, appsName: 'apps', withLint: false, onLine: log });
  if (!built.ok) fail(`the build failed: ${built.reason || 'no reason given'}`);
  log(`local backend: built against @abap2ui5/node-runtime ${built.version} in ${Date.now() - started} ms`);

  // 3. + 4. the host, with the token in front
  const port = await portToUse(Number(env.ABAP2UI5_LOCAL_PORT || 0));
  const { server, banner } = await host.startHost({ dir: built.dir, port, host: HOST });
  requireToken(server, token);
  const addr = server.address();
  const bound = addr && typeof addr === 'object' ? addr.port : port;
  process.stdout.write(`${READY}${JSON.stringify({ port: bound, runtime: built.version, banner })}\n`);

  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.resume();
}

process.on('SIGTERM', () => process.exit(0));
main().catch((e) => fail((e && (e.code === 'EADDRINUSE' ? e.message : e.stack)) || e));
