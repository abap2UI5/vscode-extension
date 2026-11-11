import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { failureMessage, outcomesFor, parseUnitReport, type KnownTest } from "../unitresults";

/*
 * The runner's `--json` report as per-method results.
 *
 * `fixtures/unit/first-failure.json` is what `abap2ui5-unit src --json` of
 * @abap2ui5/mcp-server 1.0.0 printed for a class whose second of four test
 * methods fails (only the machine's paths were replaced). The other reports
 * here are written from the same script (scripts/ci-unit.mjs, `results[]`)
 * for the branches that run did not take.
 */

const ROOT = path.join(__dirname, "..");
const FIRST_FAILURE = fs.readFileSync(
  path.join(ROOT, "src/test/fixtures/unit/first-failure.json"),
  "utf8"
);

const report = (results: unknown[], ok = true): string =>
  JSON.stringify({ ok, framework: "1.148.0", backend: "npm", mode: "npm", results }, null, 2);

const t = (localClass: string, method: string, object = "ZCL_DEMO"): Record<string, string> => ({
  object,
  localClass,
  method,
});

test("a recorded run: what ran before the failure passed, the failing method failed", () => {
  const results = parseUnitReport(FIRST_FAILURE, { code: 1 });
  assert.deepEqual(
    results.map((r) => [r.cls, r.testClass, r.method, r.status]),
    [
      ["zcl_demo", "ltcl_one", "adds", "passed"],
      ["zcl_demo", "ltcl_one", "fails", "failed"],
    ]
  );
  const failed = results[1];
  // what the developer wrote and what was compared come first
  assert.match(failed.message ?? "", /^wrong sum\nexpected: 4\nactual: {3}3\n\n/);
  assert.match(failed.message ?? "", /kernel_cx_assert/);
  assert.equal(failed.expected, "4");
  assert.equal(failed.actual, "3");
});

test("the published runner reports no source position", () => {
  // the only positions in the report are lines of generated .mjs files
  for (const r of parseUnitReport(FIRST_FAILURE, { code: 1 })) {
    assert.equal(r.file, undefined);
    assert.equal(r.line, undefined);
  }
});

test("a position a later runner reports is read", () => {
  const results = parseUnitReport(
    report(
      [
        {
          cls: "zcl_demo",
          testclasses: true,
          tests: [t("ltcl_one", "fails")],
          failed: { ...t("ltcl_one", "fails"), error: "boom", file: "zcl_demo.clas.testclasses.abap", line: 16 },
        },
      ],
      false
    )
  );
  assert.equal(results[0].file, "zcl_demo.clas.testclasses.abap");
  assert.equal(results[0].line, 16);
});

test("the methods the runner never reached are not run - never passed", () => {
  const known: KnownTest[] = [
    { cls: "zcl_demo", testClass: "ltcl_one", method: "adds" },
    { cls: "zcl_demo", testClass: "ltcl_one", method: "fails" },
    { cls: "zcl_demo", testClass: "ltcl_one", method: "never" },
    { cls: "zcl_demo", testClass: "ltcl_two", method: "later" },
  ];
  const outcomes = outcomesFor(parseUnitReport(FIRST_FAILURE, { code: 1 }), known);
  assert.deepEqual(outcomes.map((o) => o.status), ["passed", "failed", "skipped", "skipped"]);
  assert.match(outcomes[2].message ?? "", /stops at the first failure \(ZCL_DEMO ltcl_one fails\)/);
});

test("names are matched whatever their case", () => {
  const outcomes = outcomesFor(parseUnitReport(FIRST_FAILURE, { code: 1 }), [
    { cls: "ZCL_DEMO", testClass: "LTCL_ONE", method: "ADDS" },
  ]);
  assert.equal(outcomes[0].status, "passed");
});

test("a green run: every reported method passed, a skipped one says why", () => {
  const results = parseUnitReport(
    report([
      { cls: "zcl_helper", testclasses: false },
      {
        cls: "zcl_demo",
        testclasses: true,
        tests: [t("ltcl_one", "adds"), { ...t("ltcl_one", "slow"), skipped: "duration long" }],
        failed: null,
      },
    ]),
    { code: 0 }
  );
  assert.deepEqual(
    results.map((r) => [r.cls, r.method, r.status, r.message]),
    [
      ["zcl_demo", "adds", "passed", undefined],
      ["zcl_demo", "slow", "skipped", "Skipped: duration long"],
    ]
  );
  // a method the report does not name is still not "passed"
  const [unknown] = outcomesFor(results, [{ cls: "zcl_demo", testClass: "ltcl_one", method: "new_one" }]);
  assert.equal(unknown.status, "skipped");
});

test("a class the runner had not reached is not run as a whole", () => {
  const results = parseUnitReport(
    report(
      [
        {
          cls: "zcl_a",
          testclasses: true,
          tests: [t("ltcl_a", "one", "ZCL_A")],
          failed: { ...t("ltcl_a", "one", "ZCL_A"), error: "boom" },
        },
        {
          cls: "zcl_b",
          testclasses: true,
          tests: [],
          failed: null,
          notRun: "the runner stops at the first failure (ZCL_A), and this class's tests had not started",
        },
      ],
      false
    ),
    { code: 1 }
  );
  const outcomes = outcomesFor(results, [
    { cls: "zcl_a", testClass: "ltcl_a", method: "one" },
    { cls: "zcl_b", testClass: "ltcl_b", method: "x" },
    { cls: "zcl_b", testClass: "ltcl_b", method: "y" },
  ]);
  assert.deepEqual(outcomes.map((o) => o.status), ["failed", "skipped", "skipped"]);
  assert.match(outcomes[1].message ?? "", /^Not run: the runner stops at the first failure \(ZCL_A\)/);
});

test("a failing fixture belongs to the test class, and its unstarted methods are not run", () => {
  const results = parseUnitReport(
    report(
      [
        {
          cls: "zcl_demo",
          testclasses: true,
          tests: [t("ltcl_one", "adds")],
          failed: { object: "ZCL_DEMO", localClass: "ltcl_one", method: "setup", fixture: true, error: "Error: no db" },
        },
      ],
      false
    ),
    { code: 1 }
  );
  assert.deepEqual(
    results.map((r) => [r.testClass, r.method, r.status, r.fixture ?? false]),
    [
      ["ltcl_one", "adds", "passed", false],
      ["ltcl_one", "setup", "failed", true],
    ]
  );
  const outcomes = outcomesFor(results, [
    { cls: "zcl_demo", testClass: "ltcl_one", method: "adds" },
    { cls: "zcl_demo", testClass: "ltcl_one", method: "next" },
    // a test method that happens to be called like the fixture is not it
    { cls: "zcl_demo", testClass: "ltcl_one", method: "setup" },
  ]);
  assert.deepEqual(outcomes.map((o) => o.status), ["passed", "skipped", "skipped"]);
  assert.match(outcomes[1].message ?? "", /setup failed before this method started/);
});

test("a class that could not be deployed, and one without a test method, are errors on the class", () => {
  const results = parseUnitReport(
    report(
      [
        { cls: "zcl_bad", testclasses: true, deployError: "zcl_bad.clas.abap is there twice" },
        { cls: "zcl_none", testclasses: true, tests: [], failed: null },
      ],
      false
    ),
    { code: 2 }
  );
  assert.deepEqual(
    results.map((r) => [r.cls, r.method, r.status]),
    [
      ["zcl_bad", "", "errored"],
      ["zcl_none", "", "errored"],
    ]
  );
  const [bad, none] = outcomesFor(results, [
    { cls: "zcl_bad", testClass: "ltcl", method: "m" },
    { cls: "zcl_none", testClass: "ltcl", method: "m" },
  ]);
  assert.match(bad.message ?? "", /^Not deployed: zcl_bad\.clas\.abap is there twice/);
  assert.match(none.message ?? "", /found no test method/);
});

test("an empty report is one error result, with the runner's last words", () => {
  // exit 2 prints no JSON at all: stderr is the report
  const stderr = [
    "npm warn exec The following package was not found and will be installed",
    "abap2ui5-unit: framework: @abap2ui5/node-runtime 1.148.0 in /x",
    "abap2ui5-unit: the project's classes did not transpile:",
    "zcl_demo.clas.abap[3, 5] - Statement does not exist",
  ].join("\n");
  for (const stdout of ["", "  \n"]) {
    const results = parseUnitReport(stdout, { code: 2, stderr });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "errored");
    assert.equal(
      results[0].message,
      "The unit test runner printed no report. (exit code 2)\n" +
        "abap2ui5-unit: the project's classes did not transpile:\n" +
        "zcl_demo.clas.abap[3, 5] - Statement does not exist"
    );
    // and every test that was asked for carries it
    const [outcome] = outcomesFor(results, [{ cls: "zcl_demo", testClass: "ltcl_one", method: "adds" }]);
    assert.equal(outcome.status, "errored");
    assert.equal(outcome.message, results[0].message);
  }
  assert.equal(parseUnitReport("")[0].message, "The unit test runner printed no report.");
});

test("a truncated report is one error result, never an exception", () => {
  for (const cut of [10, 200, Math.floor(FIRST_FAILURE.length / 2), FIRST_FAILURE.length - 3]) {
    const results = parseUnitReport(FIRST_FAILURE.slice(0, cut), { code: null });
    assert.equal(results.length, 1, `cut at ${cut}`);
    assert.equal(results[0].status, "errored");
    assert.match(results[0].message ?? "", /could not be read/);
  }
});

test("anything that is not the runner's report is one error result", () => {
  for (const stdout of ["null", "[]", "42", '{"ok":true}', '{"results":"none"}', "## abap2UI5 unit tests\n- ok"]) {
    const results = parseUnitReport(stdout, { code: 0 });
    assert.equal(results.length, 1, stdout);
    assert.equal(results[0].status, "errored");
  }
  // entries of the wrong shape are passed over, not thrown at
  assert.deepEqual(parseUnitReport(report([null, 7, { cls: 3 }, { cls: "zcl_x", testclasses: true, tests: [null, {}] }])), [
    {
      cls: "zcl_x",
      testClass: "",
      method: "",
      status: "errored",
      message: "The class has a test include, but the runner found no test method - is the local class FOR TESTING?",
    },
  ]);
});

test("a report with other lines on stdout around it is still read", () => {
  const results = parseUnitReport(`npm notice something\n${FIRST_FAILURE}\ntrailing line\n`, { code: 1 });
  assert.equal(results.length, 2);
  assert.equal(results[1].status, "failed");
});

test("a run that failed outside a test says so once", () => {
  const results = parseUnitReport(
    report([{ cls: "zcl_demo", testclasses: true, tests: [t("ltcl_one", "adds")], failed: null }], false),
    { code: 1, stderr: "abap2ui5-unit: the runner failed outside a test:\nSyntaxError: x" }
  );
  assert.deepEqual(results.map((r) => [r.cls, r.method, r.status]), [
    ["zcl_demo", "adds", "passed"],
    ["", "", "errored"],
  ]);
  assert.match(results[1].message ?? "", /failed outside a test\. \(exit code 1\)\n.*\nSyntaxError: x$/);
  const outcomes = outcomesFor(results, [
    { cls: "zcl_demo", testClass: "ltcl_one", method: "adds" },
    { cls: "zcl_demo", testClass: "ltcl_one", method: "other" },
  ]);
  assert.deepEqual(outcomes.map((o) => o.status), ["passed", "errored"]);
});

test("an error without the assert's fields is shown as it is", () => {
  assert.deepEqual(failureMessage("TypeError: x is not a function\n    at y"), {
    message: "TypeError: x is not a function\n    at y",
  });
  assert.deepEqual(failureMessage("  "), { message: "(the runner reported no error text)" });
});
