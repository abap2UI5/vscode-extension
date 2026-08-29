import * as path from "path";
import { usesBuilder } from "./abap";
import { frozenBuilderOf, VIEW_XML_RE } from "./gate";

/*
 * The `vscode`-free decisions behind the view check: what counts as
 * checkable, which command runs the external render gate, what its scratch
 * file must be called, and how its JSON report is read. `viewcheck.ts`
 * keeps the scheduling, the diagnostics and the process spawning - the
 * parts that need an editor - and asks here for everything that does not.
 */

/** Checkable = a view/fragment XML, or an ABAP source calling the generic
 *  builder's factory - or a frozen builder's, which the gate answers with the
 *  linter's own `frozen-view-builder` finding. "ABAP source" means the abap
 *  language id or an *.abap file name - ABAP extensions differ in what they
 *  register, but a log or markdown file merely QUOTING builder code must not
 *  qualify. */
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
  return usesBuilder(text) || frozenBuilderOf(text) !== undefined;
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

/**
 * A configured command line into program and arguments, honouring quotes.
 * Splitting on whitespace alone made every path with a space in it
 * unusable - `"C:\Program Files\nodejs\node.exe" cli.mjs` is the normal
 * shape of this setting on Windows, and it arrived as four broken pieces.
 */
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true; // `""` is an argument, empty as it is
      continue;
    }
    if (/\s/.test(ch)) {
      if (current || started) {
        parts.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
  }
  if (current || started) {
    parts.push(current);
  }
  return parts;
}

/**
 * One argument as the platform's shell swallows it. On Windows the checker is
 * spawned through cmd.exe (npx is a `.cmd`, which Node cannot exec directly),
 * and with `shell: true` Node hands the arguments over unquoted - so a scratch
 * file under `C:\Users\John Smith\AppData\...` arrived as two arguments and
 * the gate answered "no JSON" for everyone whose profile has a space in it.
 * `%` and `!` at least force the quotes; cmd.exe expands `%VAR%` even inside
 * them, which no quoting can prevent. Elsewhere the arg is single-quoted for
 * `sh` - the current callers only use a shell on Windows, but the contract of
 * `RunOptions.shell` is that BOTH platforms are safe.
 */
export function quoteForShell(arg: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    if (!/[\s&|<>^()"%!]/.test(arg)) {
      return arg;
    }
    return `"${arg.replace(/"/g, '""')}"`;
  }
  if (arg !== "" && !/[^\w@%+=:,./-]/.test(arg)) {
    return arg;
  }
  return `'${arg.replace(/'/g, "'\\''")}'`;
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
    const [cmd, ...args] = splitCommandLine(explicit);
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

/** The directory a checker child is started in.
 *
 *  `spawn` reports ENOENT for a cwd that does not exist exactly as it does for
 *  a missing executable, and names the COMMAND in both messages. So a working
 *  directory that is not on disk reads as "node could not be started", which
 *  sends the reader after the runtime and offers them an install that cannot
 *  fix it - the render gate then reinstalls, fails the same way, and offers
 *  again.
 *
 *  A document opened through ADT is that case: its workspace folder is a
 *  `repotree-v1` path, not a directory. `committedText` in viewpreview.ts
 *  already guards the same way; this is the call site that did not.
 *
 *  `exists` is injected so this is decidable without touching a disk.
 */
export function checkerCwd(
  folder: { fsPath: string; scheme: string } | undefined,
  home: string,
  exists: (dir: string) => boolean
): string {
  if (!folder || folder.scheme !== "file" || !exists(folder.fsPath)) {
    return home;
  }
  return folder.fsPath;
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
  // the counts never say what a click does, so the tooltip has to
  const CLICK = " Click to open the abap2UI5 Findings view.";
  const { errors, warnings, hints, fixable } = counts;
  const total = errors + warnings + hints;
  if (!total) {
    return `abap2UI5 view check: nothing found in this file.${CLICK}`;
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
      : " None of them can be corrected mechanically.") +
    CLICK
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

// ---------------------------------------------------------------------------
// The findings view: what the workspace reports, by rule
// ---------------------------------------------------------------------------

export type FindingSeverity = "error" | "warning" | "hint";

/**
 * How a source is named in a list. A file is its file name; a class opened
 * through ADT is a service path whose last segment is often `source` or
 * `main`, which names nothing - so the class name wins whenever the caller
 * has one, and the deepest segment that still looks like a name is the
 * fallback.
 */
export function sourceLabel(sourcePath: string, className?: string): string {
  if (className) {
    return className;
  }
  const segments = sourcePath.split("/").filter(Boolean);
  const GENERIC = new Set(["source", "main", "content", "objects"]);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (!GENERIC.has(segments[i].toLowerCase())) {
      return segments[i];
    }
  }
  return segments[segments.length - 1] ?? sourcePath;
}

export interface RuleEntry {
  rule: string;
  severity: FindingSeverity;
  /**
   * Identity of the source the finding is in - an absolute path for a file,
   * the document uri for anything else. Only compared and counted here (how
   * many sources a rule spans, and the order they are listed in), never
   * resolved, so a class that lives on a system rather than on disk groups
   * exactly like a file does.
   */
  file: string;
  /** 0-based line, as VS Code counts them. */
  line: number;
  /** 0-based column of the finding on that line, when the collector has one -
   *  where opening the entry places the cursor. */
  character?: number;
  message: string;
}

export interface RuleGroup {
  rule: string;
  /** The worst severity this rule reports here - what colours the node. */
  severity: FindingSeverity;
  count: number;
  files: number;
  entries: RuleEntry[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = { error: 0, warning: 1, hint: 2 };

/**
 * The findings grouped by the rule that produced them.
 *
 * By RULE and not by file, which is the whole reason for a second view of
 * data the Problems panel already has: a file list answers "what is wrong
 * here", and the question this one is for is "what is wrong with this
 * repository" - twelve `unknown-binding-path` across three classes is one
 * decision (fix them, waive them, baseline them), and per-file it looks like
 * twelve.
 *
 * Ordered worst-first, then by how many there are: the top of the list is
 * where the next decision is.
 */
export function groupByRule(entries: readonly RuleEntry[]): RuleGroup[] {
  const groups = new Map<string, RuleEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.rule);
    if (list) {
      list.push(entry);
    } else {
      groups.set(entry.rule, [entry]);
    }
  }
  return [...groups.entries()]
    .map(([rule, list]) => ({
      rule,
      severity: list
        .map((e) => e.severity)
        .reduce((worst, s) => (SEVERITY_RANK[s] < SEVERITY_RANK[worst] ? s : worst), "hint" as FindingSeverity),
      count: list.length,
      files: new Set(list.map((e) => e.file)).size,
      entries: [...list].sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line
      ),
    }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        b.count - a.count ||
        a.rule.localeCompare(b.rule)
    );
}

/** The line under a rule in the tree: how much of it there is, and where. */
export function ruleSummary(group: RuleGroup): string {
  return (
    `${group.count} finding${group.count === 1 ? "" : "s"} in ` +
    `${group.files} file${group.files === 1 ? "" : "s"}`
  );
}

/**
 * Which line an `abap2ui5lint-disable-next-line` directive has to go ABOVE.
 *
 * In ABAP the answer is always the finding's own line: a full-line `"` comment
 * is legal between any two lines of a statement, chain included.
 *
 * XML is not so forgiving. The linter records a finding at the offset of the
 * ATTRIBUTE it is about, and a control written the way the corpus writes it
 * spreads its attributes over several lines:
 *
 *     <Button
 *       text="Go"
 *       nosuchprop="x"/>
 *
 * Inserting `<!-- … -->` above `nosuchprop` puts a comment INSIDE the start
 * tag, which is not well-formed XML - the view then fails to load at all,
 * which is a far worse outcome than the finding that was being waived. So for
 * XML the directive climbs to the line the element's own `<` is on.
 *
 * Quotes and comments are honoured while scanning, so a `<` inside an
 * attribute value or an XML comment does not open a tag.
 */
export function directiveLine(text: string, line: number, isXml: boolean): number {
  if (!isXml || line <= 0) {
    return line;
  }
  // real offsets, not `length + 1` per line: a CRLF file is two characters
  // per break, and the drift grew by one per line - enough to place the
  // directive above the wrong line, or inside a start tag
  const starts: number[] = [0];
  for (let j = 0; j < text.length; j++) {
    if (text[j] === "\n") {
      starts.push(j + 1);
    }
  }
  const cutoff = line < starts.length ? starts[line] : text.length;

  let tagStart = -1; // offset of the `<` of the start tag we are inside
  let quote = ""; // the attribute quote we are inside, if any
  let i = 0;
  while (i < cutoff && i < text.length) {
    if (tagStart < 0 && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    const c = text[i];
    if (tagStart < 0) {
      // `<?xml … ?>` and `<!DOCTYPE …>` are not elements, but they close on
      // `>` like one, so treating them as a tag is harmless here.
      if (c === "<") {
        tagStart = i;
      }
      i++;
      continue;
    }
    if (quote) {
      if (c === quote) {
        quote = "";
      }
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      tagStart = -1;
    }
    i++;
  }

  if (tagStart < 0) {
    return line; // between tags: the finding's own line is fine
  }
  // the line the `<` sits on
  for (let n = starts.length - 1; n >= 0; n--) {
    if (starts[n] <= tagStart) {
      return n;
    }
  }
  return line;
}
