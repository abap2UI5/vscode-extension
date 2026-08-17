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
// The status bar's one line
// ---------------------------------------------------------------------------

export interface FindingCounts {
  errors: number;
  warnings: number;
  hints: number;
  /** How many of them `fixAll` would correct mechanically. */
  fixable: number;
}

/**
 * What the status bar says about the current file.
 *
 * The Problems panel already lists the findings - mixed in with whatever the
 * ABAP extension, the XML language server and everything else reports, which
 * is exactly why a count of OUR findings is worth one line: it answers "is
 * this file clean?" without opening a panel and reading it.
 *
 * Clean says so out loud rather than going blank. A silent status bar is
 * indistinguishable from a check that is not running, and "did it even look at
 * this file?" is the question the check's own absence would raise.
 */
export function findingsBarText(counts: FindingCounts): string {
  const { errors, warnings, hints, fixable } = counts;
  const total = errors + warnings + hints;
  if (!total) {
    return "$(check) abap2UI5";
  }
  const parts = [
    errors ? `$(error) ${errors}` : "",
    warnings ? `$(warning) ${warnings}` : "",
    hints ? `$(info) ${hints}` : "",
    fixable ? `$(wrench) ${fixable}` : "",
  ].filter(Boolean);
  return parts.join(" ");
}

/** The sentence under it - the counts spelled out, plus what a click does. */
export function findingsBarTooltip(counts: FindingCounts): string {
  const { errors, warnings, hints, fixable } = counts;
  const total = errors + warnings + hints;
  if (!total) {
    return "abap2UI5 view check: nothing found in this file.";
  }
  const spelled = [
    errors ? `${errors} error${errors === 1 ? "" : "s"}` : "",
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
    hints ? `${hints} hint${hints === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return (
    `abap2UI5 view check: ${spelled.join(", ")}.` +
    (fixable
      ? ` ${fixable} of them can be corrected mechanically.`
      : " None of them can be corrected mechanically.")
  );
}

// ---------------------------------------------------------------------------
// The screenshot run behind the systemless preview
// ---------------------------------------------------------------------------

/** A viewport as the CLI takes it - or a comma-separated list of them, which
 *  is the device matrix: `1280x900`, `390x844,1280x900`. */
export const VIEWPORT_RE = /^\d{2,5}x\d{2,5}(?:\s*,\s*\d{2,5}x\d{2,5})*$/i;
/** A UI5 theme name - a resource path inside the runtime, so an identifier. */
const THEME_RE = /^[a-z][a-z0-9_]*$/i;

export interface ScreenshotRequest {
  /** The file to photograph - the scratch copy of the buffer. */
  target: string;
  /** Where the PNG goes; several views number the name from here. */
  out: string;
  theme: string;
  viewport: string;
  /** Preview data file - the model the picture is rendered with. */
  model?: string;
}

/**
 * The linter call behind the preview. A bad theme or viewport falls back to
 * the CLI's own default rather than being passed on: the CLI would refuse the
 * whole run (exit 2), and a settings typo must not turn the preview into an
 * error message about argument syntax.
 */
export function screenshotArgs(request: ScreenshotRequest): string[] {
  const args = [request.target, "--screenshot", request.out];
  if (THEME_RE.test(request.theme)) args.push("--screenshot-theme", request.theme);
  if (VIEWPORT_RE.test(request.viewport)) {
    args.push("--screenshot-size", request.viewport.replace(/\s+/g, ""));
  }
  if (request.model) args.push("--screenshot-model", request.model);
  return args;
}

/**
 * What one written picture is OF, read back from the name the CLI gave it.
 *
 * The CLI names its files rather than reporting a structure - one path per
 * line is the whole machine contract - so the viewport and the document index
 * come back out of the name. Anything unrecognised keeps the bare file name,
 * which is still a truthful label.
 */
export function shotLabel(file: string, sizes: number): string {
  const name = file.replace(/^.*[\\/]/, "").replace(/\.png$/i, "");
  const size = /-(\d{2,5}x\d{2,5})$/.exec(name);
  const rest = size ? name.slice(0, -size[0].length) : name;
  const doc = /-(\d+)$/.exec(rest);
  const parts = [
    size && sizes > 1 ? size[1] : "",
    doc ? `view ${doc[1]}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${name}.png`;
}

/** How many viewports a `viewport` setting asks for. */
export function viewportCount(viewport: string): number {
  return VIEWPORT_RE.test(viewport) ? viewport.split(",").length : 1;
}

/** The written PNG paths - the CLI prints those and nothing else on stdout,
 *  which is the whole machine contract of `--screenshot`. */
export function parseScreenshotOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\.png$/i.test(line));
}

/**
 * Whether the resolved checker is simply too old to know the flag. The pinned
 * render gate is a release behind the linter's main branch for most of its
 * life, so "it does not do that yet" is a NORMAL state here and deserves the
 * one message that helps (update the gate) rather than the CLI's usage text.
 */
export function screenshotUnsupported(stderr: string): boolean {
  return /unknown option '--screenshot/.test(stderr);
}

/** The render errors the CLI reported alongside the pictures. They arrive on
 *  stderr as `abap2ui5lint: <file> - <what>`; the file is the scratch copy and
 *  says nothing to the reader, so only the message survives. */
export function parseScreenshotErrors(stderr: string): string[] {
  const out: string[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    const hit = /^abap2ui5lint: .*? - (.+)$/.exec(line.trim());
    if (hit) out.push(hit[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// What "fix all" would do
// ---------------------------------------------------------------------------

export interface PlannedFix {
  start: number;
  end: number;
  text: string;
}

/**
 * Every mechanical fix of a set of findings, as one ordered, non-overlapping
 * list - what a "fix all" run applies, and therefore also what the code lens
 * counts before anything is applied.
 *
 * Overlapping spans are left for the next run rather than resolved by
 * guesswork: the same rule the CLI's `--fix` follows, which is why both are
 * expected to be run until they report nothing. Zero-length insertions at the
 * position the previous fix ended still make it in - they touch nothing that
 * was already rewritten.
 */
export function plannedFixes(
  findings: Array<{ fixes?: PlannedFix[] }>
): PlannedFix[] {
  const planned: PlannedFix[] = [];
  let cursor = 0;
  const all = findings
    .flatMap((f) => f.fixes ?? [])
    .sort((a, b) => a.start - b.start || a.end - b.end);
  for (const fix of all) {
    if (fix.start < cursor) {
      continue;
    }
    planned.push(fix);
    cursor = fix.end;
  }
  return planned;
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
