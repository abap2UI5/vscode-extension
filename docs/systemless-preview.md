# Systemless preview: spike for T13 and T12

Research for ROADMAP **T13 step 1** (can the transpiled backend serve a
project folder over HTTP, so the extension can treat it as a system
profile?) and the **T12 spike** (can the same backend run in a browser host
such as vscode.dev or BAS in the browser?). No source was changed. Measured
on 2026-11-11 with Node v22.23.4, `@abap2ui5/mcp-server@1.0.0` (unpacked
read-only) and `@abap2ui5/node-runtime@1.148.0` (the registry's latest).
Everything not measured here is marked *(verify)*.

## Summary

| Task | Recommendation | Why, in one line |
| --- | --- | --- |
| T13 | **Go** | A project folder was transpiled against the published runtime in 9 s (6 s for a rebuild), served on loopback in under 1 s, and answered a start and an event roundtrip whose handler saw the posted model value. Everything F9 needs exists; only a supported entry point is missing upstream. |
| T12 | **No-go for now** (revisit after T13) | The runtime can run in a browser - abap2UI5-web proves it - but the extension would need the ABAP transpiler in the browser as well (~6 MB unpacked before its libraries), a webview CSP with `wasm-unsafe-eval` and probably `unsafe-eval`, a fetch shim in the frontend, and ~1.7 MB gzip of runtime fetched on demand and pinned. That is a second preview stack for a minority host, and it depends on what T13 settles first. |

T13 in one picture: the extension runs a build of the folder and then
`node npm-host.mjs <runtime dir>` on `127.0.0.1:<port>`. The existing auth
proxy (`proxy.ts`) sits in front of it with its token, so F9, the
inspector, the live model and the traffic log run unchanged. The upstream
work is a `serve` binary in mcp-server: it should collect a folder the way
`abap2ui5-unit` does, report the port it actually bound, and accept a
token.

## 1. T13 - the backend over HTTP for a project folder

### 1.1 How mcp-server starts the backend today

Paths are relative to the `@abap2ui5/mcp-server@1.0.0` package root.

- **Two backends, picked per call.** `backendKind()` returns `checkout`
  when an abap2UI5 checkout resolves, and `npm` otherwise, which is the
  default on a machine without a checkout (`lib/runtime.mjs:55-100`,
  `decideBackend` at `:91`).
- **There is an HTTP server.** `startBackend()` (`lib/runtime.mjs:1944`)
  spawns a child process with `process.execPath`:
  - npm backend: `node lib/npm-host.mjs <runtime dir>`
    (`lib/runtime.mjs:1969`);
  - checkout: `node <a2>/node/srv/express.mjs` (`:1975`).

  It waits for the line `Listening on` on stdout, then polls the port
  (`waitPort(PORT)`, `:2049`), then requires the child to stay up for
  500 ms (`LIVENESS_MS`).
- **Port and host.** The port is `A2UI5_MCP_PORT`, default 3000
  (`lib/runtime.mjs:178`). The host is always `127.0.0.1` (`BACKEND_HOST`,
  `:189`). The child's environment is an allowlist that sets `PORT` and
  `HOST` (`backendEnv`, `:2153`; `CHILD_ENV_ALLOW` above it).
- **Path.** Root: `http://127.0.0.1:<port>/?app_start=<CLASS>`
  (`appStartUrl`, `:192`). run_app's Chromium opens that URL;
  `app_start`/`app_act` POST the JSON protocol to the same origin
  (`lib/appclient.mjs:8-12`, `:265`, `:1076`).
- **The host process.** `lib/npm-host.mjs` resolves
  `@abap2ui5/node-runtime` from the runtime directory, not from mcp-server
  (`:109-113`). It imports `<dir>/apps/init.mjs` if that file exists,
  otherwise it boots the framework alone (`:115-124`). It then calls the
  release's `serve({ port, host })` or
  `createApp()` + `compress()` (`:126-156`), and wraps everything in a
  check that answers only a loopback `Host`/`Origin` (`:49-80`). The
  usage line in the file: `node lib/npm-host.mjs <runtime dir>   (PORT from the environment)`
  (`:7`, `:180-195`).
- **The build.** `buildNpm({ inputDir, appsName })`
  (`lib/npm-backend.mjs:1128`):
  1. installs `@abap2ui5/node-runtime`, `@abaplint/transpiler-cli` at the
     version the release records, and `express` into
     `<workspace>/runtime/<version>`, with `--ignore-scripts` (`:695-770`);
  2. `git fetch`es open-abap-core at the commit the release records
     (`:804`);
  3. transpiles `inputDir` against the package's `downport/` and
     open-abap-core (`transpileConfig`, `:482`; `buildApps`, `:943`);
  4. keeps only the dev objects in `<runtime dir>/<appsName>`.

  The workspace is `A2UI5_MCP_WORKSPACE`, default `~/.abap2ui5-mcp`
  (`lib/repos.mjs:50`).
- **The frontend.** The backend's GET answer is the whole UI5 frontend
  from the same commit (node-runtime `README.md:24-26`). UI5 itself comes
  from the CDN:
  `cs_config-src = https://sdk.openui5.org/resources/sap-ui-cachebuster/sap-ui-core.js`
  (node-runtime `downport/01/04/z2ui5_cl_ui5_user_exit.clas.abap:288`).
  The page carries its own CSP meta tag, which allows the UI5 CDN hosts,
  `'wasm-unsafe-eval'` in `script-src` and `worker-src 'self' blob:`
  (measured below).
- **Is there an entry point a caller outside mcp-server can start for a
  folder?** Only in parts:
  - `lib/npm-host.mjs` is a runnable program, but it serves a *runtime
    directory*, not a folder, and only the fixed `apps/` inside it
    (`:115`).
  - `buildNpm` is an exported function, not a bin. The package has no
    `exports` map, so a deep import works, but that is no contract
    *(verify with the maintainer)*.
  - `buildApps` reads only the top level of `inputDir`
    (`fs.readdirSync(inputDir)`, `:961`). An abapGit project with
    sub-packages (`src/01/...`) would lose objects.
    `scripts/ci-unit.mjs` handles this: `collectObjects` (`:110`) walks the
    tree and copies the objects into a flat `unit-<pid>-` sandbox (`:374`).
  - The MCP `backend` tool (`server.mjs:1650`) starts and stops only the
    server's own sandbox.

  So there is **no serve entry point for a project folder**. That is the
  upstream task the roadmap expected.

### 1.2 node-runtime, measured

`npm view @abap2ui5/node-runtime` returns:

- versions 1.145.0, 1.146.0, 1.147.0 and 1.148.0 (latest);
- bin `abap2ui5-own-apps`, `abap2ui5-transpile` - no serve bin;
- dependencies `@abaplint/runtime 2.14.5`, `@abaplint/database-sqlite 2.13.83`;
- optional peer `express ^4.21.0 || ^5.0.0`; engines `node >=22`;
- `dist.unpackedSize` 14,970,048 bytes, 1126 files;
- SLSA provenance attestation and registry signatures present.

`package.json` records `abap2ui5.commit` 610d9ae0, transpiler 2.14.5 and
openAbapCore 9c1271ba. The entry `srv/host.mjs` exports `serve`,
`createApp`, `createHandler`, `initialize`, `hostGuard`, `exclusive` and
`withSession` (`srv/host.d.ts`).

### 1.3 Round trip, proven locally

All commands ran under the session scratchpad directory, which is
abbreviated `$S` below. Everything was removed afterwards (section 6).

**Framework only, no build.**

```
mkdir $S/nr-run && cd $S/nr-run && echo '{"name":"nr-run","private":true}' > package.json
npm install --ignore-scripts --no-audit --no-fund @abap2ui5/node-runtime@1.148.0 express@5
#   added 72 packages in 3s; node_modules 55 MB (sql.js 30 MB, @abap2ui5 18 MB)
PORT=38917 node $S/mcp/package/lib/npm-host.mjs $S/nr-run &
#   abap2ui5 npm host: @abap2ui5/node-runtime 1.148.0 from ...; 0 dev module(s);
#   accelerate: on; compression: on (the release's compress export)
#   Listening on 38917
curl http://127.0.0.1:38917/                       # 200, 342,499 bytes text/html, 76 ms
curl -X POST -H 'content-type: application/json' -H 'sap-contextid-accept: header' \
  http://127.0.0.1:38917/ --data '{"value":{"S_FRONT":{"ORIGIN":"http://127.0.0.1:38917",
  "PATHNAME":"/","SEARCH":"?app_start=Z2UI5_CL_UI5_APP_HI_WORLD"}}}'
#   200 {"S_FRONT":{"APP":"Z2UI5_CL_UI5_APP_HI_WORLD","ID":"D303...","S_ACTION":{"T_SYSTEM":
#   [["VIEW_SLOTS","display","MAIN","<mvc:View ...><Input value=\"{/NAME}\"/>
#   <Button text=\"Post\" press=\".eB(['BUTTON_POST'])\"/>..."]]}},"MODEL":{"NAME":""}}
curl -X POST ... --data '{"value":{"S_FRONT":{"ID":"<ID>","EVENT":"BUTTON_POST","T_EVENT_ARG":[]},
  "MODEL":{"NAME":"Ada"}}}'
#   200 {"S_FRONT":{...,"S_ACTION":{"T_CUSTOM":[["MESSAGE_BOX","show","Your name is Ada",...]]}}}
```

**The host guard, probed on the same server.**

| Request | Status |
| --- | --- |
| `Host: evil.example` | 403 |
| `Origin: https://evil.example` | 403 |
| `Origin: vscode-webview://abc` | 403 |
| `/anything/at/all` | 200 |

The backend has **no token and answers every path**.

**A project folder, then a rebuild.** The folder held one class,
`zcl_local_demo` (the framework's hello-world app, renamed) with its
`.clas.xml`. `build.mjs` is a three-line driver that imports mcp-server's
`buildNpm` and calls it with
`{ inputDir: argv[2], appsName: 'apps', withLint: false }`.

```
A2UI5_MCP_WORKSPACE=$S/t13ws node build.mjs $S/t13proj/src
#   npm install ... (73 packages, 2s); git fetch open-abap-core 9c1271ba;
#   transpile: 1 dev object(s) ... Output files: 1184 written;
#   apps/ holds 1 dev module(s) - 769 framework modules left out
#   ok: true, 9000 ms (first build, cold workspace); runtime dir 62 MB, open-abap-core 5.1 MB
# edit the class (message text), build again:            ok: true, 6017 ms
PORT=38918 node $S/mcp/package/lib/npm-host.mjs $S/t13ws/runtime/1.148.0 &
#   ...; 1 dev module(s) (zcl_local_demo.clas.mjs) ... Listening on 38918   (942 ms to listen)
POST app_start=ZCL_LOCAL_DEMO -> view; POST event BUTTON_POST with MODEL {"NAME":"Ada"}
#   -> ["MESSAGE_BOX","show","Local says Ada"]     (the edited text: the rebuild arrived)
GET /?app_start=ZCL_LOCAL_DEMO -> 200, 342,499 bytes
```

This meets the acceptance criteria of T13 at the protocol level. A class
from a folder starts, and an event reaches its handler with the changed
attribute. Showing it in the extension's real webview and F9 needs the
implementation *(verify)*.

### 1.4 What this means for the extension

- **The proxy works without change.** `SapProxy.prepareForwardHeaders`
  sets `Host` to the target's host and rewrites `Origin`/`Referer` to the
  target origin (`src/proxy.ts`, around line 713). The request therefore
  passes the backend's loopback guard. Without the proxy the webview's
  origin is refused (403, above).
- **The webview's CSP is unchanged.** The preview webview already allows
  `frame-src http: https:` (`src/webviewpreview.ts:63`). The app runs in
  the iframe on the proxy's origin, and the page's own CSP lets it load UI5
  from the CDN, exactly as against a system.
- **No ADT.** The local profile has no class state, no activation and no
  Ctrl+F3. F9 means "rebuild the folder, restart the host, reload": about
  6 s plus 1 s, measured above. The host must restart because it imports
  `apps/init.mjs` once (`lib/npm-host.mjs:115-118`). Hot reload in a
  running host was not tested *(verify)*.
- **First use needs the network.** The first build needs the npm registry
  and `git` with access to github.com (the open-abap-core fetch,
  `lib/npm-backend.mjs:804`). That is the same requirement *Run Unit Tests
  (No System)* has today.

## 2. T12 - the backend in a browser host

### 2.1 What the runtime needs from Node

- **`@abaplint/runtime@2.14.5`.** The only external require is
  `temporal-polyfill`. Node use is limited to:
  - `Buffer.from/allocUnsafe` (`build/src/types/hex_uint8.js:109`,
    `types/field_symbol.js:70-108`, `operators/_bit_operations.js:19`,
    `builtin/index.js:92-93`);
  - `process.stdout.write` in `console/standard_out_console.js:10`.

  A `Buffer` polyfill covers it.
- **The transpiled framework and open-abap-core**
  (`node-runtime/output/`), dynamic imports only:
  - `crypto` in 5 modules (`cl_system_uuid.clas.mjs:51`,
    `cl_abap_message_digest`, `cl_abap_hmac`, `cl_sec_sxml_writer`,
    `openabap.fugr`);
  - `zlib` in 3 (`cl_abap_gzip`);
  - `http`/`https` in `cl_http_client`;
  - `net`/`tls` in `cl_apc_tcp_client_manager`;
  - `fs`/`path`/`url` in `zw3mi.fugr.mjs:46-48` and `:96-98` (MIME
    repository);
  - `util` in `cl_abap_conv_in_ce` as a fallback only.

  Plus 21 `Buffer.from` and 1 `Buffer.concat`. A UUID, which every draft
  needs, goes through node `crypto`. In a browser that needs a shim to
  `crypto.randomUUID`/Web Crypto *(verify which calls)*.
- **The database.** `@abaplint/database-sqlite` uses `sql.js` (SQLite as
  wasm, `node-runtime/setup/setup.mjs`), which has browser builds
  (`sql-wasm-browser.js` + `.wasm`).
- **The host layer** (`srv/hostcore.mjs:185-186`) imports `node:crypto`
  and `node:http`. A browser would call the shim
  (`cl_express_icf_shim`) directly with a request object, as abap2UI5-web
  does.

### 2.2 The existing browser build: abap2UI5-web

The abap2UI5 organisation has **abap2UI5-web**
(<https://github.com/abap2UI5/abap2UI5-web>). Its live demo is
<https://abap2ui5.github.io/web-abap2UI5-build/>. Per its README, it:

1. downports and transpiles the framework with express-icf-shim;
2. bundles backend and database with webpack into one `app.bundle.js`;
3. uses sql.js as the database;
4. at runtime, issues "an in-memory HTTP GET" against the backend and
   `document.write`s the answer;
5. strips the backend's CSP meta tag because it "would break the
   wasm/eval-based in-browser runtime".

Its README also notes a limitation: `check_on_init( )` is always false in
that build. The repository itself could not be opened through the session's
GitHub access; the README was read through the web.

What the downloaded bundle shows:

```
curl https://abap2ui5.github.io/web-abap2UI5-build/            # 245 bytes: <script src="app.bundle.js">
curl --compressed .../app.bundle.js   # 8,154,636 bytes raw, 791,366 transferred, 734,308 gzip -9
curl --compressed .../sql-wasm-browser.wasm   # 658,410 bytes raw, 325,266 transferred
```

The bundle intercepts the frontend's calls on the page itself:
`globalThis.fetch=(s,n)=>isBackendUrl(s)?backendFetch(s,n):g(s,n)`, where
`isBackendUrl` compares origin and pathname with `window.location`. There is
no service worker and no web worker. It holds 13 `eval(` and one
`new Function`, from bundled libraries *(verify whether any runs at
runtime)*.

**So the backend runs in the page's main thread, and the transpile happens
at build time, not in the browser.**

Other browser runners for transpiled ABAP:

- the transpiler playground, <https://transpiler.abaplint.org> (input must
  be 7.02 syntax);
- ABAP Dojo, <https://abap-dojo.pages.dev/docs/about.html> (transpiles in
  the browser and runs the result in a sandboxed iframe, per its own
  description).

Neither runs abap2UI5.

### 2.3 Sizes against the 5 MB `.vsix` gate

Unpacked size is `npm view <pkg> dist.unpackedSize`. The tarball is
`npm pack` into a new directory. "gzip" is `tar czf` of the installed
files.

| Piece | Unpacked | Tarball / gzip |
| --- | --- | --- |
| `@abap2ui5/node-runtime@1.148.0` | 14,970,048 | 1,549,035 tgz |
| - `output/` (transpiled framework + open-abap-core, 773 `.mjs`) | 11,303,476 | 987,903 gzip |
| - `downport/` (ABAP, needed to transpile an app against) | 4.4 MB | 625,427 gzip |
| `@abaplint/runtime@2.14.5` | 535,298 | 114,984 tgz |
| `temporal-polyfill@1.0.8` | 1,016,945 | 163,816 tgz |
| `sql.js@1.14.2` (whole package) | 31,270,696 | 9,443,490 tgz |
| - `sql-wasm.js` + `sql-wasm.wasm` only | 735,818 | 354,567 gzip |
| `@abaplint/database-sqlite@2.13.83` | 17,652 | 4,920 tgz |
| **Minimum to run** (output, srv, setup, runtime, polyfill, sql-wasm, sqlite driver) | ~13.6 MB | **1,656,769 gzip** |
| `@abaplint/transpiler@2.14.5` (to transpile the app in the browser) | 1,057,386 | - |
| `@abaplint/core@2.120.103` (its parser) | 4,720,341 | - |
| open-abap-core ABAP sources (type-check library) | 5.1 MB checkout | - |

The current `.vsix` is 834 KB against `MAX_VSIX_MB: 5`
(`.github/workflows/ci.yml:105`).

- **Runtime alone.** Bundling only the minimum to *run* would take the
  `.vsix` to ~2.5 MB. That is inside the gate, but it triples the package
  for a feature most installs (desktop) would not use.
- **Plus transpiling the user's class.** The browser would also need the
  transpiler, `@abaplint/core`, `downport/` and the open-abap-core
  sources. That is roughly 15 MB more unpacked *(verify after bundling and
  minifying)*, which does not fit.

**Conclusion:** the runtime has to be fetched on demand, pinned and
verified, as `rendergate.ts` does today. That means:

- an exact version;
- a SHA-256 or the npm `integrity` of the tarball, recorded at build time
  (like `LINTER_COMMIT`);
- refusing bytes that changed;
- caching the result in `globalStorage` through `workspace.fs`.

The registry tarball and jsDelivr both answer with
`access-control-allow-origin: *` (measured with `Origin: https://vscode.dev`),
so a web extension host can fetch them. Unpacking a `.tgz` in the browser
needs a gzip/tar reader in the web bundle (`DecompressionStream` + a small
tar parser) *(verify)*. Alternatively, upstream could publish a
pre-bundled single-file browser build with a checksum asset, like the
render gate's bundle.

### 2.4 Why no-go now

1. **No browser transpile.** abap2UI5-web transpiles at build time. Every
   F9 in vscode.dev would need the transpiler, `@abaplint/core` and both
   ABAP libraries in a worker. That is the biggest and least proven piece.
   Nobody in the ecosystem ships it for abap2UI5 *(verify)*.
2. **The frontend has to be patched.** In a webview the frontend's `fetch`
   must go to the backend through a shim (abap2UI5-web's trick) or a
   `postMessage` bridge. `proxy.ts`'s runtime hook does not exist in the
   web host. The inspector, live model and traffic log are wired through
   the desktop proxy (`src/proxy.ts`, `src/roundtrips.ts`) and would need a
   second implementation.
3. **The CSP gets looser.** The backend's own page asks for
   `'wasm-unsafe-eval'`, and abap2UI5-web strips the page CSP entirely.
   The preview webview today allows no scripts but its nonce. The trust
   decision (Restricted Mode, running workspace code) would have to be
   remade for the browser.
4. **The design depends on T13.** The local backend, the profile, the
   rebuild-on-F9 flow and the mock seeding are defined there.

**Revisit when:**

- T13 has shipped;
- upstream publishes a browser bundle of the runtime with a checksum;
- someone has measured a transpile of one class in a browser worker.

## 3. What a webview in a web host may load

- **Web extension host.** It runs in a browser Web Worker. Node globals
  are not available, child processes cannot be created, files go through
  `vscode.workspace.fs`, the code must be one file, and the runtime
  executes JavaScript and WebAssembly. Workers can be created through the
  `Worker` API. Fetched resources must allow CORS.
  <https://code.visualstudio.com/api/extension-guides/web-extensions>
- **Webview CSP.** The extension sets it as a `<meta>` tag. Local
  resources are allowed through `${webview.cspSource}`, `asWebviewUri` and
  `localResourceRoots`. Remote resources should be `https` only.
  <https://code.visualstudio.com/api/extension-guides/webview>
- **Workers in a webview.** Web Workers are supported "but … workers can
  only be loaded using either a `data:` or `blob:` URI", not from the
  extension folder, and worker scripts do not support `importScripts` or
  `import(...)`. The guide fetches the script, wraps it in a blob and
  passes the object URL to `new Worker` (same page). The CSP therefore
  needs `worker-src blob:`. The guide does not cover `worker-src` itself,
  service workers in webviews, or vscode.dev specifics *(verify; VS Code
  web serves webviews from a `vscode-cdn.net` origin)*.
- **UI5 from the CDN.** `https://sdk.openui5.org/resources/sap-ui-version.json`
  and `.../sap-ui-cachebuster/sap-ui-core.js` both answer with
  `access-control-allow-origin: *` (measured with
  `Origin: https://abc.vscode-cdn.net`). A webview CSP listing
  `https://sdk.openui5.org` in `script-src`/`connect-src`/`style-src`/`img-src`/`font-src`
  can therefore bootstrap UI5. The frontend's own CSP allows the hosts
  listed at `z2ui5_cl_ui5_user_exit.clas.abap:278-310`.
- **WebAssembly in a webview.** sql.js needs `'wasm-unsafe-eval'` in
  `script-src`. The backend's page already asks for it.

## 4. Proposed architecture for T13

```
 F9 (local profile)                         extension host (desktop)
 ──────────────────                         ────────────────────────
 localbackend.ts (vscode-free decisions) ── decides: binary ladder, workspace dir,
                                            port 0, token, readiness line
 localbackendview.ts (plumbing) ─ spawn ──► node <mcp-server>/abap2ui5-serve <folder>
                                             --workspace <globalStorage>/local-backend
                                             --port 0 --token <T_b>
                                             │ 1. collect + flatten objects (ci-unit's collectObjects)
                                             │ 2. buildNpm (runtime pinned to the project's framework pin)
                                             │ 3. npm-host: 127.0.0.1:<p>, loopback Host/Origin guard,
                                             │    requires header x-abap2ui5-token: <T_b>
                                             └─ stdout: "Listening on 127.0.0.1:<p>"
 SapProxy (proxy.ts, unchanged core) ◄────── target http://127.0.0.1:<p>,
   127.0.0.1:<q>/<T_p>/...                   AuthStrategy = LocalTokenStrategy (kind "local",
   + HttpOnly token cookie                   requestHeaders() = { "x-abap2ui5-token": T_b })
 webview iframe ── http://127.0.0.1:<q>/<T_p>/?app_start=<CLASS> ──► proxy ──► backend
```

### 4.1 Which process starts what

- **The extension host** spawns the backend through `childproc.ts`, with
  the same environment allowlist mcp-server uses (`appChildEnv`) - or by
  letting the serve binary apply it.
  - It never starts in Restricted Mode, because it runs the repository's
    code. The rule is the same as for unit tests.
  - One backend per window. The session owns it and `dispose()` kills the
    process tree.
- **Binary ladder** (the `resolveUnitRunner` pattern, `src/unitrunner.ts:55`):
  1. mcp-server's `scripts/serve.mjs` from a checkout under
     `mcp.reposRoot`;
  2. otherwise `npx --yes -p @abap2ui5/mcp-server@<pinned> abap2ui5-serve`
     *(name to be agreed upstream)*.
- **Workspace.** Use the extension's `globalStorage` as
  `A2UI5_MCP_WORKSPACE`. An MCP session's own `apps/` and `current.json`
  are then never replaced, because `npm-host` serves the fixed `apps/`.
  The cost is a second runtime install, ~62 MB per release.
- **F9 on the local profile:** save, rebuild with the same build call,
  restart the host, reload the iframe. The build is skipped when the
  folder's fingerprint is unchanged (`buildFingerprint`,
  `lib/npm-backend.mjs:280`).

### 4.2 Where the token goes

The AGENTS.md convention says every local listener carries a secret in its
path and refuses a non-loopback `Host`.

- **Proxy token (`T_p`).** The proxy stays the only listener the webview
  talks to and carries `T_p` in its path (`proxy.origin`), exactly as for a
  system. Nothing changes there.
- **Backend token (`T_b`).** The backend is a second listener.
  - Today it refuses a non-loopback `Host`/`Origin` (measured: 403), but it
    answers every path without a secret. Any local process could drive it
    and read app data.
  - The proposal is an upstream option that makes the host require a
    random `T_b` on every request. A header fits the proxy's
    `AuthStrategy` seam directly: a `LocalTokenStrategy` whose
    `requestHeaders()` returns it, with no change to `prepareForwardHeaders`.
  - A path prefix would also satisfy the letter of the convention. It
    depends on the frontend computing its POST URL from `location.pathname`
    *(verify)*.
  - `T_b` is created per start with `randomBytes(16)`, passed to the child
    in an environment variable rather than on the command line (argv is
    visible to every local user), and held only in memory.
- **The profile itself.** It is a synthetic entry, not something
  `abap2ui5.systems` can define.
  - Name: *Local (transpiled)*.
  - URL: computed per start.
  - Role: `development`.
  - No credentials; `ensureCertificateTrust` is skipped because the URL is
    http on loopback.

  A workspace must not be able to point a "local" profile at a host. The
  extension builds the profile and the user's settings cannot.

### 4.3 Mock data from `<class>.mock.json`

- **No seam today.** The backend has no hook to preset an app's
  attributes. The user-exit interface has only `set_config_http_get` and
  `set_config_http_post` (`downport/02/z2ui5_if_ui5_exit.intf.abap:113-120`).
- **What works without upstream.** After the start roundtrip, the
  extension posts one synthetic roundtrip with `MODEL` = the mock values
  for the paths the view binds. The test above showed a posted `MODEL`
  value reaching the attribute (`NAME` -> "Ada"). The limits:
  - it fills only bound attributes;
  - only through an event the app handles (`check_on_event` /
    `get_event`);
  - an app that recomputes the attribute overwrites it.

  So this is a fallback, and the view must say so.
- **Upstream proposal.** The serve binary accepts `--mock <dir>`. Before
  the first `main( )` of an app instance, the host sets the public
  attributes named in `<class>.mock.json` on it (structures and tables by
  name). The file shape is the one `src/mockgen.ts` writes.
  - When the app reads a table (`SELECT`) or calls a class the folder does
    not contain, the transpiled runtime raises.
  - The host should report that as "not available in the local backend:
    <object>" rather than a dump *(verify what the runtime raises:
    `unknownTypes: 'runtimeError'` in `transpileConfig`)*.
  - A `TABL` in the folder is created at boot (`tableSchema`,
    `lib/npm-backend.mjs:413`). Seeding its rows from a `<table>.mock.json`
    is a natural extension *(verify the wish upstream)*.

## 5. Upstream changes (abap2UI5/mcp-server unless noted)

1. **A `serve` binary** (e.g. `abap2ui5-serve [paths...] --port <n|0>
   --workspace <dir> [--framework X.Y.Z]`). It reuses `collectObjects` and
   the flattened sandbox of `scripts/ci-unit.mjs`, `buildNpm`, and
   `startHost` from `lib/npm-host.mjs`, then stays in the foreground until
   killed. Add it to `package.json` `bin` and `files`.
2. **Report the bound port.** `npm-host` takes `PORT` from the environment
   and prints `Listening on ${port}`, the requested port
   (`lib/npm-host.mjs:182`, `:189`). With port 0 it must print
   `server.address().port`. A machine-readable ready line (one JSON
   object) would remove a regex from the extension.
3. **A request token.** An environment variable naming a secret that every
   request must carry (header, or path prefix), checked in `loopbackOnly`
   before the release's handler, compared in constant time. The guard
   lives in node-runtime (`hostGuard`, `serve({ allowedHosts })`), so the
   option may belong there instead (abap2UI5/abap2UI5 `node/`)
   *(verify with the maintainer)*.
4. **A configurable apps directory for the host.** `npm-host` hard-codes
   `<dir>/apps/init.mjs` (`:115`). A second argument would let a serve run
   and an MCP session share one runtime install, as `buildNpm`'s `appsName`
   already allows for unit runs (`lib/npm-backend.mjs:1123-1127`).
5. **Rebuild without restart** (optional). Either a `POST /<token>/__rebuild`
   on the serve process or a documented "restart is the reload".
   Restart costs ~1 s, so a restart is acceptable for a first version.
6. **Mock seeding** (`--mock`, section 4.3), and a clear error for an
   object the local backend lacks.
7. **For T12 later** (abap2UI5/abap2UI5 `node/` or abap2UI5-web): a
   published browser bundle of the runtime with a checksum asset, and
   shims for `crypto`/`zlib`/`Buffer` in the open-abap-core modules listed
   in 2.1.

Until (1) to (3) are released, the extension could drive `buildNpm` and
`npm-host.mjs` by deep path from a pinned mcp-server checkout or package.
That works today (section 1.3), but it couples the extension to internals
and leaves the backend without a token. It is not recommended beyond a
prototype.

## 6. Cleanup

Nothing was installed in the repository.

- Every server started here was stopped with `kill`; `pgrep -af npm-host`
  reported nothing afterwards.
- The scratch directories (`nr-pack`, `nr-x`, `nr-run`, `t13proj`,
  `t13scripts`, `t13ws`, `webdemo`, host logs) were removed.
- The read-only mcp-server unpack was left as it was.
