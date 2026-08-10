import * as path from "path";
import { usesBuilder } from "./abap";
import { VIEW_XML_RE } from "./gate";

/*
 * The `vscode`-free decisions behind the view check: what counts as
 * checkable, which command runs the external render gate, what its scratch
 * file must be called, and how its JSON report is read. `viewcheck.ts`
 * keeps the scheduling, the diagnostics and the process spawning - the
 * parts that need an editor - and asks here for everything that does not.
 */

/** Checkable = a view/fragment XML, or an ABAP source calling the generic
 *  builder's factory. "ABAP source" means the abap language id or an *.abap
 *  file name - ABAP extensions differ in what they register, but a log or
 *  markdown file merely QUOTING builder code must not qualify. */
export function isCheckableSource(
  fileName: string,
  languageId: string | undefined,
  text: string
): boolean {
  if (VIEW_XML_RE.test(fileName)) {
    return true;
  }
  if (languageId !== "abap" && !/\.abap$/i.test(fileName)) {
    return false;
  }
  return usesBuilder(text);
}

/** The checker is a CLI working on files, but the document may be unsaved or
 *  not a file on disk at all (the `adt` scheme of the ABAP remote
 *  filesystem) - so the buffer is written to a scratch file first. The name
 *  matters: the checker only looks at `*.clas.abap` and view/fragment XML. */
export function scratchFileName(fileName: string): string {
  const base = path.basename(fileName);
  if (VIEW_XML_RE.test(base) || base.endsWith(".clas.abap")) {
    return base;
  }
  return `${path.parse(base).name}.clas.abap`;
}

// ---------------------------------------------------------------------------
// The external checker command
// ---------------------------------------------------------------------------

export interface CheckerCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  /** true when there is a real local installation to run - false means the
   *  npx fallback, which needs npm on the machine */
  installed: boolean;
}

/** Everything the command resolution reads - handed in, so the decision
 *  itself needs neither settings nor a filesystem. */
export interface CheckerCommandInput {
  /** The `viewCheck.command` setting. */
  explicit: string;
  /** A render gate installed via "Install Render Gate", when present. */
  installedGate?: { cli: string; browsersPath: string };
  /** The `mcp.reposRoot` setting. */
  reposRoot: string;
  /** The checkout names probed under the repos root, `cli.mjs` inside. */
  checkoutDirs: readonly string[];
  exists: (file: string) => boolean;
}

/** The command used to run the external checker CLI for the render gate. An
 *  explicit setting wins; then a gate installed via "Install Render Gate";
 *  then a local linter checkout under the repos root (both run
 *  with VS Code's own Node.js); npx fetching from GitHub is the last
 *  resort. */
export function resolveCheckerCommand(input: CheckerCommandInput): CheckerCommand {
  const explicit = input.explicit.trim();
  if (explicit) {
    const [cmd, ...args] = explicit.split(/\s+/);
    return { cmd, args, env: {}, installed: true };
  }
  if (input.installedGate) {
    return {
      cmd: "node",
      args: [input.installedGate.cli],
      env: { PLAYWRIGHT_BROWSERS_PATH: input.installedGate.browsersPath },
      installed: true,
    };
  }
  const root = input.reposRoot.trim();
  if (root) {
    for (const dir of input.checkoutDirs) {
      const cli = path.join(root, dir, "cli.mjs");
      if (input.exists(cli)) {
        return { cmd: "node", args: [cli], env: {}, installed: true };
      }
    }
  }
  return {
    cmd: "npx",
    args: ["--yes", "github:abap2UI5/linter"],
    env: {},
    installed: false,
  };
}

/** The extension host often runs with a minimal PATH (a GUI-launched VS Code
 *  on macOS misses /usr/local/bin and the Homebrew prefix) - the usual reason
 *  spawning npx fails. Returns the PATH value to spawn with. */
export function augmentedPath(
  platform: NodeJS.Platform,
  currentPath: string | undefined
): string | undefined {
  if (platform === "win32") {
    return currentPath;
  }
  const parts = (currentPath ?? "").split(path.delimiter);
  for (const p of ["/usr/local/bin", "/opt/homebrew/bin"]) {
    if (!parts.includes(p)) {
      parts.push(p);
    }
  }
  return parts.join(path.delimiter);
}

// ---------------------------------------------------------------------------
// The render gate's report
// ---------------------------------------------------------------------------

export interface RenderResult {
  renderErrors: string[];
  skippedRender: boolean;
}

export type RenderReportParse =
  | { ok: true; result: RenderResult }
  | { ok: false; reason: "no-json" | "broken-json"; detail?: string };

/** Reads the render gate's stdout: the first `{` starts the JSON report
 *  (anything before it is npm/npx noise), `results[0]` carries the answer. */
export function parseRenderReport(stdout: string): RenderReportParse {
  const start = stdout.indexOf("{");
  if (start < 0) {
    return { ok: false, reason: "no-json" };
  }
  try {
    const report = JSON.parse(stdout.slice(start)) as {
      results?: Array<{ renderErrors?: string[]; skippedRender?: boolean }>;
    };
    const r = report.results?.[0];
    return {
      ok: true,
      result: {
        renderErrors: r?.renderErrors ?? [],
        skippedRender: r?.skippedRender ?? false,
      },
    };
  } catch (err) {
    return { ok: false, reason: "broken-json", detail: String(err) };
  }
}
