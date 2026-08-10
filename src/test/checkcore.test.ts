import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
  augmentedPath,
  isCheckableSource,
  parseRenderReport,
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
  "    DATA(view) = z2ui5_cl_ai_xml=>factory( ).\n" +
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
