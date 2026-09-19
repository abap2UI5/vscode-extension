import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { SERVER_DIRS } from "../repolayout";
import {
  classOfFile,
  resolveUnitRunner,
  testIncludeFor,
  unitTestArgs,
  unitTestBanner,
  unitTestCommandLine,
} from "../unitrunner";

/*
 * "Run Unit Tests (No System)" decides three things without vscode: the
 * program, its arguments, and the terminal's first lines. The program follows
 * the ladder the MCP registration walks - a local mcp-server checkout under
 * the repos root before the published package - and the arguments are the
 * ones `npm run test:unit` passes in a project from app-template, plus the
 * class and the framework checkout when they are known.
 */

const root = path.join(path.sep, "repos");

test("an mcp-server checkout under the repos root runs from disk", () => {
  const script = path.join(root, "mcp-server", "scripts", "ci-unit.mjs");
  const runner = resolveUnitRunner({
    reposRoot: root,
    serverDirs: SERVER_DIRS,
    exists: (file) => file === script,
  });
  assert.equal(runner.source, "local checkout");
  assert.equal(runner.cmd, "node");
  assert.deepEqual(runner.args, [script]);
});

test("a checkout made under the repository's previous name is still found", () => {
  // the same lesson the MCP registration learned: a hard-coded "mcp-server"
  // would send the user who cloned `ai-mcp` to npx without a word
  const script = path.join(root, "ai-mcp", "scripts", "ci-unit.mjs");
  const runner = resolveUnitRunner({
    reposRoot: root,
    serverDirs: SERVER_DIRS,
    exists: (file) => file === script,
  });
  assert.equal(runner.source, "local checkout");
  assert.deepEqual(runner.args, [script]);
});

test("without a checkout the published package runs through npx", () => {
  for (const reposRoot of ["", "  ", root]) {
    const runner = resolveUnitRunner({
      reposRoot,
      serverDirs: SERVER_DIRS,
      exists: () => false,
    });
    assert.equal(runner.source, "npx");
    assert.equal(runner.cmd, "npx");
    // the package's bin, exactly as app-template's `npm run test:unit` names it
    assert.deepEqual(runner.args, ["--yes", "-p", "@abap2ui5/mcp-server", "abap2ui5-unit"]);
  }
});

test("a server checkout without the runner script is not a runner", () => {
  // an older mcp-server checkout predates scripts/ci-unit.mjs: node would
  // fail on a missing file where npx can still answer
  const runner = resolveUnitRunner({
    reposRoot: root,
    serverDirs: SERVER_DIRS,
    exists: (file) => file.endsWith("server.mjs"),
  });
  assert.equal(runner.source, "npx");
});

const cwd = path.join(path.sep, "work", "my-app");

test("the whole project: src when there is one, the folder itself otherwise", () => {
  assert.deepEqual(
    unitTestArgs({ cwd, exists: (dir) => dir === path.join(cwd, "src") }),
    ["src"]
  );
  assert.deepEqual(unitTestArgs({ cwd, exists: () => false }), ["."]);
});

test("a class under src runs alone, named the way the runner compares it", () => {
  const args = unitTestArgs({
    cwd,
    classFile: path.join(cwd, "src", "ZCL_MY_APP.clas.abap"),
    exists: () => true,
  });
  assert.deepEqual(args, ["src", "--class", "zcl_my_app"]);
});

test("the test include names the same class", () => {
  const args = unitTestArgs({
    cwd,
    classFile: path.join(cwd, "src", "zcl_my_app.clas.testclasses.abap"),
    exists: () => true,
  });
  assert.deepEqual(args, ["src", "--class", "zcl_my_app"]);
});

test("a class in a nested folder of src still walks src", () => {
  const args = unitTestArgs({
    cwd,
    classFile: path.join(cwd, "src", "apps", "zcl_my_app.clas.abap"),
    exists: () => true,
  });
  assert.deepEqual(args, ["src", "--class", "zcl_my_app"]);
});

test("a class outside src walks its own folder - relative inside the project, absolute outside", () => {
  const inside = unitTestArgs({
    cwd,
    classFile: path.join(cwd, "abap", "zcl_my_app.clas.abap"),
    exists: () => true,
  });
  assert.deepEqual(inside, ["abap", "--class", "zcl_my_app"]);
  const elsewhere = path.join(path.sep, "other", "zcl_my_app.clas.abap");
  const outside = unitTestArgs({ cwd, classFile: elsewhere, exists: () => true });
  assert.deepEqual(outside, [path.dirname(elsewhere), "--class", "zcl_my_app"]);
});

test("a class at the project root walks the root", () => {
  const args = unitTestArgs({
    cwd,
    classFile: path.join(cwd, "zcl_my_app.clas.abap"),
    exists: () => false,
  });
  assert.deepEqual(args, [".", "--class", "zcl_my_app"]);
});

test("the framework checkout travels as --home", () => {
  const home = path.join(root, "abap2UI5");
  const args = unitTestArgs({ cwd, home, exists: () => true });
  assert.deepEqual(args, ["src", "--home", home]);
});

test("classOfFile answers for a class and its test include only", () => {
  assert.equal(classOfFile("/x/ZCL_A.clas.abap"), "zcl_a");
  assert.equal(classOfFile("/x/zcl_a.clas.testclasses.abap"), "zcl_a");
  assert.equal(classOfFile("/x/zcl_a.clas.locals_imp.abap"), undefined);
  assert.equal(classOfFile("/x/zif_a.intf.abap"), undefined);
  assert.equal(classOfFile("/x/report.prog.abap"), undefined);
});

test("testIncludeFor names the include next to the class, and nothing for other files", () => {
  assert.equal(
    testIncludeFor(path.join("src", "zcl_a.clas.abap")),
    path.join("src", "zcl_a.clas.testclasses.abap")
  );
  assert.equal(testIncludeFor(path.join("src", "zcl_a.clas.testclasses.abap")), undefined);
  assert.equal(testIncludeFor(path.join("src", "zif_a.intf.abap")), undefined);
});

test("the terminal line is quoted for cmd.exe - program and paths with spaces", () => {
  const line = unitTestCommandLine(
    { cmd: "node", args: ["C:\\repos\\mcp-server\\scripts\\ci-unit.mjs"], source: "local checkout" },
    ["src", "--class", "zcl_a", "--home", "C:\\Users\\John Smith\\repos\\abap2UI5"],
    "win32"
  );
  assert.equal(
    line,
    'node C:\\repos\\mcp-server\\scripts\\ci-unit.mjs src --class zcl_a --home "C:\\Users\\John Smith\\repos\\abap2UI5"'
  );
});

test("the terminal line is quoted for sh - and reads like npm run test:unit when nothing needs quotes", () => {
  const npx = resolveUnitRunner({ reposRoot: "", serverDirs: SERVER_DIRS, exists: () => false });
  assert.equal(
    unitTestCommandLine(npx, ["src"], "linux"),
    "npx --yes -p @abap2ui5/mcp-server abap2ui5-unit src"
  );
  assert.equal(
    unitTestCommandLine(npx, ["src", "--home", "/home/me/my repos/abap2UI5"], "linux"),
    "npx --yes -p @abap2ui5/mcp-server abap2ui5-unit src --home '/home/me/my repos/abap2UI5'"
  );
});

test("the banner warns about the clone when no framework checkout is known", () => {
  const npx = resolveUnitRunner({ reposRoot: "", serverDirs: SERVER_DIRS, exists: () => false });
  const lines = unitTestBanner(npx, undefined);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /npx/);
  assert.match(lines[1], /~\/\.abap2ui5-mcp/);
  assert.match(lines[1], /slow the first time/);
});

test("the banner names the checkouts it found instead", () => {
  const script = path.join(root, "mcp-server", "scripts", "ci-unit.mjs");
  const local = resolveUnitRunner({
    reposRoot: root,
    serverDirs: SERVER_DIRS,
    exists: (file) => file === script,
  });
  const lines = unitTestBanner(local, path.join(root, "abap2UI5"));
  assert.ok(lines[0].includes(script));
  assert.equal(lines[1], `framework: ${path.join(root, "abap2UI5")}`);
  assert.ok(!lines.join("\n").includes("slow"));
});
