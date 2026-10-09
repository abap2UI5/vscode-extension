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

// ---------------------------------------------------------------------------
// The linter's own data files (src/web/linterdata.ts)
// ---------------------------------------------------------------------------

test("the fs shim answers a seeded file and nothing else", () => {
  const fsShim = require("../../scripts/web-shims/fs.js");
  assert.equal(fsShim.existsSync("/seeded/by/the/test.json"), false);
  assert.throws(() => fsShim.readFileSync("/seeded/by/the/test.json", "utf8"));
  fsShim.seedFile("/seeded/by/the/test.json", "{}");
  assert.equal(fsShim.existsSync("/seeded/by/the/test.json"), true);
  assert.equal(fsShim.readFileSync("/seeded/by/the/test.json", "utf8"), "{}");
  assert.throws(() => fsShim.readFileSync("/not/seeded.json", "utf8"));
});

test("the icon data is seeded where the bundled linter looks for it in the web build", () => {
  const { LINTER_DATA_FILES } = require("../web/linterdata") as typeof import("../web/linterdata");
  // the linter's own formula - a change to it has to fail here, not on vscode.dev
  const icons = fs.readFileSync(nodePath.join(LINTER_LIB, "icons.mjs"), "utf8");
  assert.match(
    icons,
    /path\.join\(path\.dirname\(fileURLToPath\(import\.meta\.url\)\), '\.\.', 'data', 'icons\.json'\)/,
    "the linter computes its icon path differently now - update src/web/linterdata.ts"
  );
  // ... evaluated over the web build's shims
  const metaUrl = /import_meta_url = "([^"]+)"/.exec(
    fs.readFileSync(nodePath.join(ROOT, "scripts", "import-meta-url-web-shim.mjs"), "utf8")
  )?.[1];
  assert.ok(metaUrl, "the web import.meta.url shim names a url");
  const urlShim = require("../../scripts/web-shims/url.js");
  const expected = shim.join(shim.dirname(urlShim.fileURLToPath(metaUrl)), "..", "data", "icons.json");
  const seeded = LINTER_DATA_FILES.find((file) => file.packaged.join("/") === "data/icons.json");
  assert.equal(seeded?.path, expected);
  // and the packaged copy is where esbuild.js puts it
  assert.ok(
    fs.existsSync(nodePath.join(ROOT, ...seeded!.packaged)),
    "esbuild.js copies data/icons.json into the extension root"
  );
});

test("the icon rules fire in the web bundle once the data is seeded", async () => {
  /*
   * Regression (web build audit): in the browser `fs` is the shim, the
   * linter's loadIcons read nothing, and unknown-icon never fired on
   * vscode.dev - the desktop editor and CI reported it. Built with the web
   * configuration itself, so the aliases, defines and injects are the ones
   * that ship.
   */
  // resolved at run time: the esbuild API cannot be bundled into this test
  const esbuild = require(nodePath.join(ROOT, "node_modules", "esbuild"));
  const { webConfig } = require(nodePath.join(ROOT, "esbuild.js"));
  const dir = fs.mkdtempSync(nodePath.join(require("os").tmpdir(), "abap2ui5-webshim-"));
  try {
    const entry = nodePath.join(dir, "probe.ts");
    const src = (file: string) => JSON.stringify(nodePath.join(ROOT, "src", file));
    fs.writeFileSync(
      entry,
      `import { seedLinterData } from ${src("web/linterdata")};
import { runGate } from ${src("gate")};
import { setSnapshotText } from ${src("snapshot")};
export async function probe(read: (p: string[]) => Promise<string>, snapshot: string, source: string) {
  const failed = await seedLinterData(read);
  setSnapshotText(snapshot);
  return { failed, types: runGate(source, "/repo/zcl_app.clas.abap", false, { minUi5: "1.71" } as never).findings.map((f) => f.type) };
}
`
    );
    const out = nodePath.join(dir, "probe.js");
    const config = webConfig();
    await esbuild.build({
      ...config,
      absWorkingDir: ROOT,
      entryPoints: [entry],
      outfile: out,
      minify: false,
      sourcemap: false,
      logLevel: "silent",
    });
    const { probe } = require(out);
    const source = [
      "CLASS zcl_app DEFINITION PUBLIC.",
      "  PUBLIC SECTION.",
      "    INTERFACES z2ui5_if_app.",
      "ENDCLASS.",
      "CLASS zcl_app IMPLEMENTATION.",
      "  METHOD z2ui5_if_app~main.",
      "    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).",
      "    view->ele( `Page`",
      "        )->tag( `Button`",
      "            )->a( n = `icon` v = `sap-icon://nosuchicon` ).",
      "    client->view_display( view->stringify( ) ).",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n");
    const result = await probe(
      async (packaged: string[]) => fs.readFileSync(nodePath.join(ROOT, ...packaged), "utf8"),
      fs.readFileSync(nodePath.join(__dirname, "properties.json"), "utf8"),
      source
    );
    assert.deepEqual(result.failed, []);
    assert.ok(
      result.types.includes("unknown-icon"),
      `unknown-icon is missing from the web build's findings: ${result.types.join(", ")}`
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
