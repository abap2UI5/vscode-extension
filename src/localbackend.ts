import { spawn, type ChildProcess } from "child_process";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { AuthStrategy, UnauthorizedVerdict } from "./authstrategy";
import { killTree, shellSafe } from "./childproc";
import { compareRelease, frameworkPinOf, releaseParts } from "./compat";
import { startingFolder } from "./agentsetup";

/*
 * The "Local (transpiled)" system - the decisions behind it, without
 * `vscode`: which program serves the workspace's classes, with which
 * environment, how its one readiness line is read, how it is stopped, and
 * when F9 may reuse the running one instead of building again.
 *
 * The program is `localbackend-host.mjs` (shipped next to the bundle), a
 * launcher around mcp-server's own library: abap2ui5-unit's object
 * collection, the npm backend's build and npm-host's server. mcp-server
 * 1.0.0 offers no `serve` entry point, so the launcher imports those modules
 * by path from an EXACTLY pinned version (package.json
 * `localBackend.mcpServer`) - docs/systemless-preview.md says why that is a
 * stop-gap. Resolution follows `resolveUnitRunner`: an mcp-server checkout
 * under `abap2ui5.mcp.reposRoot` first (used as it is - the user pointed the
 * root there on purpose), else `npx --yes -p @abap2ui5/mcp-server@<pin>`,
 * which installs the package into npm's own npx cache once and puts its
 * `node_modules/.bin` on the launcher's PATH - which is how the launcher
 * finds the package, at the pinned version only.
 *
 * The host binds 127.0.0.1 only, keeps npm-host's loopback Host/Origin
 * guard, and answers 404 to every request without the per-start token in
 * `x-abap2ui5-local-token`. Only the auth proxy (`proxy.ts`) knows the token
 * - through `LocalBackendAuth`, its `AuthStrategy` - so the webview, which
 * talks to the proxy alone, never sees it, and the proxy's own token in its
 * path stays the one secret the page carries.
 */

/** The npm package the launcher drives. */
export const MCP_SERVER_PACKAGE = "@abap2ui5/mcp-server";
/** The launcher's file name next to the bundle (esbuild.js copies it). */
export const LAUNCHER_FILE = "localbackend-host.mjs";
/** The header the host requires on every request. */
export const TOKEN_HEADER = "x-abap2ui5-local-token";
/** The two machine-readable lines the launcher prints on stdout. */
export const READY_PREFIX = "ABAP2UI5_LOCAL_READY ";
export const FAILED_PREFIX = "ABAP2UI5_LOCAL_FAILED ";
/** The first release of `@abap2ui5/node-runtime` on npm. */
export const FIRST_NPM_RUNTIME = "1.145.0";
/** How long a start may take: the first one installs ~60 MB of runtime and
 *  fetches open-abap-core; a rebuild is seconds. */
export const START_TIMEOUT_MS = 15 * 60_000;

/** The mcp-server files the launcher imports - what makes a directory a
 *  checkout it can drive. */
const LIBRARY_FILES = [
  path.join("lib", "npm-backend.mjs"),
  path.join("lib", "npm-host.mjs"),
  path.join("scripts", "ci-unit.mjs"),
];

// ---------------------------------------------------------------------------
// The proxy's side: the token as an AuthStrategy
// ---------------------------------------------------------------------------

/** A fresh request token - one per start of the host. */
export function newToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * How the auth proxy "logs on" to the local backend: no credentials, only
 * the per-start token in a header. Held in a `#private` field like
 * `BasicAuthStrategy`'s header, so it prints nowhere. A 401 means nothing
 * here (the host never asks for a logon), so it never trips the breaker.
 */
export class LocalBackendAuth implements AuthStrategy {
  readonly kind = "local";
  readonly #token: string;

  constructor(token: string) {
    this.#token = token;
  }

  requestHeaders(): Record<string, string> {
    return { [TOKEN_HEADER]: this.#token };
  }

  onUnauthorized(): UnauthorizedVerdict {
    return "ignore";
  }
}

// ---------------------------------------------------------------------------
// Which program
// ---------------------------------------------------------------------------

export interface LocalHostInput {
  /** The `abap2ui5.mcp.reposRoot` setting. */
  reposRoot: string;
  /** The directory names an mcp-server checkout can carry (SERVER_DIRS). */
  serverDirs: readonly string[];
  /** The exact mcp-server version this build is pinned to. */
  pin: string;
  /** The launcher's absolute path (next to the bundle). */
  launcher: string;
  exists: (file: string) => boolean;
  platform?: NodeJS.Platform;
}

export type LocalHostSource = "local checkout" | "npx";

/** The program line, and what the launcher is told about where mcp-server
 *  is. `shell` for npx on Windows, whose npx is a `.cmd`. */
export interface LocalHostCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  shell: boolean;
  source: LocalHostSource;
  /** The checkout, or the pinned package spec - for the log. */
  from: string;
}

/** Whether `dir` holds the mcp-server library the launcher imports. */
export function isMcpServerDir(dir: string, exists: (file: string) => boolean): boolean {
  return LIBRARY_FILES.every((file) => exists(path.join(dir, file)));
}

/** The ladder: a checkout under the repos root, else the pinned package. */
export function resolveLocalHost(input: LocalHostInput): LocalHostCommand {
  const root = input.reposRoot.trim();
  if (root) {
    for (const dir of input.serverDirs) {
      const checkout = path.join(root, dir);
      if (isMcpServerDir(checkout, input.exists)) {
        return {
          cmd: "node",
          args: [input.launcher],
          env: { ABAP2UI5_LOCAL_MCP: checkout },
          shell: false,
          source: "local checkout",
          from: checkout,
        };
      }
    }
  }
  const spec = `${MCP_SERVER_PACKAGE}@${input.pin}`;
  return {
    cmd: "npx",
    args: ["--yes", "-p", spec, "node", input.launcher],
    env: { ABAP2UI5_LOCAL_MCP_VERSION: input.pin },
    shell: (input.platform ?? process.platform) === "win32",
    source: "npx",
    from: spec,
  };
}

// ---------------------------------------------------------------------------
// Which folder, which framework release
// ---------------------------------------------------------------------------

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** The project a class file belongs to: the nearest folder holding a
 *  `.abapgit.xml`, up to the workspace folder; the workspace folder itself
 *  when there is none; the class's own folder outside every workspace. */
export function projectRootFor(
  classFile: string,
  workspaceRoot: string | undefined,
  exists: (file: string) => boolean
): string {
  let dir = path.dirname(classFile);
  if (!workspaceRoot || !isInside(workspaceRoot, dir)) {
    return dir;
  }
  for (;;) {
    if (exists(path.join(dir, ".abapgit.xml"))) {
      return dir;
    }
    if (path.relative(workspaceRoot, dir) === "") {
      return workspaceRoot;
    }
    const up = path.dirname(dir);
    if (up === dir) {
      return workspaceRoot;
    }
    dir = up;
  }
}

/**
 * The folder the launcher collects - the way abap2ui5-unit is pointed at a
 * project: `.abapgit.xml`'s STARTING_FOLDER, else `src`, else the project
 * root. A class outside that folder is built from its own folder instead, so
 * F9 never builds a folder the class is not in.
 */
export function sourceFolderFor(req: {
  projectRoot: string;
  classFile: string;
  abapgitXml?: string;
  exists: (file: string) => boolean;
}): { folder: string; from: string } {
  const starting = startingFolder(req.abapgitXml);
  let folder: string;
  let from: string;
  if (starting !== null) {
    folder = starting ? path.join(req.projectRoot, starting) : req.projectRoot;
    from = ".abapgit.xml STARTING_FOLDER";
  } else if (req.exists(path.join(req.projectRoot, "src"))) {
    folder = path.join(req.projectRoot, "src");
    from = "src (no .abapgit.xml)";
  } else {
    folder = req.projectRoot;
    from = "the project folder (no .abapgit.xml, no src)";
  }
  if (!isInside(folder, req.classFile)) {
    return { folder: path.dirname(req.classFile), from: `the class's own folder (it is not under ${folder})` };
  }
  return { folder, from };
}

/** The node-runtime release to build against: the project's framework pin
 *  (abaplint.jsonc) when the registry can have it, else none - mcp-server
 *  then takes the registry's latest - with a note that says so. */
export function runtimePinFor(abaplintJsonc: string | undefined): { version?: string; note?: string } {
  const pin = abaplintJsonc ? frameworkPinOf(abaplintJsonc).trim().replace(/^v/, "") : "";
  if (!pin) {
    return { note: "the project pins no framework release - building against @abap2ui5/node-runtime's latest" };
  }
  if (!releaseParts(pin)) {
    return { note: `the project pins the framework at "${pin}", which is no release - building against @abap2ui5/node-runtime's latest` };
  }
  if (compareRelease(pin, FIRST_NPM_RUNTIME) === -1) {
    return {
      note: `the project pins the framework at ${pin}; @abap2ui5/node-runtime exists from ${FIRST_NPM_RUNTIME} on - building against its latest`,
    };
  }
  return { version: pin };
}

/** What the launcher is started with: the environment of the extension host
 *  (npm, git and the proxy variables need it) plus its own variables. A
 *  `A2UI5_MCP_RUNTIME_VERSION` the user set is left as it is. */
export function launcherEnv(req: {
  base: NodeJS.ProcessEnv;
  command: LocalHostCommand;
  token: string;
  source: string;
  workspace: string;
  port?: number;
  runtime?: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...req.base, ...req.command.env };
  env.ABAP2UI5_LOCAL_TOKEN = req.token;
  env.ABAP2UI5_LOCAL_SOURCE = req.source;
  env.A2UI5_MCP_WORKSPACE = req.workspace;
  env.ABAP2UI5_LOCAL_PORT = String(req.port ?? 0);
  if (req.runtime && !req.base.A2UI5_MCP_RUNTIME_VERSION) {
    env.A2UI5_MCP_RUNTIME_VERSION = req.runtime;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Reading the launcher
// ---------------------------------------------------------------------------

export type LauncherLine =
  | { kind: "ready"; port: number; runtime: string; banner: string }
  | { kind: "failed"; reason: string };

/** One stdout line of the launcher - undefined for anything that is not one
 *  of its two lines (the transpiled runtime may print to stdout too). */
export function parseLauncherLine(line: string): LauncherLine | undefined {
  const text = line.replace(/\r$/, "");
  const json = (prefix: string): Record<string, unknown> | undefined => {
    if (!text.startsWith(prefix)) {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(text.slice(prefix.length));
      return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const ready = json(READY_PREFIX);
  if (ready) {
    const port = Number(ready.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      return { kind: "failed", reason: `the launcher reported no usable port (${String(ready.port)})` };
    }
    return {
      kind: "ready",
      port,
      runtime: typeof ready.runtime === "string" ? ready.runtime : "?",
      banner: typeof ready.banner === "string" ? ready.banner : "",
    };
  }
  const failed = json(FAILED_PREFIX);
  if (failed) {
    return { kind: "failed", reason: typeof failed.reason === "string" ? failed.reason : "no reason given" };
  }
  return undefined;
}

/** A start that did not end with a ready line - the reason, and the last
 *  lines of the launcher's log for the message. */
export class LocalBackendError extends Error {
  constructor(
    message: string,
    readonly logTail: string[] = []
  ) {
    super(message);
  }
}

/** A running host. */
export interface LocalHost {
  readonly port: number;
  readonly runtime: string;
  readonly banner: string;
  /** `http://127.0.0.1:<port>` - what the proxy forwards to. */
  readonly origin: string;
  /** False once the process ended, for whatever reason. */
  readonly alive: boolean;
  /** Resolves with the exit code once the process ended. */
  readonly exited: Promise<number | null>;
  /** Kills the launcher and everything it started. */
  stop(): void;
}

export interface StartOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Every line of the launcher's stderr (the build log) as it arrives. */
  onLog?: (line: string) => void;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

const TAIL_LINES = 12;

/** Splits a stream into lines, handing each complete one on. */
function lineReader(onLine: (line: string) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    rest += chunk;
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      onLine(rest.slice(0, at).replace(/\r$/, ""));
      rest = rest.slice(at + 1);
    }
  };
}

/**
 * Starts the launcher and resolves once it printed its ready line; rejects
 * with a `LocalBackendError` when it printed the failed line, exited first,
 * could not be started or took longer than `timeoutMs`. A child that did not
 * get ready is killed. Its stdin stays open: the launcher exits when it
 * closes, so a host whose extension host died does not outlive it.
 */
/** How long a failed start waits for the launcher to be gone before it
 *  reports the failure. */
const STOP_WAIT_MS = 5000;

export function startLocalHost(
  command: LocalHostCommand,
  options: StartOptions
): Promise<LocalHost> {
  const platform = options.platform ?? process.platform;
  const safe = command.shell
    ? shellSafe(command.cmd, command.args, platform)
    : { cmd: command.cmd, args: command.args };
  return new Promise<LocalHost>((resolve, reject) => {
    const tail: string[] = [];
    const remember = (line: string) => {
      tail.push(line);
      if (tail.length > TAIL_LINES) {
        tail.shift();
      }
    };
    let child: ChildProcess;
    try {
      child = spawn(safe.cmd, safe.args, {
        cwd: options.cwd,
        env: options.env,
        shell: command.shell,
        stdio: ["pipe", "pipe", "pipe"],
        // its own process group, so killTree reaches npx's children too
        detached: platform !== "win32",
        windowsHide: true,
      });
    } catch (err) {
      reject(new LocalBackendError(`could not start ${command.cmd}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let settled = false;
    let alive = true;
    const exited = new Promise<number | null>((done) => {
      child.on("close", (code) => {
        alive = false;
        done(code);
      });
    });
    const stop = () => {
      alive = false;
      killTree(child, platform);
    };
    const fail = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(limit);
      stop();
      // report once the launcher is really gone - on Windows taskkill runs
      // asynchronously, and a caller that cleans up (or starts the next
      // host) right away would find the old one still in its folder.
      // Bounded: a process that will not die does not hold the error back.
      const error = new LocalBackendError(message, [...tail]);
      void Promise.race([exited, new Promise((done) => setTimeout(done, STOP_WAIT_MS))]).then(() => reject(error));
    };
    const limit = setTimeout(
      () => fail(`the local backend was not ready after ${Math.round((options.timeoutMs ?? START_TIMEOUT_MS) / 1000)} s`),
      options.timeoutMs ?? START_TIMEOUT_MS
    );

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on(
      "data",
      lineReader((line) => {
        const parsed = parseLauncherLine(line);
        if (!parsed) {
          if (line.trim()) {
            remember(line);
            options.onLog?.(line);
          }
          return;
        }
        if (parsed.kind === "failed") {
          fail(parsed.reason);
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(limit);
        resolve({
          port: parsed.port,
          runtime: parsed.runtime,
          banner: parsed.banner,
          origin: `http://127.0.0.1:${parsed.port}`,
          get alive() {
            return alive;
          },
          exited,
          stop,
        });
      })
    );
    child.stderr?.on(
      "data",
      lineReader((line) => {
        remember(line);
        try {
          options.onLog?.(line);
        } catch {
          /* a listener's failure is not the launcher's */
        }
      })
    );
    // a launcher that is gone takes its stdin with it - not an error here
    child.stdin?.on("error", () => {});
    child.on("error", (err) => fail(`could not start ${command.cmd}: ${err.message}`));
    void exited.then((code) =>
      fail(`the local backend ended before it was ready (exit code ${code ?? "none"})`)
    );
  });
}

// ---------------------------------------------------------------------------
// When to build again
// ---------------------------------------------------------------------------

/** The files the launcher collects, by the name pattern abap2ui5-unit's
 *  `collectObjects` uses (classes, interfaces with includes and sidecars,
 *  tables, data elements). */
const OBJECT_FILE = /^[^.\s]+\.(clas|intf|tabl|dtel)(?:\.[a-z_]+)?\.(abap|xml)$/i;

/** A digest of every object file under `folder` - name, size and mtime -
 *  skipping `node_modules` and dot-directories the way the collection does.
 *  Changes when a file is saved, added or removed. */
export function sourceFingerprint(folder: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (OBJECT_FILE.test(entry.name)) {
        try {
          const st = fs.statSync(full);
          hash.update(`${full}\0${st.size}\0${st.mtimeMs}\n`);
        } catch {
          /* gone meanwhile */
        }
      }
    }
  };
  walk(folder);
  return hash.digest("hex");
}

/** What a running host was started for. */
export interface HostIdentity {
  /** The program line and folder - a change means another host. */
  key: string;
  /** `sourceFingerprint` of the folder at the start. */
  fingerprint: string;
}

/**
 * F9's decision on the local profile:
 * - `start` - nothing runs (or it died);
 * - `reuse` - the host runs for the same folder and program, and no object
 *   file changed since it was built: reload only, no build;
 * - `restart` - anything else: the folder changed (a save, a new class), or
 *   another folder/program is asked for. The npm host imports the built
 *   apps once at boot, so a rebuild is a restart (~1 s on top of the build).
 * `force` (a save on the local profile, Ctrl+F3) restarts a running host
 * even when the fingerprint did not move - the user asked for a rebuild.
 */
export function decideStart(
  running: (HostIdentity & { alive: boolean }) | undefined,
  wanted: HostIdentity,
  force = false
): "start" | "reuse" | "restart" {
  if (!running || !running.alive) {
    return "start";
  }
  if (!force && running.key === wanted.key && running.fingerprint === wanted.fingerprint) {
    return "reuse";
  }
  return "restart";
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** The launch template of a running host - `{class}` like a profile's. */
export function localTemplate(port: number): string {
  return `http://127.0.0.1:${port}/?app_start={class}`;
}

/**
 * The honest word about `<class>.mock.json` beside a class: the local
 * backend has no seam to preset an app's attributes before its first
 * `main( )` (docs/systemless-preview.md, 4.3), so the file is NOT applied -
 * the app starts with what its own code initialises. Undefined when there
 * is no such file.
 */
export function mockNote(classFile: string, exists: (file: string) => boolean): string | undefined {
  const mock = classFile.replace(/\.clas\.abap$/i, ".mock.json");
  if (mock === classFile || !exists(mock)) {
    return undefined;
  }
  return (
    `${path.basename(mock)} is not applied - the local backend has no way yet to preset an app's ` +
    "attributes; the app starts with what its own code initialises"
  );
}
