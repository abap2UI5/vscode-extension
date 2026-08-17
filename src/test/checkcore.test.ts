import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
  augmentedPath,
  isCheckableSource,
  findingsBarText,
  findingsBarTooltip,
  parseRenderReport,
  parseScreenshotErrors,
  parseScreenshotOutput,
  plannedFixes,
  screenshotArgs,
  screenshotUnsupported,
  resolveCheckerCommand,
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
    "abap2UI5 view check: 1 error, 2 warnings. 1 of them can be corrected mechanically."
  );
  assert.match(
    findingsBarTooltip({ errors: 0, warnings: 1, hints: 0, fixable: 0 }),
    /None of them can be corrected/
  );
});
