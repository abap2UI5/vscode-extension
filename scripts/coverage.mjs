/*
 * `npm run test:coverage`: the suite once more, with Node's own coverage
 * collection switched on (`NODE_V8_COVERAGE`), and a per-module line table
 * for `src/` out of it - on stdout, and in the job summary when CI runs it
 * (`$GITHUB_STEP_SUMMARY`). No threshold: it is a number to look at, and the
 * exit code is the test run's.
 *
 * It expects the test build `node esbuild.js --tests --coverage` leaves in
 * `dist-test/`: the bundles with their source maps, and nothing tree-shaken,
 * so a function no test imports is still in a bundle to be reported as not
 * run. Why the table is computed here rather than by `--experimental-test-
 * coverage`: scripts/lib/coverage.mjs.
 *
 * What the table can and cannot say: a module is in it when a test bundle
 * contains it, which only a `vscode`-free module can be (`vscode` is external
 * to the bundles and does not exist in plain Node). The `vscode`-free modules
 * no test loads are listed after it; the modules that import `vscode` are
 * covered by the two in-host smoke tests alone and are only counted.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import {
  executionCounts,
  markdownTable,
  summarize,
  tallyBundle,
  textTable,
  totalOf,
} from "./lib/coverage.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "dist-test");
const V8_DIR = path.join(OUT, ".v8-coverage");

/** The modules the table is about: the extension's own sources, not the
 *  suite, not the generated data, not the linter. */
const isModule = (file) =>
  /^src\/.+\.(?:ts|js)$/.test(file) &&
  !/^src\/(?:test|web\/test)\//.test(file) &&
  !file.endsWith(".d.ts");

function runSuite(bundles) {
  fs.rmSync(V8_DIR, { recursive: true, force: true });
  const run = spawnSync(process.execPath, ["--test", ...bundles], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, NODE_V8_COVERAGE: V8_DIR },
  });
  if (run.error) {
    throw run.error;
  }
  return run.status ?? 1;
}

/** bundle path -> how often each of its offsets ran. Every process of the run
 *  writes a report (the tests start children of their own); only the test
 *  bundles are read out of them. */
function collectCounts(bundles) {
  const wanted = new Map(bundles.map((file) => [path.resolve(ROOT, file), undefined]));
  const lengths = new Map();
  for (const name of fs.existsSync(V8_DIR) ? fs.readdirSync(V8_DIR) : []) {
    if (!name.endsWith(".json")) {
      continue;
    }
    let report;
    try {
      report = JSON.parse(fs.readFileSync(path.join(V8_DIR, name), "utf8"));
    } catch {
      continue; // a child that was killed mid-write
    }
    for (const script of report.result ?? []) {
      if (!script.url.startsWith("file:")) {
        continue;
      }
      const file = fileURLToPath(script.url);
      if (!wanted.has(file)) {
        continue;
      }
      if (!lengths.has(file)) {
        lengths.set(file, fs.readFileSync(file, "utf8").length);
      }
      wanted.set(
        file,
        executionCounts(script.functions, lengths.get(file), wanted.get(file))
      );
    }
  }
  return wanted;
}

function tally(counts) {
  const lines = new Map();
  for (const [bundle, ran] of counts) {
    if (!ran) {
      continue; // a bundle the run never loaded: the suite failed before it
    }
    const map = JSON.parse(fs.readFileSync(`${bundle}.map`, "utf8"));
    // the map names its sources relative to itself; the table names them
    // relative to the repository
    const sources = map.sources.map((source) =>
      path
        .relative(ROOT, path.resolve(path.dirname(bundle), map.sourceRoot ?? "", source))
        .split(path.sep)
        .join("/")
    );
    const perBundle = new Map();
    tallyBundle(perBundle, { ...map, sources }, fs.readFileSync(bundle, "utf8"), ran);
    for (const [file, perLine] of perBundle) {
      if (!isModule(file)) {
        continue;
      }
      let known = lines.get(file);
      if (!known) {
        lines.set(file, (known = new Map()));
      }
      for (const [line, covered] of perLine) {
        known.set(line, known.get(line) === true || covered);
      }
    }
  }
  return lines;
}

function sourceFiles(dir = "src") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...sourceFiles(file));
    } else if (isModule(file)) {
      out.push(file);
    }
  }
  return out;
}

/** The modules in no bundle, split by why: one that imports `vscode` (itself
 *  or through a module of this repository it imports) cannot be bundled for
 *  plain Node; any other simply has no test that reaches it. Type-only
 *  imports are erased by the build and do not count. */
function unloaded(loaded) {
  const files = sourceFiles();
  const imports = new Map();
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const found = [];
    const re =
      /^[ \t]*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/gm;
    for (let m; (m = re.exec(text)); ) {
      found.push(m[1] ?? m[2]);
    }
    imports.set(file, found);
  }
  const resolve = (from, spec) => {
    const base = path.posix.join(path.posix.dirname(from), spec);
    return [base, `${base}.ts`, `${base}.js`, `${base}/index.ts`].find((f) => imports.has(f));
  };
  const needsHost = new Map();
  const visit = (file) => {
    if (needsHost.has(file)) {
      return needsHost.get(file);
    }
    needsHost.set(file, false); // an import cycle answers "not through me"
    const answer = imports
      .get(file)
      .some((spec) =>
        spec === "vscode" ? true : spec.startsWith(".") ? visit(resolve(file, spec) ?? "") : false
      );
    needsHost.set(file, answer);
    return answer;
  };
  imports.set("", []);
  const untested = [];
  const stubbed = [];
  let host = 0;
  for (const file of files) {
    if (loaded.has(file)) {
      // in a bundle although it needs the host: a test stubs `vscode` for it
      if (visit(file)) {
        stubbed.push(file);
      }
    } else if (visit(file)) {
      host++;
    } else {
      untested.push(file);
    }
  }
  return { untested, stubbed, host };
}

function main() {
  const bundles = fs.existsSync(OUT)
    ? fs
        .readdirSync(OUT)
        .filter((name) => name.endsWith(".test.cjs"))
        .sort()
        .map((name) => path.join("dist-test", name))
    : [];
  if (bundles.length === 0) {
    console.error("no test bundles in dist-test/ - run `npm run test:coverage`, which builds them first");
    return 1;
  }
  const status = runSuite(bundles);
  const lines = tally(collectCounts(bundles));
  const measured = summarize(lines);
  if (measured.length === 0) {
    console.error("the run left no coverage for any src/ module");
    return status || 1;
  }
  const { untested, stubbed, host } = unloaded(lines);
  const rows = measured.map((row) =>
    stubbed.includes(row.file) ? { ...row, file: `${row.file} (stubbed)` } : row
  );
  const all = totalOf(rows);
  const notes = [
    `${rows.length} modules of src/ are loaded by the suite; ` +
      `${all.percent.toFixed(1)}% of their ${all.total} lines of code ran ` +
      "(least covered first, comment and type-only lines not counted).",
    untested.length > 0
      ? `Not loaded by any test although they need no VS Code: ${untested.join(", ")}.`
      : "Every module that needs no VS Code is loaded by a test.",
    ...(stubbed.length > 0
      ? ["(stubbed): the module imports `vscode` and a test loads it against a stub, so most of it cannot run here."]
      : []),
    `${host} more modules import \`vscode\` and run in the two in-host smoke tests only.`,
  ];
  console.log(`\nTest coverage of src/\n\n${textTable(rows)}\n\n${notes.join("\n")}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    fs.appendFileSync(
      summary,
      `### Test coverage\n\n${notes.join("\n\n")}\n\n${markdownTable(rows)}\n`
    );
  }
  if (status !== 0) {
    console.error("\nthe suite FAILED under coverage - the table above is of a failing run");
  }
  return status;
}

process.exit(main());
