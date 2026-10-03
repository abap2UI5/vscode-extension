import * as path from "path";
import type { RunOutcome } from "./childproc";

/*
 * "Migrate Classic Report to abap2UI5" - the decisions behind the command,
 * without `vscode`: where report2cloud lives, what it is called with, what
 * its answer MEANS, and where a refusal goes in the report's source.
 *
 * report2cloud is abap-cloud-gui's converter (abap2UI5-addons/abap-cloud-gui,
 * tools/report2cloud): a classic report in, a class inheriting from
 * z2ui5_cl_cgui_report out, together with its sidecar, the report's local
 * classes and a migration report. It is NOT on npm - it parses with the
 * @abaplint/core of its own checkout's node_modules, the version that
 * checkout's gates lint the generated classes with - so the extension runs
 * the CLI of a local checkout, the way mcp-server's `migrate_report` imports
 * the same modules from one. The extension does not talk to mcp-server
 * itself (it only registers it for MCP clients), so delegating to that tool
 * would have meant a second MCP client here for one call.
 *
 * The CLI's contract (its README): `node tools/report2cloud/cli.mjs <file>
 * [--class] [--out] [--partial]`; exit 0 converted, 2 refused (every refusal
 * on stderr as `file:row:col - reason`, the migration report written, no
 * class unless --partial), 1 wrong call. Everything here reads that
 * contract, and nothing else of the converter.
 */

/** The CLI inside an abap-cloud-gui checkout. */
export const CLI_PATH = path.join("tools", "report2cloud", "cli.mjs");

/** What `npm ci` leaves behind that the converter cannot run without - the
 *  parser. Its absence is a setup step, not a converter error. */
export const PARSER_PROBE = path.join("node_modules", "@abaplint", "core", "package.json");

/** mcp-server's variable for the same checkout (its lib/repo-dirs.json,
 *  `cloudGui`), honoured so one configured checkout serves both. */
export const HOME_VAR = "ABAP_CLOUD_GUI_HOME";

/** The setting, spelt once for messages and the "Configure…" action. */
export const PATH_SETTING = "abap2ui5.report2cloud.path";

/** Everything the resolution reads - handed in, so the decision needs
 *  neither settings nor a filesystem. */
export interface ResolveInput {
  /** `abap2ui5.report2cloud.path`. */
  setting: string;
  /** The process environment (ABAP_CLOUD_GUI_HOME). */
  env: Record<string, string | undefined>;
  /** `abap2ui5.mcp.reposRoot`. */
  reposRoot: string;
  /** The directory names an abap-cloud-gui checkout can carry
   *  (CLOUD_GUI_DIRS - empty while the repo-dirs snapshot has none). */
  dirs: readonly string[];
  exists: (file: string) => boolean;
}

export type ConverterSource = "setting" | "environment" | "repos root";

export type Resolution =
  | { ok: true; root: string; cli: string; source: ConverterSource }
  /** Nothing configured anywhere. */
  | { ok: false; reason: "unconfigured"; message: string }
  /** Configured, but the place holds no report2cloud CLI. */
  | { ok: false; reason: "no-cli"; root: string; source: ConverterSource; message: string }
  /** The CLI is there, the checkout's `npm ci` is not. */
  | { ok: false; reason: "no-deps"; root: string; source: ConverterSource; message: string };

const NAMED: Record<ConverterSource, string> = {
  setting: PATH_SETTING,
  environment: HOME_VAR,
  "repos root": "abap2ui5.mcp.reposRoot",
};

/** A configured path to the checkout - or to the tool's folder or its CLI,
 *  the other shapes somebody copies out of the README. Exported for the
 *  tests. */
export function rootOf(configured: string): string {
  return configured
    .trim()
    .replace(/[\\/]+$/, "")
    .replace(/[\\/]tools[\\/]report2cloud(?:[\\/]cli\.mjs)?$/i, "");
}

function check(root: string, source: ConverterSource, exists: (f: string) => boolean): Resolution {
  const cli = path.join(root, CLI_PATH);
  if (!exists(cli)) {
    return {
      ok: false,
      reason: "no-cli",
      root,
      source,
      message:
        `${root} (from ${NAMED[source]}) is not an abap-cloud-gui checkout with ` +
        `report2cloud - ${CLI_PATH} is missing. Point ${PATH_SETTING} at a clone of ` +
        "https://github.com/abap2UI5-addons/abap-cloud-gui (git pull an older one).",
    };
  }
  if (!exists(path.join(root, PARSER_PROBE))) {
    return {
      ok: false,
      reason: "no-deps",
      root,
      source,
      message:
        `report2cloud in ${root} cannot run yet - its parser (@abaplint/core) is not ` +
        `installed. Run \`npm ci\` in ${root} once.`,
    };
  }
  return { ok: true, root, cli, source };
}

/**
 * The converter, in the order mcp-server resolves the same checkout plus the
 * extension's own setting in front: the setting, then ABAP_CLOUD_GUI_HOME,
 * then an `abap-cloud-gui` checkout under the repos root. An EXPLICIT answer
 * that does not hold is reported as such - it never falls through to the
 * next rung, because a checkout somebody pointed at on purpose must be the
 * one that runs, or the reason it cannot.
 */
export function resolveReport2cloud(input: ResolveInput): Resolution {
  const setting = input.setting.trim();
  if (setting) {
    return check(rootOf(setting), "setting", input.exists);
  }
  const home = (input.env[HOME_VAR] ?? "").trim();
  if (home) {
    return check(rootOf(home), "environment", input.exists);
  }
  const reposRoot = input.reposRoot.trim();
  if (reposRoot) {
    for (const dir of input.dirs) {
      const root = path.join(reposRoot, dir);
      if (input.exists(path.join(root, CLI_PATH))) {
        return check(root, "repos root", input.exists);
      }
    }
  }
  return {
    ok: false,
    reason: "unconfigured",
    message:
      "report2cloud is not configured. It is not on npm: clone " +
      "https://github.com/abap2UI5-addons/abap-cloud-gui, run `npm ci` there and " +
      `point ${PATH_SETTING} at the checkout.`,
  };
}

/** A classic report's source file, by abapGit's naming. */
export function isReportFile(file: string): boolean {
  return /\.prog\.abap$/i.test(file);
}

/** The program name the CLI derives from the file name - abapGit writes a
 *  namespace's slashes as `#`. Undefined for any other name. */
export function programNameOfFile(file: string): string | undefined {
  const m = /^(.+)\.prog\.abap$/i.exec(path.basename(file));
  return m ? m[1].replace(/#/g, "/").toLowerCase() : undefined;
}

/** The name in the `REPORT` / `PROGRAM` statement - the converter's fallback
 *  when the file name says nothing. Full-line comments are skipped. */
export function programNameOfSource(source: string): string | undefined {
  const code = source.replace(/^\*.*$/gm, "");
  const m = /^\s*(?:REPORT|PROGRAM)\s+([\w/]+)/im.exec(code);
  return m ? m[1].toLowerCase() : undefined;
}

/** report2cloud's default class for a program (lib/convert.mjs
 *  `defaultClassName`, mirrored so the prompt can show it): `zfoo` and
 *  `z_foo` become `zcl_foo`, a namespace keeps its prefix, anything else
 *  gets `zcl_`; at most 30 characters. */
export function defaultClassName(program: string): string {
  const p = program.toLowerCase();
  const ns = /^(\/\w+\/)(.*)$/.exec(p);
  if (ns) {
    return `${ns[1]}cl_${ns[2]}`.slice(0, 30);
  }
  const m = /^([zy])_?(.*)$/.exec(p);
  return (m ? `${m[1]}cl_${m[2]}` : `zcl_${p}`).slice(0, 30);
}

/** The class name the prompt starts with - what the CLI would pick without
 *  `--class`. */
export function defaultTargetClass(file: string, source: string): string {
  return defaultClassName(programNameOfFile(file) ?? programNameOfSource(source) ?? "zreport");
}

/**
 * Why `value` is not a class report2cloud can write here, or undefined.
 * Customer namespace only: the CLI names its files after the class as typed,
 * so a namespaced `/ns/cl_x` would become a path with folders in it instead
 * of abapGit's `#ns#cl_x.clas.abap` - those stay with the CLI for now.
 */
export function targetClassError(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Enter a class name, e.g. zcl_my_report.";
  }
  if (name.includes("/")) {
    return "Namespaced classes are not written by this command - use a Z or Y name, or run report2cloud's CLI directly.";
  }
  if (!/^[zy]/i.test(name)) {
    return `A class name starts with Z (or Y) - the customer namespace - not "${name[0]}".`;
  }
  if (name.length > 30) {
    return `Too long: ${name.length} characters - ABAP allows up to 30.`;
  }
  const bad = /[^a-z0-9_]/i.exec(name);
  if (bad) {
    return `"${bad[0]}" cannot appear in a class name - use letters, digits and _ only.`;
  }
  return undefined;
}

/** What one run is asked to do. */
export interface MigrateRequest {
  cli: string;
  /** The report's source file, absolute - the refusals quote it as given. */
  file: string;
  className: string;
  /** The output folder, absolute. */
  out: string;
  partial?: boolean;
}

/** The CLI's arguments after `node`. The class is always passed, so the
 *  names of the files it writes are known before it runs. */
export function migrateArgs(req: MigrateRequest): string[] {
  const args = [req.cli, req.file, "--class", req.className.toLowerCase(), "--out", req.out];
  if (req.partial) {
    args.push("--partial");
  }
  return args;
}

/** Every file a run may write for `className` into `out` - the class, its
 *  sidecar, the two local includes and the migration report. What the
 *  command asks about before it overwrites anything. */
export function outputFiles(out: string, className: string): {
  classFile: string;
  sidecar: string;
  localsDef: string;
  localsImp: string;
  report: string;
} {
  const cls = className.toLowerCase();
  return {
    classFile: path.join(out, `${cls}.clas.abap`),
    sidecar: path.join(out, `${cls}.clas.xml`),
    localsDef: path.join(out, `${cls}.clas.locals_def.abap`),
    localsImp: path.join(out, `${cls}.clas.locals_imp.abap`),
    report: path.join(out, `${cls}.migration.md`),
  };
}

/** One refused statement, as the CLI prints it - row and column 1-based. */
export interface Refusal {
  file: string;
  row: number;
  col: number;
  message: string;
}

/**
 * The refusals on stderr: `file:row:col - reason`, one per line. The file is
 * the path the CLI was given, so a line that starts with it is read by that
 * prefix - a Windows path has a colon of its own, and a reason may contain
 * " - " too. Lines in another shape (the summary, a stack trace) are skipped.
 */
export function parseRefusals(stderr: string, file?: string): Refusal[] {
  const out: Refusal[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (file && line.startsWith(`${file}:`)) {
      const m = /^(\d+):(\d+) - (.*)$/.exec(line.slice(file.length + 1));
      if (m) {
        out.push({ file, row: Number(m[1]), col: Number(m[2]), message: m[3] });
        continue;
      }
    }
    const m = /^(.+?):(\d+):(\d+) - (.*)$/.exec(line);
    if (m) {
      out.push({ file: m[1], row: Number(m[2]), col: Number(m[3]), message: m[4] });
    }
  }
  return out;
}

/** What one run of the CLI came to. */
export type MigrateResult =
  | {
      kind: "converted";
      className: string;
      /** The files it wrote, as it listed them (the migration report not
       *  among them). */
      files: string[];
      classFile: string;
      report: string;
      mapped: number;
      todos: number;
      /** Objects to check for their release state on ABAP Cloud. */
      release: number;
    }
  | {
      kind: "refused";
      className: string;
      refusals: Refusal[];
      /** The migration report - written on a refusal too, it lists them. */
      report: string;
      /** True when the draft was written (`--partial`). */
      partial: boolean;
      /** The draft files that exist after a partial run. */
      files: string[];
      classFile?: string;
    }
  /** The checkout's `npm ci` is missing after all (a parser import failed). */
  | { kind: "no-deps"; message: string }
  /** Exit 1 or anything else that is not the contract. */
  | { kind: "failed"; message: string };

const SUMMARY_RE =
  /^(\S+): (\d+) constructs? mapped, (\d+) TODO\(s\), (\d+) object\(s\) to check for ABAP Cloud/m;
const REFUSED_RE = /^(\S+): refused - (\d+) statement\(s\) cannot be mapped.*; report: (.+)$/m;

/** The first lines of a failure, enough for a notification. */
function headOf(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 3).join(" ") || "no output";
}

/**
 * Reads the CLI's answer. `req` is what it was called with - the output
 * folder and the class decide where the files are when the output does not
 * list them (a partial draft), and `exists` says which of them are there.
 */
export function interpretRun(
  outcome: RunOutcome,
  req: MigrateRequest,
  exists: (file: string) => boolean
): MigrateResult {
  if (outcome.kind === "spawn-failed") {
    return { kind: "failed", message: `report2cloud could not be started: ${outcome.error.message}` };
  }
  if (outcome.kind === "timeout") {
    return { kind: "failed", message: "report2cloud did not finish in time and was stopped." };
  }
  if (outcome.kind === "abandoned") {
    return { kind: "failed", message: "report2cloud was cancelled." };
  }
  const { code, stdout, stderr } = outcome;
  const expected = outputFiles(req.out, req.className);
  if (/ERR_MODULE_NOT_FOUND|Cannot find (?:package|module) '@abaplint\//.test(stderr)) {
    return {
      kind: "no-deps",
      message: `report2cloud cannot load its parser - run \`npm ci\` in the abap-cloud-gui checkout. (${headOf(stderr)})`,
    };
  }
  if (code === 0) {
    const summary = SUMMARY_RE.exec(stdout);
    const listed = stdout
      .split(/\r?\n/)
      .filter((l) => /^ {2}\S/.test(l))
      .map((l) => l.trim());
    const report = listed.find((f) => /\.migration\.md$/i.test(f)) ?? expected.report;
    const files = listed.filter((f) => f !== report);
    const classFile =
      files.find((f) => /\.clas\.abap$/i.test(f) && !/\.clas\.locals_/i.test(f)) ?? expected.classFile;
    return {
      kind: "converted",
      className: summary?.[1] ?? req.className.toLowerCase(),
      files: files.length ? files : [expected.classFile, expected.sidecar].filter(exists),
      classFile,
      report,
      mapped: Number(summary?.[2] ?? 0),
      todos: Number(summary?.[3] ?? 0),
      release: Number(summary?.[4] ?? 0),
    };
  }
  if (code === 2) {
    const summary = REFUSED_RE.exec(stderr);
    const drafted = req.partial
      ? [expected.classFile, expected.sidecar, expected.localsDef, expected.localsImp].filter(exists)
      : [];
    return {
      kind: "refused",
      className: summary?.[1] ?? req.className.toLowerCase(),
      refusals: parseRefusals(stderr, req.file),
      report: summary?.[3]?.trim() ?? expected.report,
      partial: Boolean(req.partial),
      files: drafted,
      ...(drafted.includes(expected.classFile) ? { classFile: expected.classFile } : {}),
    };
  }
  return {
    kind: "failed",
    message:
      code === 1
        ? `report2cloud refused the call: ${headOf(stderr)}`
        : `report2cloud ended with exit code ${code}: ${headOf(stderr || stdout)}`,
  };
}

/** A 0-based range in a document. */
export interface LineRange {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
}

/**
 * Where a refusal goes in the report's source: from its row:col to the end
 * of the statement on that line - the period that closes it, outside string
 * literals and before a `"` comment - or to the end of the line when the
 * statement goes on. A position past the text is clamped onto its last line,
 * and an empty stretch widens to the line's own content, so every refusal
 * gets a squiggle that can be seen and clicked.
 */
export function refusalRange(lines: readonly string[], row: number, col: number): LineRange {
  const lineNo = Math.min(Math.max(row - 1, 0), Math.max(lines.length - 1, 0));
  const text = lines[lineNo] ?? "";
  let start = Math.min(Math.max(col - 1, 0), text.length);
  while (start < text.length && /\s/.test(text[start])) {
    start++;
  }
  let end = text.length;
  let quote: string | undefined;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === "`" || ch === "|") {
      quote = ch;
    } else if (ch === '"') {
      end = i;
      break;
    } else if (ch === ".") {
      end = i + 1;
      break;
    }
  }
  while (end > start && /\s/.test(text[end - 1])) {
    end--;
  }
  if (end <= start) {
    const lead = text.length - text.trimStart().length;
    start = lead;
    end = Math.max(text.trimEnd().length, lead);
  }
  return { startLine: lineNo, startChar: start, endLine: lineNo, endChar: end };
}
