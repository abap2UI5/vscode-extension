const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");
const webTests = process.argv.includes("--webtest");
const desktopTests = process.argv.includes("--desktoptest");

/** The UI5 metadata snapshot of the bundled view checker ships next to the
 *  bundle - the property gate reads it at runtime. The config-file schema
 *  travels the same way: `contributes.jsonValidation` points at the copy, so
 *  editing `abap2ui5lint.jsonc` validates against exactly the pinned linter's
 *  schema, offline.
 *
 *  `data/icons.json` is the third, and it does NOT go next to the bundle: the
 *  icon rules are the one place the linter resolves its own data file itself,
 *  from `import.meta.url` + "../data" - which in this CJS bundle is the shim's
 *  `__filename`, i.e. `dist/../data`. So the copy has to land in the extension
 *  ROOT's `data/`, and it serves `dist-test/` (`dist-test/../data`) with it.
 *
 *  Without the copy nothing breaks loudly: `loadIcons` treats an unreadable
 *  file as an empty registry by design, so `unknown-icon`, `icon-too-new` and
 *  `icon-removed` simply never fired in the editor while CI reported them -
 *  the same silent-metadata trap as a missing `dist/properties.json`, for the
 *  data file that arrived later. The gate on it is the `unknown-icon`
 *  assertion in `src/test/gate.parity.test.ts` - it fails with "the linter's
 *  data/icons.json is not where the bundle looks for it" when this copy stops
 *  landing in the extension root's `data/`. */
function copySnapshot() {
  const data = path.join(
    path.dirname(require.resolve("@abap2ui5/linter/properties")),
    "..",
    "data"
  );
  fs.mkdirSync("dist", { recursive: true });
  fs.copyFileSync(
    path.join(data, "properties.json"),
    path.join("dist", "properties.json")
  );
  fs.copyFileSync(
    path.join(data, "abap2ui5lint.schema.json"),
    path.join("dist", "abap2ui5lint.schema.json")
  );
  fs.mkdirSync("data", { recursive: true });
  fs.copyFileSync(
    path.join(data, "icons.json"),
    path.join("data", "icons.json")
  );
}

/** The linter commit this build pins (package-lock.json resolved URL) -
 *  injected into the desktop bundle so the render gate can prefer the
 *  per-commit bundle release matching exactly this pin (see rendergate.ts). */
function linterPin() {
  try {
    const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
    const resolved =
      lock.packages?.["node_modules/@abap2ui5/linter"]?.resolved || "";
    const m = /#([0-9a-f]{40})$/.exec(resolved);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

/* Shared with the test build: the linter's ESM modules use import.meta.url,
 * which does not exist in a CJS bundle. */
const ESM_IN_CJS = {
  define: {
    "import.meta.url": "import_meta_url",
    "process.env.LINTER_PIN": JSON.stringify(linterPin()),
  },
  inject: ["scripts/import-meta-url-shim.mjs"],
};

/**
 * The test bundle. `node --test` runs plain JavaScript, so the TypeScript
 * sources go through the same bundler the extension does - which also means
 * the tests exercise the modules exactly as they are shipped. Only modules
 * that do not import `vscode` can be tested this way, and that is precisely
 * the boundary the pure helpers were extracted along.
 */
async function buildTests() {
  const dir = "src/test";
  const entryPoints = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join(dir, f));
  await esbuild.build({
    entryPoints,
    bundle: true,
    format: "cjs",
    platform: "node",
    outdir: "dist-test",
    outExtension: { ".js": ".cjs" },
    sourcemap: true,
    external: ["vscode", "node:test", "node:assert"],
    logLevel: "info",
    ...ESM_IN_CJS,
  });
  // The property-gate tests read the snapshot from next to the bundle.
  fs.copyFileSync(
    path.join("dist", "properties.json"),
    path.join("dist-test", "properties.json")
  );
}

/**
 * The web extension host bundle (vscode.dev, browser-based BAS): the same
 * sources, platform `browser`. The node builtins some modules import at load
 * time (the linter computes a default snapshot path with fs/path/url) are
 * aliased to shims that load fine and are never called - the web entry feeds
 * the snapshot through `vscode.workspace.fs` instead.
 */
function webConfig() {
  return {
    entryPoints: ["src/web/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile: "dist/web/extension.js",
    external: ["vscode"],
    alias: {
      fs: "./scripts/web-shims/fs.js",
      path: "./scripts/web-shims/path.js",
      url: "./scripts/web-shims/url.js",
    },
    define: {
      "import.meta.url": "import_meta_url",
      // A browser worker has neither; they only feed module-load-time path
      // constants nothing in the web graph ever reads (snapshot.ts resolves
      // its file next to the bundle, but the web entry feeds the snapshot
      // through vscode.workspace.fs instead). Without the define the bare
      // identifier throws at load time - the web smoke test caught exactly
      // that.
      __dirname: '"/web"',
      __filename: '"/web/extension.js"',
      // A browser worker has no `process` either, so these are ReferenceErrors
      // rather than missing functions. The linter calls `process.cwd()` on
      // every `applyRules` - without the define every web check threw and the
      // view check went silent on vscode.dev with nothing but a log line.
      "process.cwd": "web_process_cwd",
      "process.env": "web_process_env",
    },
    inject: [
      "scripts/import-meta-url-web-shim.mjs",
      "scripts/web-shims/process.mjs",
    ],
    logLevel: "info",
  };
}

async function main() {
  copySnapshot();
  if (tests) {
    await buildTests();
    return;
  }
  if (webTests) {
    // The suite @vscode/test-web loads inside the browser host - next to
    // the web bundle it exercises.
    await esbuild.build({
      ...webConfig(),
      entryPoints: ["src/web/test/suite.ts"],
      outfile: "dist/web/test.js",
    });
    return;
  }
  if (desktopTests) {
    // The suite @vscode/test-electron loads inside a real desktop host. It
    // lands in `dist-test/`, not `dist/`: `dist/` is what gets packaged, and
    // the web suite's own bundle already had to be excluded from the .vsix by
    // hand after being shipped in locally built ones. A test bundle has no
    // business in the directory the extension is packaged from.
    await esbuild.build({
      entryPoints: ["src/test/desktop/suite.ts"],
      bundle: true,
      format: "cjs",
      platform: "node",
      outfile: "dist-test/desktop/suite.js",
      sourcemap: true,
      // The host provides it, and it cannot be resolved at build time.
      external: ["vscode"],
      logLevel: "info",
    });
    return;
  }
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    // vscode is provided by the runtime, it must not be bundled.
    external: ["vscode"],
    // The bundled @abap2ui5/linter modules use import.meta.url, which
    // does not exist in a CJS bundle - substitute a __filename-based URL.
    ...ESM_IN_CJS,
    logLevel: "info",
  });
  const webCtx = await esbuild.context(webConfig());

  if (watch) {
    await ctx.watch();
    await webCtx.watch();
    console.log("[watch] esbuild is watching for changes...");
  } else {
    await ctx.rebuild();
    await webCtx.rebuild();
    await ctx.dispose();
    await webCtx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
