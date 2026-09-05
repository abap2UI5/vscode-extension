import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { checkXmlSource } from "@abap2ui5/linter";
import { applyDirectives, defaultSeverityOf } from "@abap2ui5/linter/findings";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import {
  augmentedPath,
  checkerCwd,
  cliCollects,
  diagnosticSeverityKey,
  directiveLine,
  isCheckableSource,
  settleRenderErrors,
  suppressionEdits,
  SuppressionEdit,
  findingsBarText,
  findingsBarTooltip,
  groupByRule,
  ruleSummary,
  parseRenderReport,
  renderGateNote,
  parseScreenshotErrors,
  parseScreenshotOutput,
  plannedFixes,
  screenshotArgs,
  screenshotUnsupported,
  shotLabel,
  viewportCount,
  quoteForShell,
  sourceLabel,
  resolveCheckerCommand,
  splitCommandLine,
  scratchFileName,
} from "../checkcore";

/*
 * The view check's `vscode`-free decisions: what is checkable, which
 * command the render gate runs, the scratch-file naming the CLI depends on,
 * and the reading of its JSON report.
 */

const BUILDER_CLASS =
  "CLASS zcl_app DEFINITION PUBLIC.\nENDCLASS.\n" +
  "CLASS zcl_app IMPLEMENTATION.\n  METHOD z2ui5_if_app~main.\n" +
  "    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).\n" +
  "  ENDMETHOD.\nENDCLASS.\n";

// ---------------------------------------------------------------------------
// isCheckableSource
// ---------------------------------------------------------------------------

test("view and fragment XML are always checkable", () => {
  assert.equal(isCheckableSource("main.view.xml", "xml", "<View/>"), true);
  assert.equal(isCheckableSource("frag.fragment.xml", undefined, ""), true);
});

test("ABAP is checkable only when it calls the builder", () => {
  assert.equal(isCheckableSource("zcl_app.clas.abap", "abap", BUILDER_CLASS), true);
  assert.equal(
    isCheckableSource("zcl_app.clas.abap", "abap", "CLASS zcl_app DEFINITION."),
    false
  );
});

test("the abap language id suffices, and so does the file extension", () => {
  // an .abap file without the abap language id (other ABAP extensions)
  assert.equal(isCheckableSource("zcl_app.abap", "plaintext", BUILDER_CLASS), true);
  // an abap-language buffer without the extension (adt scheme)
  assert.equal(isCheckableSource("zcl_app", "abap", BUILDER_CLASS), true);
});

test("a log quoting builder code is not checkable", () => {
  assert.equal(isCheckableSource("notes.md", "markdown", BUILDER_CLASS), false);
  assert.equal(isCheckableSource("out.log", "log", BUILDER_CLASS), false);
});

// ---------------------------------------------------------------------------
// scratchFileName - the CLI only looks at *.clas.abap and view XML
// ---------------------------------------------------------------------------

test("recognised names survive as they are", () => {
  assert.equal(scratchFileName("/ws/zcl_app.clas.abap"), "zcl_app.clas.abap");
  assert.equal(scratchFileName("/ws/main.view.xml"), "main.view.xml");
  assert.equal(scratchFileName("/ws/frag.fragment.xml"), "frag.fragment.xml");
});

test("anything else becomes a *.clas.abap the checker will pick up", () => {
  assert.equal(scratchFileName("/ws/zcl_app.abap"), "zcl_app.clas.abap");
  assert.equal(scratchFileName("zcl_app"), "zcl_app.clas.abap");
});

// ---------------------------------------------------------------------------
// resolveCheckerCommand - the fallback ladder
// ---------------------------------------------------------------------------

const NO_GATE = {
  explicit: "",
  installedGate: undefined,
  reposRoot: "",
  checkoutDirs: ["linter", "abap2UI5-linter", "ai-view-check"],
  exists: () => false,
};

test("an explicit setting wins and is split into cmd and args", () => {
  const cmd = resolveCheckerCommand({
    ...NO_GATE,
    explicit: "node /home/me/linter/cli.mjs",
    installedGate: { cli: "/ignored", browsersPath: "/ignored" },
  });
  assert.deepEqual(cmd, {
    cmd: "node",
    args: ["/home/me/linter/cli.mjs"],
    env: {},
    installed: true,
  });
});

test("an installed render gate runs with its own browsers path", () => {
  const cmd = resolveCheckerCommand({
    ...NO_GATE,
    installedGate: { cli: "/store/gate/cli.mjs", browsersPath: "/store/browsers" },
  });
  assert.equal(cmd.cmd, "node");
  assert.deepEqual(cmd.args, ["/store/gate/cli.mjs"]);
  assert.equal(cmd.env.PLAYWRIGHT_BROWSERS_PATH, "/store/browsers");
  assert.equal(cmd.installed, true);
});

test("a checkout under the repos root is found by its known names", () => {
  const cli = path.join("/repos", "abap2UI5-linter", "cli.mjs");
  const cmd = resolveCheckerCommand({
    ...NO_GATE,
    reposRoot: "/repos",
    exists: (file) => file === cli,
  });
  assert.equal(cmd.cmd, "node");
  assert.deepEqual(cmd.args, [cli]);
  assert.equal(cmd.installed, true);
});

test("with nothing installed npx from GitHub is the last resort", () => {
  const cmd = resolveCheckerCommand(NO_GATE);
  assert.equal(cmd.cmd, "npx");
  assert.deepEqual(cmd.args, ["--yes", "github:abap2UI5/linter"]);
  assert.equal(cmd.installed, false);
});

// ---------------------------------------------------------------------------
// augmentedPath - the GUI-launched-VS-Code PATH fix
// ---------------------------------------------------------------------------

test("the usual npx locations are appended once", () => {
  const out = augmentedPath("darwin", "/usr/bin");
  assert.equal(out, ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(path.delimiter));
  // already present: nothing doubled
  const already = augmentedPath("linux", out);
  assert.equal(already, out);
});

test("on Windows the PATH is left alone", () => {
  assert.equal(augmentedPath("win32", "C:\\Windows"), "C:\\Windows");
});

// ---------------------------------------------------------------------------
// parseRenderReport
// ---------------------------------------------------------------------------

test("a report with render errors comes through", () => {
  const parsed = parseRenderReport(
    'npx noise...\n{"results":[{"renderErrors":["Error: boom"],"skippedRender":false}]}'
  );
  assert.deepEqual(parsed, {
    ok: true,
    result: { renderErrors: ["Error: boom"], skippedRender: false },
  });
});

test("a skipped render is reported as such", () => {
  const parsed = parseRenderReport('{"results":[{"skippedRender":true}]}');
  assert.ok(parsed.ok);
  assert.equal(parsed.result.skippedRender, true);
  assert.deepEqual(parsed.result.renderErrors, []);
});

test("an empty result set still parses to a clean answer", () => {
  const parsed = parseRenderReport('{"results":[]}');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.result, { renderErrors: [], skippedRender: false });
});

test("no JSON at all is told apart from broken JSON", () => {
  assert.deepEqual(parseRenderReport("npm ERR! something"), {
    ok: false,
    reason: "no-json",
  });
  const broken = parseRenderReport('{"results": [');
  assert.ok(!broken.ok);
  assert.equal(broken.reason, "broken-json");
  assert.ok(broken.detail);
});

// ---------------------------------------------------------------------------
// renderGateNote - what the check may claim about its render half
// ---------------------------------------------------------------------------

test("a render gate that reported qualifies nothing", () => {
  assert.equal(renderGateNote("ok"), "");
});

test("every way the render half did not run says so", () => {
  // the whole point: a timeout, an unreadable report and a checker that
  // could not be started used to end in an empty renderErrors array, which
  // is indistinguishable from a clean render - and the on-demand command
  // then announced "view check passed" for a check that ran half
  for (const outcome of [
    "skipped-helpers",
    "skipped-not-started",
    "skipped-busy",
    "timeout",
    "spawn-failed",
    "no-report",
    "abandoned",
  ] as const) {
    const note = renderGateNote(outcome);
    assert.match(note, /^ \(render gate skipped - .+\)$/, outcome);
  }
});

test("the timeout and the unreadable report are told apart", () => {
  assert.notEqual(renderGateNote("timeout"), renderGateNote("no-report"));
  assert.match(renderGateNote("timeout"), /timed out/);
  assert.match(renderGateNote("no-report"), /no report/);
  assert.match(renderGateNote("skipped-helpers"), /helper methods/);
});

// ---------------------------------------------------------------------------
// plannedFixes
// ---------------------------------------------------------------------------

test("fixes are planned in source order, across findings", () => {
  const planned = plannedFixes([
    { fixes: [{ start: 30, end: 34, text: "d" }] },
    { fixes: [{ start: 4, end: 8, text: "a" }, { start: 10, end: 12, text: "b" }] },
    { fixes: [{ start: 20, end: 22, text: "c" }] },
  ]);
  assert.deepEqual(
    planned.map((f) => f.text),
    ["a", "b", "c", "d"]
  );
});

test("an overlapping fix is left for the next run, not merged", () => {
  const planned = plannedFixes([
    { fixes: [{ start: 10, end: 20, text: "wide" }] },
    { fixes: [{ start: 15, end: 18, text: "inside" }] },
  ]);
  assert.deepEqual(planned, [{ start: 10, end: 20, text: "wide" }]);
});

test("a fix starting where the previous one ended still applies", () => {
  const planned = plannedFixes([
    { fixes: [{ start: 0, end: 5, text: "one" }] },
    { fixes: [{ start: 5, end: 5, text: "$" }] },
  ]);
  assert.equal(planned.length, 2);
});

test("findings without fixes contribute nothing to count or plan", () => {
  assert.deepEqual(plannedFixes([{}, { fixes: [] }]), []);
  assert.deepEqual(plannedFixes([]), []);
});

// ---------------------------------------------------------------------------
// The screenshot run behind the systemless preview
// ---------------------------------------------------------------------------

const SHOT = {
  target: "/tmp/scratch/zcl_app.clas.abap",
  out: "/tmp/scratch/view.png",
  theme: "sap_horizon",
  viewport: "390x844",
};

test("the screenshot call carries the file, the target and both dials", () => {
  assert.deepEqual(screenshotArgs(SHOT), [
    "/tmp/scratch/zcl_app.clas.abap",
    "--screenshot",
    "/tmp/scratch/view.png",
    "--screenshot-theme",
    "sap_horizon",
    "--screenshot-size",
    "390x844",
  ]);
});

test("a settings typo falls back to the CLI default instead of failing the run", () => {
  // the CLI refuses a bad value with exit 2 - which would turn a mistyped
  // setting into a preview that only ever says "bad usage"
  const args = screenshotArgs({ ...SHOT, theme: "sap horizon; rm -rf /", viewport: "big" });
  assert.deepEqual(args, [SHOT.target, "--screenshot", SHOT.out]);
});

test("stdout is read as the written paths, and nothing else is", () => {
  const stdout = "/tmp/x/view-zcl_app.png\n/tmp/x/view-zcl_app-2.png\n";
  assert.deepEqual(parseScreenshotOutput(stdout), [
    "/tmp/x/view-zcl_app.png",
    "/tmp/x/view-zcl_app-2.png",
  ]);
  assert.deepEqual(parseScreenshotOutput("npm WARN something\n"), []);
});

test("render errors are lifted off stderr without the scratch path", () => {
  const stderr =
    "abap2ui5lint: /tmp/abap2ui5-preview-x/zcl_app.clas.abap - CREATE: no such control\n" +
    "some unrelated line\n";
  assert.deepEqual(parseScreenshotErrors(stderr), ["CREATE: no such control"]);
});

test("an older render gate is told apart from a broken run", () => {
  assert.equal(
    screenshotUnsupported("abap2ui5lint: unknown option '--screenshot'\nusage: ..."),
    true
  );
  assert.equal(screenshotUnsupported("abap2ui5lint: no view to photograph"), false);
});

// ---------------------------------------------------------------------------
// The status bar's one line
// ---------------------------------------------------------------------------

test("a clean file says so rather than going blank", () => {
  // silence is indistinguishable from a check that never ran
  assert.equal(
    findingsBarText({ errors: 0, warnings: 0, hints: 0, fixable: 0 }),
    "$(check) abap2UI5"
  );
  assert.match(
    findingsBarTooltip({ errors: 0, warnings: 0, hints: 0, fixable: 0 }),
    /nothing found/
  );
});

test("only the severities that occur take up room", () => {
  assert.equal(
    findingsBarText({ errors: 2, warnings: 0, hints: 0, fixable: 0 }),
    "$(error) 2"
  );
  assert.equal(
    findingsBarText({ errors: 1, warnings: 3, hints: 2, fixable: 4 }),
    "$(error) 1 $(warning) 3 $(info) 2 $(wrench) 4"
  );
});

test("the tooltip spells out the counts and whether a fix exists", () => {
  assert.equal(
    findingsBarTooltip({ errors: 1, warnings: 2, hints: 0, fixable: 1 }),
    "abap2UI5 view check: 1 error, 2 warnings. 1 of them can be corrected " +
      "mechanically. Click to open the abap2UI5 Findings view."
  );
  assert.match(
    findingsBarTooltip({ errors: 0, warnings: 1, hints: 0, fixable: 0 }),
    /None of them can be corrected/
  );
});

test("the tooltip always says what a click does", () => {
  // the counts never say it, so every variant of the sentence has to
  for (const counts of [
    { errors: 0, warnings: 0, hints: 0, fixable: 0 },
    { errors: 1, warnings: 0, hints: 0, fixable: 1 },
  ]) {
    assert.match(
      findingsBarTooltip(counts),
      /Click to open the abap2UI5 Findings view\.$/
    );
  }
});

// ---------------------------------------------------------------------------
// The device matrix and what a written picture is of
// ---------------------------------------------------------------------------

test("a viewport setting may name several devices", () => {
  assert.equal(viewportCount("1280x900"), 1);
  assert.equal(viewportCount("390x844,1280x900"), 2);
  // a broken setting is one viewport - the CLI default - not a crash
  assert.equal(viewportCount("wide"), 1);
});

test("the matrix reaches the CLI as one flag, whitespace and all", () => {
  const args = screenshotArgs({ ...SHOT, viewport: "390x844 , 1280x900" });
  assert.ok(args.includes("--screenshot-size"));
  assert.equal(args[args.indexOf("--screenshot-size") + 1], "390x844,1280x900");
});

test("preview data travels as its own flag, and only when there is some", () => {
  assert.ok(!screenshotArgs(SHOT).includes("--screenshot-model"));
  const args = screenshotArgs({ ...SHOT, model: "/ws/zcl_app.mock.json" });
  assert.equal(args[args.indexOf("--screenshot-model") + 1], "/ws/zcl_app.mock.json");
});

test("a picture says what it is of, read back from its name", () => {
  // the CLI names files rather than reporting a structure - one path per line
  // is the whole machine contract
  assert.equal(shotLabel("/tmp/x/view-zcl_app-390x844.png", 2), "390x844");
  assert.equal(shotLabel("/tmp/x/view-zcl_app-2-1280x900.png", 2), "1280x900 · view 2");
  // one viewport: the size is noise, the document index is not
  assert.equal(shotLabel("/tmp/x/view-zcl_app-2.png", 1), "view 2");
  assert.equal(shotLabel("/tmp/x/view.png", 1), "view.png");
});

// ---------------------------------------------------------------------------
// The findings view: grouped by rule, worst first
// ---------------------------------------------------------------------------

const ENTRY = { message: "…" };

test("the same rule in several files is one group, counted", () => {
  const groups = groupByRule([
    { ...ENTRY, rule: "unknown-binding-path", severity: "error", file: "/a.abap", line: 3 },
    { ...ENTRY, rule: "unknown-binding-path", severity: "error", file: "/b.abap", line: 1 },
    { ...ENTRY, rule: "unknown-binding-path", severity: "error", file: "/a.abap", line: 9 },
    { ...ENTRY, rule: "event-without-handler", severity: "hint", file: "/a.abap", line: 2 },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].rule, "unknown-binding-path");
  assert.equal(groups[0].count, 3);
  assert.equal(groups[0].files, 2);
  assert.equal(ruleSummary(groups[0]), "3 findings in 2 files");
});

test("the top of the list is where the next decision is", () => {
  // worst severity first, then sheer quantity - a hint reported forty times
  // must not outrank an error
  const groups = groupByRule([
    { ...ENTRY, rule: "hinty", severity: "hint", file: "/a.abap", line: 1 },
    { ...ENTRY, rule: "hinty", severity: "hint", file: "/a.abap", line: 2 },
    { ...ENTRY, rule: "hinty", severity: "hint", file: "/a.abap", line: 3 },
    { ...ENTRY, rule: "warny", severity: "warning", file: "/a.abap", line: 4 },
    { ...ENTRY, rule: "erry", severity: "error", file: "/a.abap", line: 5 },
  ]);
  assert.deepEqual(groups.map((g) => g.rule), ["erry", "warny", "hinty"]);
});

test("a rule reported at two severities takes the worse one", () => {
  const [group] = groupByRule([
    { ...ENTRY, rule: "member-too-new", severity: "warning", file: "/a.abap", line: 1 },
    { ...ENTRY, rule: "member-too-new", severity: "error", file: "/a.abap", line: 2 },
  ]);
  assert.equal(group.severity, "error");
});

test("within a rule the findings are in reading order", () => {
  const [group] = groupByRule([
    { ...ENTRY, rule: "r", severity: "error", file: "/b.abap", line: 1 },
    { ...ENTRY, rule: "r", severity: "error", file: "/a.abap", line: 9 },
    { ...ENTRY, rule: "r", severity: "error", file: "/a.abap", line: 2 },
  ]);
  assert.deepEqual(
    group.entries.map((e) => `${e.file}:${e.line}`),
    ["/a.abap:2", "/a.abap:9", "/b.abap:1"]
  );
});

test("nothing found is an empty list, not a group of nothing", () => {
  assert.deepEqual(groupByRule([]), []);
});

// ---------------------------------------------------------------------------
// Command lines with spaces in them
// ---------------------------------------------------------------------------

test("a quoted program path survives the split", () => {
  // the normal shape of this setting on Windows - splitting on whitespace
  // alone turned it into four pieces, none of which exist
  const cmd = resolveCheckerCommand({
    ...NO_GATE,
    explicit: `"C:\\Program Files\\nodejs\\node.exe" "C:\\My Tools\\cli.mjs" --flag`,
  });
  assert.deepEqual(cmd, {
    cmd: "C:\\Program Files\\nodejs\\node.exe",
    args: ["C:\\My Tools\\cli.mjs", "--flag"],
    env: {},
    installed: true,
  });
});

test("splitting a command line handles quotes, spacing and nothing at all", () => {
  assert.deepEqual(splitCommandLine("node cli.mjs"), ["node", "cli.mjs"]);
  assert.deepEqual(splitCommandLine("  node   cli.mjs  "), ["node", "cli.mjs"]);
  assert.deepEqual(splitCommandLine(`'/opt/my tools/node' cli.mjs`), [
    "/opt/my tools/node",
    "cli.mjs",
  ]);
  assert.deepEqual(splitCommandLine(""), []);
});

test("a Windows shell argument with a space in it is quoted", () => {
  // the render gate writes its scratch file under the user's TEMP, and a
  // profile called "John Smith" made the gate answer "no JSON" for good
  const scratch = "C:\\Users\\John Smith\\AppData\\Local\\Temp\\x.clas.abap";
  assert.equal(quoteForShell(scratch, "win32"), `"${scratch}"`);
  assert.equal(quoteForShell("--json", "win32"), "--json");
});

test("cmd.exe metacharacters force the quotes, % and ! included", () => {
  // quotes do not stop cmd expanding %VAR% - nothing can - but an argument
  // carrying any of these must at least not be split or interpreted
  assert.equal(quoteForShell("a%PATH%b", "win32"), '"a%PATH%b"');
  assert.equal(quoteForShell("say!", "win32"), '"say!"');
  assert.equal(quoteForShell('he said "hi"', "win32"), '"he said ""hi"""');
});

test("an empty Windows argument survives the shell", () => {
  // returned bare it disappears between two spaces, and cmd.exe hands the
  // program one argument fewer than it was given - every later argument
  // moves up one position
  assert.equal(quoteForShell("", "win32"), '""');
});

test("posix arguments are single-quoted, so shell:true is safe there too", () => {
  // the current callers only use a shell on Windows, but the contract of
  // RunOptions.shell is that both platforms are - it used to be a no-op here
  assert.equal(quoteForShell("/tmp/a b/x.abap", "linux"), "'/tmp/a b/x.abap'");
  assert.equal(quoteForShell("--json", "linux"), "--json");
  assert.equal(quoteForShell("we'ird$(x)", "linux"), "'we'\\''ird$(x)'");
  assert.equal(quoteForShell("", "linux"), "''");
});

test("a finding with several fix spans is still one finding", () => {
  // the "fix all N finding(s)" label counted edits, so one finding carrying
  // three spans announced three findings
  const findings = [
    { fixes: [{ start: 0, end: 2, text: "a" }, { start: 4, end: 6, text: "b" }] },
    { fixes: [{ start: 10, end: 12, text: "c" }] },
  ];
  const planned = plannedFixes(findings);
  assert.equal(planned.length, 3, "three spans are applied");
  const applied = new Set(planned);
  const covered = findings.filter((f) =>
    (f.fixes ?? []).some((fix) => applied.has(fix))
  ).length;
  assert.equal(covered, 2, "from two findings");
});

// ---------------------------------------------------------------------------
// Naming a source that may not be a file
// ---------------------------------------------------------------------------

test("a file is named by its file name", () => {
  assert.equal(sourceLabel("/repo/src/zcl_app.clas.abap"), "zcl_app.clas.abap");
});

test("an ADT path is named by the segment that means something", () => {
  // `…/oo/classes/zcl_app/source/main` - the last segment names nothing, and
  // a findings tree full of "main" entries tells you nothing about which
  // class each one is in
  assert.equal(
    sourceLabel("/sap/bc/adt/oo/classes/zcl_travel_app/source/main"),
    "zcl_travel_app"
  );
});

test("a class name handed in always wins", () => {
  assert.equal(
    sourceLabel("/sap/bc/adt/oo/classes/zcl_app/source/main", "ZCL_APP"),
    "ZCL_APP"
  );
});

test("a path with nothing but generic segments still answers", () => {
  assert.equal(sourceLabel("/source/main"), "main");
  assert.equal(sourceLabel(""), "");
});

// ---------------------------------------------------------------------------
// checkerCwd - a working directory spawn can actually enter
// ---------------------------------------------------------------------------

const onDisk = (dir: string) => dir === "/work/project";

test("a real workspace folder is where the checker runs", () => {
  assert.equal(
    checkerCwd({ fsPath: "/work/project", scheme: "file" }, "/home/me", onDisk),
    "/work/project"
  );
});

test("no workspace folder falls back to the home directory", () => {
  assert.equal(checkerCwd(undefined, "/home/me", onDisk), "/home/me");
});

test("an ADT document's folder is not a directory, and is not used as one", () => {
  // The regression: a class opened through ADT has a workspace folder whose
  // path is a repotree route. spawn answers ENOENT for a cwd that is not
  // there and names the COMMAND, so this arrived as "node not found" - and
  // the offered remedy, reinstalling the 275 MB render gate, could not fix it.
  assert.equal(
    checkerCwd(
      { fsPath: "/repotree-v1/TEST2/Local Objects ($TMP)/LARS", scheme: "repotree-v1" },
      "/home/me",
      onDisk
    ),
    "/home/me"
  );
});

test("a file-scheme folder that is not on disk is refused too", () => {
  assert.equal(
    checkerCwd({ fsPath: "/gone", scheme: "file" }, "/home/me", onDisk),
    "/home/me"
  );
});

/*
 * Where a disable directive may be written.
 *
 * The linter records an XML finding at the offset of the attribute it is
 * about, and controls in the corpus spread their attributes over lines. A
 * comment inserted above such a line lands INSIDE the start tag, and the view
 * then fails to load - a worse outcome than the finding being waived.
 */

test("directiveLine leaves ABAP alone - a full-line comment is legal anywhere", () => {
  const abap = [
    "view->ele( n = `Page`",
    "    )->tag( n = `Button`",
    "        )->a( n = `text` v = `Go` ).",
  ].join("\n");
  assert.deepEqual(directiveLine(abap, 2, false), { open: 2, close: 2 });
  assert.deepEqual(directiveLine(abap, 0, false), { open: 0, close: 0 });
});

test("directiveLine climbs out of a multi-line XML start tag", () => {
  const xml = [
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">',
    "  <Button",
    '    text="Go"',
    '    nosuchprop="x"/>',
    "</mvc:View>",
  ].join("\n");
  // the finding sits on `nosuchprop`, the comment has to go above `<Button`
  // - and the tag runs to the `/>` on line 3
  assert.deepEqual(directiveLine(xml, 3, true), { open: 1, close: 3 });
  assert.deepEqual(directiveLine(xml, 2, true), { open: 1, close: 3 });
});

test("directiveLine keeps the line when the tag is closed on it", () => {
  const xml = [
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">',
    '  <Button text="Go" nosuchprop="x"/>',
    "</mvc:View>",
  ].join("\n");
  assert.deepEqual(directiveLine(xml, 1, true), { open: 1, close: 1 });
});

test("directiveLine is not fooled by < inside attribute values or comments", () => {
  const xml = [
    '<mvc:View xmlns="sap.m">',
    '  <Text text="a &lt; b and a < b"/>',
    "  <!-- <Button -->",
    "  <Button",
    '    nosuchprop="x"/>',
    "</mvc:View>",
  ].join("\n");
  // line 4 is inside the start tag opened on line 3
  assert.deepEqual(directiveLine(xml, 4, true), { open: 3, close: 4 });
  // line 2 is between tags - its own line is fine
  assert.deepEqual(directiveLine(xml, 2, true), { open: 2, close: 2 });
});

test("directiveLine handles an apostrophe-quoted attribute holding a >", () => {
  const xml = [
    '<mvc:View xmlns="sap.m">',
    "  <Text",
    "    text='a > b'",
    '    nosuchprop="x"/>',
    "</mvc:View>",
  ].join("\n");
  assert.deepEqual(directiveLine(xml, 3, true), { open: 1, close: 3 });
});

test("directiveLine survives the prolog", () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mvc:View xmlns="sap.m">',
    "  <Button",
    '    nosuchprop="x"/>',
    "</mvc:View>",
  ].join("\n");
  assert.deepEqual(directiveLine(xml, 3, true), { open: 2, close: 3 });
});

test("directiveLine is CRLF-exact - the drift grew by one column per line", () => {
  // `length + 1` per line undercounted every CRLF break, so by line 40 the
  // scan stopped 40 characters short of the finding's line: the directive
  // then landed above the wrong line, or inside a start tag
  const lines = [
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">',
    '  <Page title="a page with a somewhat longer title">',
    '  <Input value="v"/>',
    '  <Text text="t"/>',
    '  <Button text="Go" nosuchprop="x"/>',
    "  </Page>",
    "</mvc:View>",
  ];
  const lf = lines.join("\n");
  const crlf = lines.join("\r\n");
  // a single-line tag: the directive goes directly above the finding's line
  assert.deepEqual(directiveLine(lf, 4, true), { open: 4, close: 4 });
  assert.deepEqual(directiveLine(crlf, 4, true), { open: 4, close: 4 });
});

test("directiveLine climbs out of a CRLF multi-line start tag too", () => {
  const crlf = [
    '<mvc:View xmlns="sap.m">',
    "  <Button",
    '    text="Go"',
    '    nosuchprop="x"/>',
    "</mvc:View>",
  ].join("\r\n");
  assert.deepEqual(directiveLine(crlf, 3, true), { open: 1, close: 3 });
  assert.deepEqual(directiveLine(crlf, 2, true), { open: 1, close: 3 });
});

test("directiveLine runs an unterminated start tag to the end of the text", () => {
  const xml = ['<mvc:View xmlns="sap.m">', "  <Button", '    text="Go"', '    nosuchprop="x"'].join("\n");
  assert.deepEqual(directiveLine(xml, 3, true), { open: 1, close: 3 });
});

// ---------------------------------------------------------------------------
// The suppression edits, judged by the linter that has to honour them
// ---------------------------------------------------------------------------

/** The snapshot next to the test bundle - what the gate itself loads. */
const SNAPSHOT = path.join(__dirname, "properties.json");

const applyEdits = (text: string, edits: readonly SuppressionEdit[]): string =>
  [...edits]
    .sort((a, b) => b.offset - a.offset)
    .reduce((t, e) => t.slice(0, e.offset) + e.text + t.slice(e.offset), text);

const MULTI_LINE_TAG = [
  '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">',
  "  <Button",
  '    text="Go"',
  '    nosuchprop="x"/>',
  "</mvc:View>",
].join("\n");

/** The 0-based line the linter puts `unknown-property` on - the ATTRIBUTE's. */
const findingLine = (xml: string): number => {
  const f = checkXmlSource(xml, { snapshot: SNAPSHOT, render: false }).findings.find(
    (finding) => finding.type === "unknown-property"
  );
  assert.ok(f?.line, "the fixture stopped producing unknown-property");
  return f.line - 1;
};

test("an attribute inside a multi-line start tag gets a disable/enable pair the linter honours", () => {
  const line = findingLine(MULTI_LINE_TAG);
  assert.equal(line, 3, "the linter places the finding on the attribute's line");
  /* The control: `disable-next-line` above `<Button` is what used to be
   * written. It protects line 1 - and the finding is on line 3, so the
   * linter kept reporting it. This is the fact the pair exists for. */
  const naive = MULTI_LINE_TAG.replace(
    "  <Button",
    "  <!-- abap2ui5lint-disable-next-line unknown-property -->\n  <Button"
  );
  assert.ok(
    checkXmlSource(naive, { snapshot: SNAPSHOT, render: false }).findings.some(
      (f) => f.type === "unknown-property"
    ),
    "the linter now honours a next-line directive above a multi-line tag - the pair is no longer needed"
  );
  const edits = suppressionEdits(MULTI_LINE_TAG, line, true, "unknown-property");
  assert.deepEqual(
    edits.map((e) => e.text),
    ["  <!-- abap2ui5lint-disable unknown-property -->\n", "  <!-- abap2ui5lint-enable -->\n"]
  );
  const waived = applyEdits(MULTI_LINE_TAG, edits);
  assert.equal(
    waived,
    [
      '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">',
      "  <!-- abap2ui5lint-disable unknown-property -->",
      "  <Button",
      '    text="Go"',
      '    nosuchprop="x"/>',
      "  <!-- abap2ui5lint-enable -->",
      "</mvc:View>",
    ].join("\n")
  );
  assert.deepEqual(
    checkXmlSource(waived, { snapshot: SNAPSHOT, render: false }).findings.map((f) => f.type),
    [],
    "the pinned linter does not honour the pair the quick fix writes"
  );
});

test("a single-line tag keeps disable-next-line, which the linter honours as before", () => {
  const xml = [
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">',
    '  <Button text="Go" nosuchprop="x"/>',
    "</mvc:View>",
  ].join("\n");
  const edits = suppressionEdits(xml, findingLine(xml), true, "unknown-property");
  assert.deepEqual(
    edits.map((e) => e.text),
    ["  <!-- abap2ui5lint-disable-next-line unknown-property -->\n"]
  );
  assert.deepEqual(
    checkXmlSource(applyEdits(xml, edits), { snapshot: SNAPSHOT, render: false }).findings,
    []
  );
});

test("the pair uses the file's own line ending", () => {
  const crlf = MULTI_LINE_TAG.replace(/\n/g, "\r\n");
  const edits = suppressionEdits(crlf, 3, true, "unknown-property");
  assert.ok(edits.every((e) => e.text.endsWith("\r\n")));
  assert.ok(!applyEdits(crlf, edits).includes("-->\n"), "a lone LF crept into a CRLF file");
});

test("a tag that closes on the last line, without a line break, still gets its enable", () => {
  const xml = ['<mvc:View xmlns="sap.m">', "  <Button", '    nosuchprop="x"/>'].join("\n");
  const edits = suppressionEdits(xml, 2, true, "unknown-property");
  const waived = applyEdits(xml, edits);
  assert.ok(waived.endsWith('    nosuchprop="x"/>\n  <!-- abap2ui5lint-enable -->'), waived);
  // the linter reads the same pair whether or not the enable is the last line
  const findings: PropertyFinding[] = [{ type: "unknown-property", line: 4 }];
  assert.deepEqual(applyDirectives(findings, waived), []);
});

test("ABAP gets the next-line comment above the finding's line, indented like it", () => {
  const abap = [
    "    view->ele( n = `Page`",
    "        )->tag( n = `Button`",
    "            )->a( n = `nosuchprop` v = `x` ).",
  ].join("\n");
  const edits = suppressionEdits(abap, 2, false, "unknown-property");
  assert.deepEqual(edits, [
    {
      offset: abap.indexOf("            )->a("),
      text: '            " abap2ui5lint-disable-next-line unknown-property\n',
    },
  ]);
  const waived = applyEdits(abap, edits);
  // the finding moved down by the inserted line: line 3 -> 4 (1-based)
  const findings: PropertyFinding[] = [{ type: "unknown-property", line: 4 }];
  assert.deepEqual(applyDirectives(findings, waived), []);
});

// ---------------------------------------------------------------------------
// What the CLI's directory walk collects - the sweep and the baseline follow it
// ---------------------------------------------------------------------------

test("cliCollects takes the names collectFiles takes, and no others", () => {
  for (const yes of [
    "src/zcl_app.clas.abap",
    "src/01/deep/zcl_app.clas.abap",
    "zcl_app.clas.abap",
    "webapp/view/Main.view.xml",
    "webapp/fragment/Dialog.fragment.xml",
    "./src/zcl_app.clas.abap",
    "src\\zcl_app.clas.abap",
  ]) {
    assert.ok(cliCollects(yes), `${yes} is collected by the CLI`);
  }
  for (const no of [
    "src/zcl_app.clas.testclasses.abap",
    "src/zcl_app.clas.locals_imp.abap",
    "src/zcl_app.clas.locals_def.abap",
    "src/zreport.prog.abap",
    "src/zif_app.intf.abap",
    "src/zcl_app.clas.xml",
    "src/other.xml",
    "node_modules/pkg/src/zcl_app.clas.abap",
    "src/node_modules/zcl_app.clas.abap",
    ".hidden/zcl_app.clas.abap",
    "src/.zcl_app.clas.abap",
    "",
  ]) {
    assert.ok(!cliCollects(no), `${no} is never collected by the CLI`);
  }
});

test("cliCollects prunes what the config's ignore patterns prune - directories included", () => {
  const ignore = ["^src/99/", "generated$", "/vendor/"];
  assert.ok(!cliCollects("src/99/zcl_old.clas.abap", { ignore }));
  assert.ok(cliCollects("src/01/zcl_new.clas.abap", { ignore }));
  // `generated$` matches the DIRECTORY on the way down, as the walk tests
  // each entry before descending - the file name itself never matches it
  assert.ok(!cliCollects("src/generated/zcl_gen.clas.abap", { ignore }));
  assert.ok(!cliCollects("src/vendor/zcl_gen.clas.abap", { ignore }));
  // a pattern written against the absolute spelling a discovered config's
  // `paths` produce matches through `root`
  assert.ok(!cliCollects("src/zcl_app.clas.abap", { ignore: ["^/repo/src/"], root: "/repo" }));
  assert.ok(cliCollects("src/zcl_app.clas.abap", { ignore: ["^/repo/src/"] }));
  // a pattern that does not compile suppresses nothing rather than everything
  assert.ok(cliCollects("src/zcl_app.clas.abap", { ignore: ["("] }));
});

// ---------------------------------------------------------------------------
// rules['render-error'], applied against the real file
// ---------------------------------------------------------------------------

test("settleRenderErrors leaves the errors alone without a render-error entry", () => {
  const settled = settleRenderErrors(["XMLView.create failed"], {}, ["/repo/src/zcl_app.clas.abap"]);
  assert.deepEqual(settled.renderErrors, ["XMLView.create failed"]);
  assert.equal(settled.severity, undefined);
  assert.equal(settled.waived, 0);
  assert.equal(settled.staleWaiver, false);
  assert.deepEqual(settleRenderErrors(["x"], undefined, []).renderErrors, ["x"]);
});

test("settleRenderErrors waives on false and on an exclude that matches the REAL file", () => {
  const rules = { "render-error": { exclude: ["^src/02/"] } };
  // the scratch copy the CLI ran on matches nothing - which is the defect
  const scratch = settleRenderErrors(["boom"], rules, ["/tmp/abap2ui5-viewcheck-x/zcl_app.clas.abap"]);
  assert.deepEqual(scratch.renderErrors, ["boom"]);
  // the config-relative spelling of the real file does
  const real = settleRenderErrors(["boom"], rules, [
    "/repo/src/02/zcl_app.clas.abap",
    "src/02/zcl_app.clas.abap",
  ]);
  assert.deepEqual(real.renderErrors, []);
  assert.equal(real.waived, 1);
  assert.equal(real.staleWaiver, false);
  // backslashes are not what the pattern is about
  assert.equal(
    settleRenderErrors(["boom"], rules, ["src\\02\\zcl_app.clas.abap"]).waived,
    1
  );
  const off = settleRenderErrors(["boom", "bang"], { "render-error": false }, ["x"]);
  assert.equal(off.waived, 2);
  assert.equal(off.staleWaiver, false, "switched off wholesale is never stale");
});

test("settleRenderErrors reports a stale waiver only for an excluded file that rendered clean", () => {
  const rules = { "render-error": { exclude: ["zcl_app"] } };
  assert.equal(settleRenderErrors([], rules, ["src/zcl_app.clas.abap"]).staleWaiver, true);
  // not rendered at all (helpers, no report) - nothing is known about it
  assert.equal(settleRenderErrors([], rules, ["src/zcl_app.clas.abap"], false).staleWaiver, false);
});

test("settleRenderErrors hands on a severity the entry sets, and only a real one", () => {
  assert.equal(
    settleRenderErrors(["boom"], { "render-error": "warning" }, ["x"]).severity,
    "warning"
  );
  assert.equal(
    settleRenderErrors(["boom"], { "render-error": { severity: "Hint" } }, ["x"]).severity,
    "hint"
  );
  assert.equal(
    settleRenderErrors(["boom"], { "render-error": "critical" }, ["x"]).severity,
    undefined
  );
});

test("renderGateNote says when the repo config switched the gate off", () => {
  assert.match(renderGateNote("off-by-config"), /render gate off by config/);
});

// ---------------------------------------------------------------------------
// The severity a finding is shown with is always one the diagnostics map knows
// ---------------------------------------------------------------------------

test("diagnosticSeverityKey keeps a real severity and clamps an unknown one", () => {
  assert.equal(diagnosticSeverityKey({ type: "unknown-property", severity: "warning" }), "warning");
  // no severity on the finding: the linter's default for the rule
  assert.equal(
    diagnosticSeverityKey({ type: "unknown-property" }),
    defaultSeverityOf("unknown-property")
  );
  // `viewCheck.rules` is not validated - a misspelt severity used to reach
  // DIAGNOSTIC_SEVERITY as undefined, which VS Code shows as an Error
  assert.equal(diagnosticSeverityKey({ type: "unknown-property", severity: "critical" }), "hint");
  assert.equal(diagnosticSeverityKey({ type: "unknown-property", severity: "" }), defaultSeverityOf("unknown-property"));
});

// ---------------------------------------------------------------------------
// The frozen builders count as checkable - the gate answers with the
// linter's own frozen-view-builder finding instead of "nothing to check"
// ---------------------------------------------------------------------------

const FROZEN_CLASS =
  "CLASS zcl_old DEFINITION PUBLIC.\nENDCLASS.\n" +
  "CLASS zcl_old IMPLEMENTATION.\n  METHOD z2ui5_if_app~main.\n" +
  "    DATA(view) = z2ui5_cl_xml_view=>factory( ).\n" +
  "  ENDMETHOD.\nENDCLASS.\n";

test("a class on a frozen builder is checkable", () => {
  assert.equal(isCheckableSource("zcl_old.clas.abap", "abap", FROZEN_CLASS), true);
  assert.equal(
    isCheckableSource(
      "zcl_old.clas.abap",
      "abap",
      FROZEN_CLASS.replace("z2ui5_cl_xml_view", "z2ui5_cl_xml_view_cc")
    ),
    true
  );
  // still not a license for quoting files
  assert.equal(isCheckableSource("notes.md", "markdown", FROZEN_CLASS), false);
});
