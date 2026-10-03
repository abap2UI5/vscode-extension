import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { run, type RunOutcome } from "../childproc";
import { CLOUD_GUI_DIRS } from "../repolayout";
import {
  CLI_PATH,
  HOME_VAR,
  PARSER_PROBE,
  defaultClassName,
  defaultTargetClass,
  interpretRun,
  isReportFile,
  migrateArgs,
  outputFiles,
  parseRefusals,
  programNameOfFile,
  programNameOfSource,
  refusalRange,
  resolveReport2cloud,
  rootOf,
  targetClassError,
  type MigrateRequest,
} from "../report2cloud";

/*
 * "Migrate Classic Report to abap2UI5" decides without vscode where
 * report2cloud lives, what it is called with, what its exit code and output
 * mean and where each refusal goes in the report. The CLI's contract is
 * abap-cloud-gui's tools/report2cloud/README.md; the stub below speaks it,
 * and the last tests run the real CLI when a checkout is at hand.
 */

const ROOT = path.join(__dirname, "..");
const repos = path.join(path.sep, "repos");

function closed(code: number | null, stdout = "", stderr = ""): RunOutcome {
  return { kind: "closed", code, stdout, stderr };
}

const none = (): boolean => false;

// ---------------------------------------------------------------- resolve

test("the setting wins and names the checkout's CLI", () => {
  const gui = path.join(repos, "my-gui");
  const r = resolveReport2cloud({
    setting: gui,
    env: { [HOME_VAR]: path.join(repos, "other") },
    reposRoot: repos,
    dirs: ["abap-cloud-gui"],
    exists: () => true,
  });
  assert.deepEqual(r, { ok: true, root: gui, cli: path.join(gui, CLI_PATH), source: "setting" });
});

test("a setting pointing at the tool or its CLI resolves to the checkout", () => {
  assert.equal(rootOf("/x/abap-cloud-gui/tools/report2cloud/cli.mjs"), "/x/abap-cloud-gui");
  assert.equal(rootOf("/x/abap-cloud-gui/tools/report2cloud/"), "/x/abap-cloud-gui");
  assert.equal(rootOf("C:\\x\\abap-cloud-gui\\tools\\report2cloud\\cli.mjs"), "C:\\x\\abap-cloud-gui");
  assert.equal(rootOf("  /x/abap-cloud-gui/  "), "/x/abap-cloud-gui");
});

test("an explicit setting that does not hold is reported, never skipped for the next rung", () => {
  const gui = path.join(repos, "abap-cloud-gui");
  const r = resolveReport2cloud({
    setting: path.join(repos, "wrong"),
    env: {},
    reposRoot: repos,
    dirs: ["abap-cloud-gui"],
    exists: (f) => f.startsWith(gui),
  });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, "no-cli");
  assert.match(!r.ok ? r.message : "", /abap2ui5\.report2cloud\.path/);
});

test("ABAP_CLOUD_GUI_HOME - mcp-server's variable - comes after the setting", () => {
  const home = path.join(repos, "home-gui");
  const r = resolveReport2cloud({
    setting: "",
    env: { [HOME_VAR]: home },
    reposRoot: "",
    dirs: [],
    exists: () => true,
  });
  assert.equal(r.ok && r.source, "environment");
  assert.equal(r.ok && r.root, home);
});

test("an abap-cloud-gui checkout under the repos root is the last rung", () => {
  const gui = path.join(repos, "abap-cloud-gui");
  const r = resolveReport2cloud({
    setting: "",
    env: {},
    reposRoot: repos,
    dirs: ["abap-cloud-gui"],
    exists: (f) => f.startsWith(gui),
  });
  assert.equal(r.ok && r.source, "repos root");
  assert.equal(r.ok && r.cli, path.join(gui, CLI_PATH));
});

test("the repos-root rung takes its names from the repo-dirs snapshot (empty until it has cloudGui)", () => {
  assert.ok(Array.isArray(CLOUD_GUI_DIRS));
  for (const dir of CLOUD_GUI_DIRS) {
    assert.match(dir, /^[\w.-]+$/);
  }
});

test("nothing configured is said as such, with where to get report2cloud", () => {
  const r = resolveReport2cloud({ setting: " ", env: {}, reposRoot: "", dirs: [], exists: () => true });
  assert.equal(!r.ok && r.reason, "unconfigured");
  assert.match(!r.ok ? r.message : "", /abap2UI5-addons\/abap-cloud-gui/);
  assert.match(!r.ok ? r.message : "", /npm ci/);
});

test("a checkout without npm ci is a setup step, not a converter error", () => {
  const gui = path.join(repos, "abap-cloud-gui");
  const r = resolveReport2cloud({
    setting: gui,
    env: {},
    reposRoot: "",
    dirs: [],
    exists: (f) => f === path.join(gui, CLI_PATH),
  });
  assert.equal(!r.ok && r.reason, "no-deps");
  assert.equal(!r.ok && r.reason === "no-deps" && r.root, gui);
  assert.match(!r.ok ? r.message : "", /npm ci/);
});

// ------------------------------------------------------ names and arguments

test("a report is a .prog.abap file", () => {
  assert.equal(isReportFile("/a/zflights.prog.abap"), true);
  assert.equal(isReportFile("/a/ZFLIGHTS.PROG.ABAP"), true);
  assert.equal(isReportFile("/a/zcl_x.clas.abap"), false);
  assert.equal(isReportFile("/a/zflights.prog.xml"), false);
});

test("the program name comes from the file name, # as the namespace slash", () => {
  assert.equal(programNameOfFile("/a/ZR2C_02_FLIGHTS.prog.abap"), "zr2c_02_flights");
  assert.equal(programNameOfFile("/a/#abc#zrep.prog.abap"), "/abc/zrep");
  assert.equal(programNameOfFile("/a/zcl_x.clas.abap"), undefined);
});

test("the program name falls back to the REPORT statement, comments skipped", () => {
  assert.equal(programNameOfSource("* REPORT zcomment.\nREPORT zr2c_01_hello MESSAGE-ID zr2c."), "zr2c_01_hello");
  assert.equal(programNameOfSource("  program ZPROG."), "zprog");
  assert.equal(programNameOfSource("WRITE 1."), undefined);
});

test("the default class is report2cloud's: zcl_ + the report name, at most 30", () => {
  assert.equal(defaultClassName("zflights"), "zcl_flights");
  assert.equal(defaultClassName("z_flights"), "zcl_flights");
  assert.equal(defaultClassName("ysales"), "ycl_sales");
  assert.equal(defaultClassName("rflights"), "zcl_rflights");
  assert.equal(defaultClassName("/abc/zrep"), "/abc/cl_zrep");
  assert.equal(defaultClassName("z_a_very_long_report_name_beyond_thirty"), "zcl_a_very_long_report_name_be");
  assert.equal(defaultClassName("z_a_very_long_report_name_beyond_thirty").length, 30);
  assert.equal(defaultTargetClass("/a/zr2c_02_flights.prog.abap", ""), "zcl_r2c_02_flights");
  assert.equal(defaultTargetClass("/a/report.abap", "REPORT zhello."), "zcl_hello");
  assert.equal(defaultTargetClass("/a/report.abap", ""), "zcl_report");
});

test("a target class must be a customer-namespace ABAP name", () => {
  assert.equal(targetClassError("zcl_flights"), undefined);
  assert.equal(targetClassError("YCL_X"), undefined);
  assert.match(targetClassError("") ?? "", /Enter a class name/);
  assert.match(targetClassError("cl_x") ?? "", /starts with Z/);
  assert.match(targetClassError("zcl_" + "x".repeat(27)) ?? "", /31 characters/);
  assert.match(targetClassError("zcl-x") ?? "", /"-" cannot appear/);
  // the CLI writes files named after the class as typed - a slash there is a folder
  assert.match(targetClassError("/abc/cl_rep") ?? "", /Namespaced/);
});

test("the CLI is called with the class always, the folder, and --partial on demand", () => {
  const req: MigrateRequest = { cli: "/g/cli.mjs", file: "/w/zr.prog.abap", className: "ZCL_R", out: "/w" };
  assert.deepEqual(migrateArgs(req), ["/g/cli.mjs", "/w/zr.prog.abap", "--class", "zcl_r", "--out", "/w"]);
  assert.deepEqual(migrateArgs({ ...req, partial: true }).slice(-1), ["--partial"]);
});

test("the files a run may write are the class, sidecar, locals and the migration report", () => {
  const files = outputFiles("/w", "ZCL_R");
  assert.deepEqual(
    Object.values(files).map((f) => path.basename(f)),
    ["zcl_r.clas.abap", "zcl_r.clas.xml", "zcl_r.clas.locals_def.abap", "zcl_r.clas.locals_imp.abap", "zcl_r.migration.md"]
  );
});

// ------------------------------------------------------------------ output

test("refusals are read from stderr by the path the CLI was given", () => {
  const file = "C:\\Users\\John Smith\\src\\zr.prog.abap";
  const stderr =
    `${file}:28:3 - CALL TRANSACTION - no SAP GUI transaction can be started\n` +
    `${file}:38:1 - MODULE - dynpro modules have no counterpart\r\n` +
    "z2ui5_cl_x: refused - 2 statement(s) cannot be mapped, no class written; report: C:\\x.migration.md\n";
  assert.deepEqual(parseRefusals(stderr, file), [
    { file, row: 28, col: 3, message: "CALL TRANSACTION - no SAP GUI transaction can be started" },
    { file, row: 38, col: 1, message: "MODULE - dynpro modules have no counterpart" },
  ]);
});

test("a refusal line for another path is still read, the reason kept whole", () => {
  assert.deepEqual(parseRefusals("rel/zr.prog.abap:5:7 - SUBMIT - convert it as well\nnoise\n"), [
    { file: "rel/zr.prog.abap", row: 5, col: 7, message: "SUBMIT - convert it as well" },
  ]);
});

const req: MigrateRequest = { cli: "/g/cli.mjs", file: "/w/zr.prog.abap", className: "zcl_r", out: "/w" };

test("exit 0: the class, its files and the counts", () => {
  const stdout =
    "zcl_r: 12 constructs mapped, 2 TODO(s), 1 object(s) to check for ABAP Cloud\n" +
    "  /w/zcl_r.clas.abap\n  /w/zcl_r.clas.locals_imp.abap\n  /w/zcl_r.clas.xml\n  /w/zcl_r.migration.md\n";
  const r = interpretRun(closed(0, stdout), req, none);
  assert.deepEqual(r, {
    kind: "converted",
    className: "zcl_r",
    files: ["/w/zcl_r.clas.abap", "/w/zcl_r.clas.locals_imp.abap", "/w/zcl_r.clas.xml"],
    classFile: "/w/zcl_r.clas.abap",
    report: "/w/zcl_r.migration.md",
    mapped: 12,
    todos: 2,
    release: 1,
  });
});

test("exit 2: the refusals and the migration report, no class", () => {
  const stderr =
    "/w/zr.prog.abap:36:3 - CALL SCREEN - a dynpro has no counterpart\n" +
    "zcl_r: refused - 1 statement(s) cannot be mapped, no class written; report: /w/zcl_r.migration.md\n";
  const r = interpretRun(closed(2, "", stderr), req, () => true);
  assert.equal(r.kind, "refused");
  if (r.kind === "refused") {
    assert.equal(r.partial, false);
    assert.deepEqual(r.files, [], "without --partial nothing but the report is written, whatever is on disk");
    assert.equal(r.classFile, undefined);
    assert.equal(r.report, "/w/zcl_r.migration.md");
    assert.deepEqual(r.refusals.map((x) => [x.row, x.col]), [[36, 3]]);
  }
});

test("exit 2 with --partial: the draft files that are there", () => {
  const stderr =
    "/w/zr.prog.abap:36:3 - CALL SCREEN - a dynpro has no counterpart\n" +
    "zcl_r: refused - 1 statement(s) cannot be mapped, draft written to /w; report: /w/zcl_r.migration.md\n";
  const there = new Set([path.join("/w", "zcl_r.clas.abap"), path.join("/w", "zcl_r.clas.xml")]);
  const r = interpretRun(closed(2, "", stderr), { ...req, partial: true }, (f) => there.has(f));
  assert.equal(r.kind, "refused");
  if (r.kind === "refused") {
    assert.equal(r.partial, true);
    assert.deepEqual(r.files, [...there]);
    assert.equal(r.classFile, path.join("/w", "zcl_r.clas.abap"));
  }
});

test("exit 1, a crash, a missing parser, no start, a timeout - each said as what it is", () => {
  const usage = interpretRun(closed(1, "", "unknown option --x\n\nusage: ..."), req, none);
  assert.equal(usage.kind, "failed");
  assert.match(usage.kind === "failed" ? usage.message : "", /refused the call: unknown option --x/);

  const crash = interpretRun(closed(134, "", "TypeError: boom\n    at x"), req, none);
  assert.match(crash.kind === "failed" ? crash.message : "", /exit code 134: TypeError: boom/);

  const deps = interpretRun(
    closed(1, "", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@abaplint/core' imported from /g/lib/convert.mjs"),
    req,
    none
  );
  assert.equal(deps.kind, "no-deps");

  const spawn = interpretRun({ kind: "spawn-failed", error: new Error("ENOENT") }, req, none);
  assert.match(spawn.kind === "failed" ? spawn.message : "", /could not be started: ENOENT/);

  const late = interpretRun({ kind: "timeout", stdout: "", stderr: "" }, req, none);
  assert.match(late.kind === "failed" ? late.message : "", /did not finish in time/);
});

// ------------------------------------------------------------------ ranges

test("a refusal underlines its statement up to the period, past periods in literals", () => {
  const lines = ["START-OF-SELECTION.", "  ASSIGN ('(SAPMV45A)VBAK-VBELN') TO <gv_vbeln>.   \" comment"];
  assert.deepEqual(refusalRange(lines, 2, 3), { startLine: 1, startChar: 2, endLine: 1, endChar: 48 });
  assert.equal(lines[1].slice(2, 48), "ASSIGN ('(SAPMV45A)VBAK-VBELN') TO <gv_vbeln>.");
});

test("a statement that goes on runs to the end of its line, before a comment", () => {
  const lines = ["  CALL TRANSACTION 'VA02' USING gt_bdc   \" batch input", "    MODE 'N'."];
  const r = refusalRange(lines, 1, 3);
  assert.equal(lines[0].slice(r.startChar, r.endChar), "CALL TRANSACTION 'VA02' USING gt_bdc");
});

test("a position past the text is clamped, an empty stretch widens to the line", () => {
  const lines = ["REPORT z.", "  CALL SCREEN 100."];
  assert.deepEqual(refusalRange(lines, 99, 1), { startLine: 1, startChar: 2, endLine: 1, endChar: 18 });
  assert.deepEqual(refusalRange(lines, 2, 80), { startLine: 1, startChar: 2, endLine: 1, endChar: 18 });
  assert.deepEqual(refusalRange([], 1, 1), { startLine: 0, startChar: 0, endLine: 0, endChar: 0 });
});

// --------------------------------------------------- a stub CLI, for real

/** A checkout whose CLI speaks report2cloud's contract: a report containing
 *  CALL SCREEN is refused (the draft written with --partial), BADCALL is a
 *  wrong call, anything else converts. */
function stubCheckout(withDeps = true): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r2c-stub-"));
  const cli = path.join(dir, CLI_PATH);
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(
    cli,
    `import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
${withDeps ? "" : 'import "@abaplint/core";\n'}const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
const file = a[0];
const cls = opt("--class");
const out = opt("--out");
const src = readFileSync(file, "utf8");
if (src.includes("BADCALL")) { console.error("unknown option --bad"); process.exit(1); }
mkdirSync(out, { recursive: true });
const report = join(out, cls + ".migration.md");
writeFileSync(report, "# report2cloud\\n");
const lines = src.split("\\n");
const refused = lines.flatMap((l, i) => l.includes("CALL SCREEN") ? [[i + 1, l.indexOf("CALL") + 1]] : []);
if (refused.length) {
  for (const [r, c] of refused) console.error(file + ":" + r + ":" + c + " - CALL SCREEN - a dynpro has no counterpart");
  if (a.includes("--partial")) { writeFileSync(join(out, cls + ".clas.abap"), "CLASS " + cls + " DEFINITION.\\n"); writeFileSync(join(out, cls + ".clas.xml"), "<x/>"); }
  console.error(cls + ": refused - " + refused.length + " statement(s) cannot be mapped" + (a.includes("--partial") ? ", draft written to " + out : ", no class written") + "; report: " + report);
  process.exit(2);
}
writeFileSync(join(out, cls + ".clas.abap"), "CLASS " + cls + " DEFINITION.\\n");
writeFileSync(join(out, cls + ".clas.xml"), "<x/>");
console.log(cls + ": 3 constructs mapped, 0 TODO(s), 0 object(s) to check for ABAP Cloud");
console.log("  " + join(out, cls + ".clas.abap") + "\\n  " + join(out, cls + ".clas.xml") + "\\n  " + report);
`
  );
  if (withDeps) {
    const probe = path.join(dir, PARSER_PROBE);
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, "{}");
  }
  return dir;
}

async function migrate(checkout: string, source: string, partial = false) {
  const resolution = resolveReport2cloud({
    setting: checkout,
    env: {},
    reposRoot: "",
    dirs: [],
    exists: (f) => fs.existsSync(f),
  });
  assert.equal(resolution.ok, true, JSON.stringify(resolution));
  if (!resolution.ok) {
    throw new Error("unreachable");
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "r2c-work-"));
  const file = path.join(work, "zr2c_stub.prog.abap");
  fs.writeFileSync(file, source);
  const req: MigrateRequest = {
    cli: resolution.cli,
    file,
    className: defaultTargetClass(file, source),
    out: path.join(work, "out"),
    partial,
  };
  const outcome = await run(process.execPath, migrateArgs(req), { cwd: resolution.root, timeoutMs: 30_000 });
  return { req, file, result: interpretRun(outcome, req, (f) => fs.existsSync(f)) };
}

test("stub CLI, exit 0: the files it wrote and listed", async () => {
  const { req, result } = await migrate(stubCheckout(), "REPORT zr2c_stub.\nWRITE / 'x'.\n");
  assert.equal(result.kind, "converted");
  if (result.kind === "converted") {
    assert.equal(result.className, "zcl_r2c_stub");
    assert.equal(result.classFile, path.join(req.out, "zcl_r2c_stub.clas.abap"));
    assert.ok(fs.existsSync(result.classFile));
    assert.ok(fs.existsSync(result.report));
    assert.equal(result.mapped, 3);
  }
});

test("stub CLI, exit 2 then --partial: refusals with their position, then the draft", async () => {
  const source = "REPORT zr2c_stub.\nSTART-OF-SELECTION.\n  CALL SCREEN 100.\n";
  const first = await migrate(stubCheckout(), source);
  assert.equal(first.result.kind, "refused");
  if (first.result.kind === "refused") {
    assert.deepEqual(first.result.refusals.map((r) => [r.file, r.row, r.col]), [[first.file, 3, 3]]);
    assert.equal(first.result.classFile, undefined);
    assert.ok(fs.existsSync(first.result.report), "the migration report is written on a refusal too");
    const at = refusalRange(source.split("\n"), first.result.refusals[0].row, first.result.refusals[0].col);
    assert.equal(source.split("\n")[at.startLine].slice(at.startChar, at.endChar), "CALL SCREEN 100.");
  }
  const second = await migrate(stubCheckout(), source, true);
  assert.equal(second.result.kind, "refused");
  if (second.result.kind === "refused") {
    assert.equal(second.result.partial, true);
    assert.equal(second.result.classFile, path.join(second.req.out, "zcl_r2c_stub.clas.abap"));
    assert.equal(second.result.files.length, 2);
  }
});

test("stub CLI, exit 1 and a checkout without its parser", async () => {
  const bad = await migrate(stubCheckout(), "REPORT zr2c_stub. BADCALL\n");
  assert.equal(bad.result.kind, "failed");
  // the CLI file is there, the parser is not: resolution says no-deps before
  // anything runs, and a run anyway is read as no-deps too
  const noDeps = stubCheckout(false);
  const r = resolveReport2cloud({ setting: noDeps, env: {}, reposRoot: "", dirs: [], exists: (f) => fs.existsSync(f) });
  assert.equal(!r.ok && r.reason, "no-deps");
  const file = path.join(noDeps, "zr.prog.abap");
  fs.writeFileSync(file, "REPORT zr.\n");
  const req2: MigrateRequest = { cli: path.join(noDeps, CLI_PATH), file, className: "zcl_r", out: noDeps };
  const outcome = await run(process.execPath, migrateArgs(req2), { cwd: noDeps, timeoutMs: 30_000 });
  assert.equal(interpretRun(outcome, req2, (f) => fs.existsSync(f)).kind, "no-deps");
});

// ---------------------------------------------- the real report2cloud, opt-in

/** A real abap-cloud-gui checkout with npm ci done: ABAP_CLOUD_GUI_HOME, or a
 *  sibling of this repository. CI has none, so these skip there. */
function realCheckout(): string | undefined {
  for (const candidate of [process.env[HOME_VAR], path.join(ROOT, "..", "abap-cloud-gui")]) {
    if (!candidate) {
      continue;
    }
    const r = resolveReport2cloud({ setting: candidate, env: {}, reposRoot: "", dirs: [], exists: (f) => fs.existsSync(f) });
    if (r.ok) {
      return r.root;
    }
  }
  return undefined;
}

const REAL = realCheckout();
const CORPUS = REAL ? path.join(REAL, "tools", "report2cloud", "test", "corpus") : "";
const SNAPSHOTS = REAL ? path.join(REAL, "tools", "report2cloud", "test", "snapshots") : "";
const realSkip = REAL ? false : "no abap-cloud-gui checkout with npm ci (ABAP_CLOUD_GUI_HOME or ../abap-cloud-gui)";

async function realMigrate(name: string, className: string, partial = false) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "r2c-real-"));
  for (const ext of [".prog.abap", ".prog.xml"]) {
    const from = path.join(CORPUS, name + ext);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(work, name + ext));
    }
  }
  const file = path.join(work, `${name}.prog.abap`);
  const req: MigrateRequest = { cli: path.join(REAL!, CLI_PATH), file, className, out: work, partial };
  const outcome = await run(process.execPath, migrateArgs(req), { cwd: REAL, timeoutMs: 60_000 });
  return { req, file, result: interpretRun(outcome, req, (f) => fs.existsSync(f)) };
}

test("real report2cloud: zr2c_02_flights converts into the class of its snapshot", { skip: realSkip }, async () => {
  const { result } = await realMigrate("zr2c_02_flights", "z2ui5_cl_cgui_r2c_02");
  assert.equal(result.kind, "converted", JSON.stringify(result));
  if (result.kind === "converted") {
    assert.equal(result.className, "z2ui5_cl_cgui_r2c_02");
    assert.ok(result.mapped > 0);
    assert.equal(
      fs.readFileSync(result.classFile, "utf8"),
      fs.readFileSync(path.join(SNAPSHOTS, "zr2c_02_flights", "z2ui5_cl_cgui_r2c_02.clas.abap"), "utf8"),
      "the class the CLI wrote through this module is the converter's own snapshot"
    );
    assert.ok(fs.existsSync(result.report));
  }
});

test("real report2cloud: zr2c_10_refused is refused statement by statement, --partial writes the draft", { skip: realSkip }, async () => {
  const { file, result } = await realMigrate("zr2c_10_refused", "z2ui5_cl_cgui_r2c_10");
  assert.equal(result.kind, "refused", JSON.stringify(result));
  if (result.kind !== "refused") {
    return;
  }
  // the positions the converter's own migration report snapshot lists
  const snapshot = fs.readFileSync(path.join(SNAPSHOTS, "zr2c_10_refused", "z2ui5_cl_cgui_r2c_10.migration.md"), "utf8");
  const expected = [...snapshot.matchAll(/`zr2c_10_refused\.prog\.abap:(\d+):(\d+)`/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.ok(expected.length > 0);
  assert.deepEqual(result.refusals.map((r) => [r.row, r.col]), expected);
  assert.ok(result.refusals.every((r) => r.file === file));
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const underlined = result.refusals.map((r) => {
    const at = refusalRange(lines, r.row, r.col);
    return lines[at.startLine].slice(at.startChar, at.endChar);
  });
  assert.ok(underlined.includes("CALL SCREEN 100."), underlined.join(" | "));
  assert.ok(underlined.every((u) => u.length > 0));

  const draft = await realMigrate("zr2c_10_refused", "z2ui5_cl_cgui_r2c_10", true);
  assert.equal(draft.result.kind, "refused");
  if (draft.result.kind === "refused") {
    assert.equal(draft.result.partial, true);
    assert.ok(draft.result.classFile && fs.existsSync(draft.result.classFile));
  }
});

// ---------------------------------------------------------------- manifest

test("the checkout setting is machine scoped and restricted - it picks the program that runs", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const setting = pkg.contributes.configuration.properties["abap2ui5.report2cloud.path"];
  assert.equal(setting.scope, "machine");
  assert.equal(setting.default, "");
  assert.ok(pkg.capabilities.untrustedWorkspaces.restrictedConfigurations.includes("abap2ui5.report2cloud.path"));
  const context = pkg.contributes.menus["abap2ui5.editorContext"].find(
    (m: { command?: string }) => m.command === "abap2ui5.migrateReport"
  );
  assert.match(context.when, /!isWeb/);
  assert.match(context.when, /prog\\\.abap/);
});
