import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as nodePath from "path";

/*
 * The web build's node-builtin shims.
 *
 * These exist because the bundled linter computes paths at module load time,
 * and a browser extension host has neither `path` nor `process`. They started
 * as three string helpers for constants nothing reads - and then the linter's
 * `applyRules` began deriving the absolute and cwd-relative spellings of a
 * file name on EVERY check (`path.resolve`, `path.relative`,
 * `process.cwd()`). The shim did not have them, so every web check threw a
 * `TypeError` that `webcheck.ts` swallowed: the whole view check was silently
 * dead on vscode.dev while CI stayed green, because the web smoke test only
 * asserted that activation registered its commands.
 *
 * So this suite guards the shims from both sides: the behaviour matches
 * node's own `path.posix`, and the surface covers what the PINNED linter
 * actually calls - the next member it reaches for turns into a red test here
 * instead of a feature that quietly stops working in one of the two hosts.
 */

const shim = require("../../scripts/web-shims/path.js");

const ROOT = nodePath.join(__dirname, "..");
const LINTER_LIB = nodePath.join(
  ROOT,
  "node_modules",
  "@abap2ui5",
  "linter",
  "lib"
);

/** The virtual working directory the shim resolves relative paths against. */
const CWD = "/";

const RELATIVE_PATHS = [
  "src/zcl_app.clas.abap",
  "./src/zcl_app.clas.abap",
  "src/../src/zcl_app.clas.abap",
  "../outside.clas.abap",
  "a/b/c/../../d",
  "no-directory.abap",
  ".",
];

const ABSOLUTE_PATHS = [
  "/repo/src/zcl_app.clas.abap",
  "/repo/src/../src/zcl_app.clas.abap",
  "/repo/",
  "/",
  "/repo/../../above-root",
];

test("resolve matches node for relative and absolute paths", () => {
  for (const p of [...RELATIVE_PATHS, ...ABSOLUTE_PATHS]) {
    assert.equal(
      shim.resolve(p),
      nodePath.posix.resolve(CWD, p),
      `resolve(${p})`
    );
  }
});

test("resolve walks its arguments from the right, like node", () => {
  const cases: string[][] = [
    ["/repo", "src", "zcl_app.clas.abap"],
    ["/repo", "/other", "file.abap"],
    ["relative", "deeper"],
    ["/repo", "..", "sibling"],
  ];
  for (const parts of cases) {
    assert.equal(
      shim.resolve(...parts),
      nodePath.posix.resolve(CWD, ...parts),
      `resolve(${parts.join(", ")})`
    );
  }
});

test("relative matches node - including the ../ forms a baseline key needs", () => {
  const cases: Array<[string, string]> = [
    ["/repo", "/repo/src/zcl_app.clas.abap"],
    ["/repo/src", "/repo/other/zcl_app.clas.abap"],
    ["/repo/src", "/repo/src"],
    ["/repo/src/deep", "/repo"],
    ["/", "/repo/src"],
    ["/repo", "/elsewhere/file.abap"],
  ];
  for (const [from, to] of cases) {
    assert.equal(
      shim.relative(from, to),
      nodePath.posix.relative(from, to),
      `relative(${from}, ${to})`
    );
  }
});

test("join, dirname, basename, extname and normalize match node", () => {
  const joins: string[][] = [
    ["/repo", "src", "zcl_app.clas.abap"],
    ["repo", "..", "other"],
    ["/repo/", "/src/"],
    ["a", "b/c", "../d"],
  ];
  for (const parts of joins) {
    assert.equal(
      shim.join(...parts),
      nodePath.posix.join(...parts),
      `join(${parts.join(", ")})`
    );
  }
  for (const p of [
    "/repo/src/zcl_app.clas.abap",
    "/repo/src/",
    "zcl_app.clas.abap",
    "/single",
    "/",
    "a/b/../c",
  ]) {
    assert.equal(shim.dirname(p), nodePath.posix.dirname(p), `dirname(${p})`);
    assert.equal(
      shim.basename(p),
      nodePath.posix.basename(p),
      `basename(${p})`
    );
    assert.equal(shim.extname(p), nodePath.posix.extname(p), `extname(${p})`);
    assert.equal(
      shim.normalize(p),
      nodePath.posix.normalize(p),
      `normalize(${p})`
    );
  }
  assert.equal(
    shim.basename("/repo/zcl_app.clas.abap", ".abap"),
    nodePath.posix.basename("/repo/zcl_app.clas.abap", ".abap")
  );
});

test("isAbsolute, sep and delimiter are the posix ones", () => {
  assert.equal(shim.sep, "/");
  assert.equal(shim.delimiter, ":");
  assert.equal(shim.isAbsolute("/repo"), true);
  assert.equal(shim.isAbsolute("repo"), false);
});

test("the shim carries the posix/win32/default aliases a bundler may reach for", () => {
  // The linter's modules are ESM: `import path from "path"` lands on the
  // default export, and esbuild's interop reads it off the CJS namespace.
  assert.equal(typeof shim.posix.resolve, "function");
  assert.equal(typeof shim.win32.resolve, "function");
  assert.equal(typeof shim.default.resolve, "function");
});

/** Every `path.<member>` / `process.<member>` the bundled linter names. */
function membersUsedBy(global: string): Set<string> {
  const found = new Set<string>();
  const pattern = new RegExp(`\\b${global}\\.([a-zA-Z]+)`, "g");
  for (const entry of fs.readdirSync(LINTER_LIB)) {
    if (!entry.endsWith(".mjs")) {
      continue;
    }
    const text = fs.readFileSync(nodePath.join(LINTER_LIB, entry), "utf8");
    for (const m of text.matchAll(pattern)) {
      found.add(m[1]);
    }
  }
  return found;
}

test("the path shim covers every member the pinned linter calls", () => {
  const used = membersUsedBy("path");
  assert.ok(used.size >= 4, `only found ${used.size} path members - scan broke`);
  const missing = [...used].filter((name) => shim[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    "the pinned linter calls path members the web shim does not export - " +
      "every web check would throw a TypeError that webcheck.ts swallows"
  );
});

test("esbuild defines every process member the pinned linter reads", () => {
  // `process` does not exist at all in a browser worker, so an undefined
  // member is a ReferenceError rather than a missing function. The web build
  // substitutes them; anything the linter newly reads has to be added there.
  const DEFINED = new Set(["cwd", "env"]);
  // stdout/stderr belong to the CLI modules, which the web entry never pulls
  // in - `webcheck.ts` calls the library functions directly.
  const CLI_ONLY = new Set(["stdout", "stderr", "argv", "exit", "exitCode"]);
  const esbuildConfig = fs.readFileSync(nodePath.join(ROOT, "esbuild.js"), "utf8");
  for (const name of DEFINED) {
    assert.ok(
      esbuildConfig.includes(`"process.${name}"`),
      `esbuild.js no longer defines process.${name} for the web build`
    );
  }
  const used = membersUsedBy("process");
  const missing = [...used].filter(
    (name) => !DEFINED.has(name) && !CLI_ONLY.has(name)
  );
  assert.deepEqual(
    missing,
    [],
    "the pinned linter reads process members the web build does not define"
  );
});
