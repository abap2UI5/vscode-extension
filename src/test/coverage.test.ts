import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/*
 * The arithmetic of `npm run test:coverage` (scripts/lib/coverage.mjs). The
 * script itself runs the whole suite and is CI's to run; what can be wrong
 * quietly is the reading of V8's ranges through a source map, and a table
 * that is wrong quietly is worse than none.
 */
const {
  decodeMappings,
  executionCounts,
  lineOffsets,
  markdownTable,
  summarize,
  tallyBundle,
  textTable,
  totalOf,
} = require("../../scripts/lib/coverage.mjs");

const ROOT = path.join(__dirname, "..");

test("decodeMappings reads the segments that name a source line", () => {
  // the example of the source map specification's readers: "AAAA" is all
  // zeroes, "IAAM" moves 4 columns and 6 source columns, ";" starts a line
  assert.deepEqual(decodeMappings("AAAA,IAAM;AACA"), [
    0, 0, 0, 0,
    0, 4, 0, 0,
    1, 0, 0, 1,
  ]);
  // a one-field segment has no source; negative deltas and a second source
  assert.deepEqual(decodeMappings("A,KCEA;;IDDA"), [0, 5, 1, 2, 2, 4, 0, 1]);
  // values past one base64 digit (16 = "gB", 1000 = "w+B")
  assert.deepEqual(decodeMappings("gBAAA,w+BAw+BA"), [0, 16, 0, 0, 0, 1016, 0, 1000]);
  assert.deepEqual(decodeMappings(""), []);
  assert.throws(() => decodeMappings("A*AA"), /VLQ/);
});

test("lineOffsets and executionCounts: the innermost range speaks for an offset", () => {
  assert.deepEqual(lineOffsets("ab\n\ncd"), [0, 3, 4]);
  const counts = executionCounts(
    [
      { ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
      {
        ranges: [
          { startOffset: 2, endOffset: 8, count: 5 },
          { startOffset: 4, endOffset: 6, count: 0 },
        ],
      },
    ],
    12
  );
  assert.deepEqual([...counts], [1, 1, 5, 5, 0, 0, 5, 5, 1, 1, 0, 0]);
  // a second report of the same script: the higher count wins per offset
  const merged = executionCounts(
    [{ ranges: [{ startOffset: 0, endOffset: 12, count: 0 }, { startOffset: 4, endOffset: 5, count: 2 }] }],
    12,
    counts
  );
  assert.deepEqual([...merged], [1, 1, 5, 5, 2, 0, 5, 5, 1, 1, 0, 0]);
});

test("a line is counted when code was emitted for it and covered when that code ran", () => {
  // generated: line 0 "aaaa", line 1 "bbbb"; source a.ts lines 3 and 4 (the
  // comment lines above them have no segment), b.ts line 3
  const code = "aaaa\nbbbb\n";
  const map = { sources: ["a.ts", "b.ts"], mappings: "AAEA,ECAA;ADCA" };
  const lines = new Map<string, Map<number, boolean>>();
  const ran = new Uint32Array(code.length);
  ran.fill(1, 0, 2); // only the first two characters executed
  tallyBundle(lines, map, code, ran);
  assert.deepEqual([...lines.get("a.ts")!], [[3, true], [4, false]]);
  assert.deepEqual([...lines.get("b.ts")!], [[3, false]]);
  // a second bundle that ran the rest: covered stays covered, the rest joins
  tallyBundle(lines, map, code, new Uint32Array(code.length).fill(1, 5));
  assert.deepEqual([...lines.get("a.ts")!], [[3, true], [4, true]]);
  assert.deepEqual([...lines.get("b.ts")!], [[3, false]]);

  const rows = summarize(lines);
  assert.deepEqual(rows, [
    { file: "b.ts", covered: 0, total: 1, percent: 0 },
    { file: "a.ts", covered: 2, total: 2, percent: 100 },
  ]);
  assert.deepEqual(totalOf(rows), { covered: 2, total: 3, percent: (2 / 3) * 100 });
  assert.match(textTable(rows), /^b\.ts\s+0\.0%\s+0\s+1$/m);
  assert.match(textTable(rows), /^all\s+66\.7%\s+2\s+3$/m);
  assert.ok(markdownTable(rows).includes("| `a.ts` | 100.0% | 2 | 2 |"));
  assert.ok(markdownTable(rows).includes("| **all** | **66.7%** | 2 | 3 |"));
});

test("the source maps coverage reads stay out of the package", () => {
  // the test build writes maps next to its bundles; the .vsix gets neither
  const ignored = fs
    .readFileSync(path.join(ROOT, ".vscodeignore"), "utf8")
    .split(/\r?\n/);
  assert.ok(ignored.includes("**/*.map"), ".vscodeignore no longer drops source maps");
  assert.ok(ignored.includes("dist-test/**"), ".vscodeignore no longer drops dist-test/");
  // and `npm test` is not the coverage run: no flag that changes its build
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  assert.ok(!scripts.test.includes("--coverage"));
  assert.ok(scripts["test:coverage"].includes("esbuild.js --tests --coverage"));
});
