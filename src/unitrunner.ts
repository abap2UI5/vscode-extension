import * as path from "path";
import { shellSafe } from "./childproc";

/*
 * "Run Unit Tests (No System)" - the decisions behind the command, without
 * `vscode`: which program runs the app's ABAP Unit tests, with which
 * arguments, and what the terminal is told before the first line of output.
 *
 * The runner is mcp-server's `abap2ui5-unit` (scripts/ci-unit.mjs): the
 * framework at the release the project's abaplint.jsonc pins, its transpiled
 * backend, the classes deployed into it, the tests run through the open-abap
 * runtime. app-template ships it as `npm run test:unit` and as the `unit` job
 * of its check.yml; this is the same runner for the editor, so a project made
 * from the template and a class opened in it hear the same verdict.
 *
 * Resolution follows the ladder the MCP registration (mcp.ts) and the render
 * gate (checkcore.ts) use for a local checkout: a `mcp-server` checkout under
 * `abap2ui5.mcp.reposRoot` - under any name the repository has carried - runs
 * from disk, and only when there is none does npx fetch the published package.
 * A user who pointed reposRoot at their clones on purpose must get those
 * clones, never the network copy without a word.
 */

/** Everything the resolution reads - handed in, so the decision needs
 *  neither settings nor a filesystem. */
export interface UnitRunnerInput {
  /** The `abap2ui5.mcp.reposRoot` setting. */
  reposRoot: string;
  /** The directory names an mcp-server checkout can carry (SERVER_DIRS). */
  serverDirs: readonly string[];
  exists: (file: string) => boolean;
}

/** Where the runner came from - said in the terminal's first lines. */
export type UnitRunnerSource = "local checkout" | "npx";

export interface UnitRunner {
  cmd: string;
  args: string[];
  source: UnitRunnerSource;
}

/** The runner's path inside an mcp-server checkout - also the package's
 *  `abap2ui5-unit` bin. */
const RUNNER_SCRIPT = path.join("scripts", "ci-unit.mjs");

/**
 * The program that runs the tests: `node <checkout>/scripts/ci-unit.mjs` for
 * an mcp-server checkout under the repos root, otherwise
 * `npx --yes -p @abap2ui5/mcp-server abap2ui5-unit` - the published package,
 * deliberately unpinned for the same reason mcp.ts leaves the server
 * unpinned: its compatibility is with the framework it clones, not with this
 * extension.
 */
export function resolveUnitRunner(input: UnitRunnerInput): UnitRunner {
  const root = input.reposRoot.trim();
  if (root) {
    for (const dir of input.serverDirs) {
      const script = path.join(root, dir, RUNNER_SCRIPT);
      if (input.exists(script)) {
        return { cmd: "node", args: [script], source: "local checkout" };
      }
    }
  }
  return {
    cmd: "npx",
    args: ["--yes", "-p", "@abap2ui5/mcp-server", "abap2ui5-unit"],
    source: "npx",
  };
}

/** The class a file on disk belongs to, lower-cased the way the runner
 *  compares it - for the class itself and for its test include, so the
 *  command works from either editor. Undefined for anything else. */
export function classOfFile(file: string): string | undefined {
  const m = /^(.+?)\.clas(?:\.testclasses)?\.abap$/i.exec(path.basename(file));
  return m ? m[1].toLowerCase() : undefined;
}

/** The test include that would sit next to a class file, by the runner's
 *  convention (`<class>.clas.testclasses.abap`) - undefined for a file that
 *  is not a class's main source. */
export function testIncludeFor(classFile: string): string | undefined {
  if (!/\.clas\.abap$/i.test(classFile) || /\.clas\.testclasses\.abap$/i.test(classFile)) {
    return undefined;
  }
  return classFile.replace(/\.clas\.abap$/i, ".clas.testclasses.abap");
}

/** What one run is asked to do. */
export interface UnitRunRequest {
  /** The workspace folder the terminal runs in - the runner reads the
   *  project's abaplint.jsonc there for the framework pin. */
  cwd: string;
  /** The class to run alone, as its file on disk (the class or its test
   *  include) - when the command was invoked on one. */
  classFile?: string;
  /** The abap2UI5 checkout under the repos root (what A2UI5_HOME names),
   *  when there is one. */
  home?: string;
  exists: (dir: string) => boolean;
}

/** The directory the runner walks, relative to the cwd where that reads
 *  well: `src` for a class under the project's src (or when no class is
 *  named and there is one), the class's own folder otherwise, `.` for a
 *  project without a src. Absolute only for a class outside the folder. */
function pathArgument(req: UnitRunRequest): string {
  const src = path.join(req.cwd, "src");
  const relative = (dir: string): string => {
    const rel = path.relative(req.cwd, dir);
    if (rel === "") {
      return ".";
    }
    return rel.startsWith("..") || path.isAbsolute(rel) ? dir : rel;
  };
  if (req.classFile) {
    const dir = path.dirname(req.classFile);
    const underSrc = path.relative(src, dir);
    if (underSrc === "" || (!underSrc.startsWith("..") && !path.isAbsolute(underSrc))) {
      return relative(src);
    }
    return relative(dir);
  }
  return req.exists(src) ? relative(src) : ".";
}

/**
 * The runner's arguments: the folder to walk, `--class` when one class is
 * meant, `--home` when the repos root holds the framework. The same shape
 * `npm run test:unit` has in a project from app-template (`abap2ui5-unit
 * src`), so what the terminal shows is what the README teaches.
 */
export function unitTestArgs(req: UnitRunRequest): string[] {
  const args = [pathArgument(req)];
  const cls = req.classFile ? classOfFile(req.classFile) : undefined;
  if (cls) {
    args.push("--class", cls);
  }
  if (req.home) {
    args.push("--home", req.home);
  }
  return args;
}

/**
 * The one line sent to the terminal, quoted for the platform's shell - the
 * program too. A workspace under `C:\Users\John Smith\` is the normal shape
 * on Windows, and an unquoted path there arrives as two arguments.
 */
export function unitTestCommandLine(
  runner: UnitRunner,
  args: readonly string[],
  platform: NodeJS.Platform
): string {
  const safe = shellSafe(runner.cmd, [...runner.args, ...args], platform);
  return [safe.cmd, ...safe.args].join(" ");
}

/**
 * What the terminal says before the runner's first line: which program was
 * resolved and where the framework comes from. The second matters most the
 * first time - without an abap2UI5 checkout under the repos root the runner
 * clones the release the project pins into ~/.abap2ui5-mcp and builds or
 * downloads its backend, which takes minutes once and seconds afterwards.
 * Said up front, a quiet terminal reads as "working", not as "hung".
 */
export function unitTestBanner(runner: UnitRunner, home: string | undefined): string[] {
  const program =
    runner.source === "local checkout"
      ? `${runner.args[0]} (mcp-server checkout under abap2ui5.mcp.reposRoot)`
      : "@abap2ui5/mcp-server through npx (no mcp-server checkout under abap2ui5.mcp.reposRoot)";
  const framework = home
    ? `framework: ${home}`
    : "framework: no abap2UI5 checkout under abap2ui5.mcp.reposRoot - the runner " +
      "clones the release the project pins into ~/.abap2ui5-mcp and builds or " +
      "downloads its backend, which is slow the first time and cached afterwards";
  return [`abap2UI5 unit tests - runner: ${program}`, framework];
}
