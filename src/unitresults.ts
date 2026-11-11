/*
 * The report of `abap2ui5-unit --json` (mcp-server's scripts/ci-unit.mjs) as
 * one record per test method - without `vscode`, so the reading is testable.
 *
 * What the runner prints, on stdout, after its log lines went to stderr:
 *
 *   { ok, framework, backend, mode, runtime | checkout,
 *     results: [ { cls, testclasses, deployError?, notRun?,
 *                  tests?:  [ { object, localClass, method, skipped? } ],
 *                  failed?: { object, localClass, method, error, fixture? } | null } ] }
 *
 * Three things about it shape everything here:
 *
 * - NOTHING in it carries a source position. A test record is three names;
 *   `failed.error` is the JavaScript error the transpiled test threw, and the
 *   only positions in it are lines of generated `.mjs` files. So a result has
 *   no `file` and no `line` unless a later runner adds them (they are read
 *   when present), and the caller puts a failure on the method's declaration.
 * - The generated runner STOPS at the first failure. `tests` lists what had
 *   started: the methods before the failing one passed, the failing one is
 *   `failed`, and everything after it - in that class and in every class not
 *   yet reached (`notRun`) - never ran. Such a method is not in the report at
 *   all, which is why `outcomesFor` exists: a method the caller knows and the
 *   report does not name is "not run", never "passed".
 * - With exit code 2 (no class under the path, a failed install, a class that
 *   did not transpile) the runner prints no JSON whatsoever. Then stderr is
 *   the report, and it becomes the one error result.
 */

export type UnitStatus = "passed" | "failed" | "skipped" | "errored";

export interface UnitResult {
  /** The global class, lower case - `zcl_app`. Empty for a result about the
   *  run as a whole. */
  cls: string;
  /** The local test class as the runner names it. Empty for a result about
   *  the whole global class (not deployed, not reached, no test method). */
  testClass: string;
  /** The test method. Empty for a result about a whole class; a fixture's
   *  name (`setup`, `class_setup`, `constructor`) when `fixture` is set. */
  method: string;
  status: UnitStatus;
  message?: string;
  /** What a failed `assert_equals` compared, when the error says so. */
  expected?: string;
  actual?: string;
  /** The failure is in the test class's fixture, before a test method ran. */
  fixture?: boolean;
  /** Only when the runner reports them - the published one does not. */
  file?: string;
  line?: number;
}

/** What the caller knows beside stdout - used to explain a report that is
 *  not there. */
export interface UnitRunContext {
  code?: number | null;
  stderr?: string;
}

const NO_REPORT = "The unit test runner printed no report.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The runner's own last words: its `abap2ui5-unit:` lines where there are
 *  any (npx and npm talk on stderr too), the tail of everything otherwise. */
function lastWords(stderr: string | undefined): string {
  const lines = (stderr ?? "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) {
    return "";
  }
  let from = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^abap2ui5-unit: /.test(lines[i])) {
      from = i;
      break;
    }
  }
  // a multi-line message (a transpile error) continues below its first line
  const tail = from >= 0 ? lines.slice(from) : lines.slice(-15);
  return tail.slice(0, 40).join("\n");
}

function runError(headline: string, context: UnitRunContext): UnitResult[] {
  const code =
    context.code === undefined || context.code === null ? "" : ` (exit code ${context.code})`;
  const words = lastWords(context.stderr);
  return [
    {
      cls: "",
      testClass: "",
      method: "",
      status: "errored",
      message: `${headline}${code}${words ? `\n${words}` : ""}`,
    },
  ];
}

/** The JSON document in stdout: all of it, or - when something else wrote to
 *  stdout around it - from the first line that opens an object to the last
 *  that closes one. Undefined when there is none that parses. */
function reportOf(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    /* not the whole of stdout */
  }
  const from = /^\{/m.exec(stdout);
  const to = stdout.lastIndexOf("\n}");
  if (from && to > from.index) {
    try {
      return JSON.parse(stdout.slice(from.index, to + 2));
    } catch {
      /* truncated, or not a report */
    }
  }
  return undefined;
}

/** `name: String { value: '…'` in the inspected error object - how the
 *  open-abap `kernel_cx_assert` carries msg, actual and expected. */
function inspected(error: string, name: string): string | undefined {
  const m = new RegExp(
    `^\\s*${name}: \\w+ \\{\\s*value: (?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)"|(-?[\\d.]+))`,
    "m"
  ).exec(error);
  if (!m) {
    return undefined;
  }
  const raw = m[1] ?? m[2] ?? m[3];
  return raw.replace(/\\(.)/g, "$1").trimEnd();
}

/**
 * A failure's error text as something to read first. The runner hands over
 * the thrown JavaScript error as Node prints it - the stack, then the
 * exception object - and what the developer wrote (`msg`) and what was
 * compared sit forty lines down. They are pulled up; the full text follows.
 */
export function failureMessage(error: string): {
  message: string;
  expected?: string;
  actual?: string;
} {
  if (!error.trim()) {
    return { message: "(the runner reported no error text)" };
  }
  const msg = inspected(error, "msg");
  const expected = inspected(error, "expected");
  const actual = inspected(error, "actual");
  const head: string[] = [];
  if (msg) {
    head.push(msg);
  }
  if (expected !== undefined && actual !== undefined) {
    head.push(`expected: ${expected}`, `actual:   ${actual}`);
  }
  return {
    message: head.length ? `${head.join("\n")}\n\n${error}` : error,
    ...(expected !== undefined && actual !== undefined ? { expected, actual } : {}),
  };
}

function position(record: Record<string, unknown>): { file?: string; line?: number } {
  const file = text(record.file);
  const line = record.line;
  return {
    ...(file ? { file } : {}),
    ...(typeof line === "number" && Number.isInteger(line) && line > 0 ? { line } : {}),
  };
}

/**
 * The runner's stdout as results. Never throws: a report that is empty, cut
 * off or not the runner's is ONE error result that says so, with the
 * runner's last stderr lines - which is where it explains an exit code 2.
 */
export function parseUnitReport(stdout: string, context: UnitRunContext = {}): UnitResult[] {
  const report = reportOf(stdout);
  if (report === undefined) {
    return runError(
      stdout.trim()
        ? "The unit test runner's report could not be read (it is cut off or not JSON)."
        : NO_REPORT,
      context
    );
  }
  if (!isRecord(report) || !Array.isArray(report.results)) {
    return runError("The unit test runner's report has no results list.", context);
  }
  const out: UnitResult[] = [];
  let failures = 0;
  for (const entry of report.results) {
    if (!isRecord(entry)) {
      continue;
    }
    const cls = text(entry.cls).toLowerCase();
    if (!cls) {
      continue;
    }
    const whole = (status: UnitStatus, message: string): void => {
      out.push({ cls, testClass: "", method: "", status, message });
    };
    if (text(entry.deployError)) {
      failures++;
      whole("errored", `Not deployed: ${text(entry.deployError)}`);
      continue;
    }
    if (entry.testclasses !== true) {
      continue; // deployed for the classes that call it, nothing to run
    }
    const tests = Array.isArray(entry.tests)
      ? entry.tests.filter(isRecord).filter((t) => text(t.method))
      : undefined;
    const failed = isRecord(entry.failed) ? entry.failed : undefined;
    if (text(entry.notRun)) {
      whole("skipped", `Not run: ${text(entry.notRun)}`);
      continue;
    }
    if (!tests) {
      continue; // not part of this run (--class named others)
    }
    if (!tests.length && !failed) {
      whole(
        "errored",
        "The class has a test include, but the runner found no test method - " +
          "is the local class FOR TESTING?"
      );
      continue;
    }
    const failedClass = failed ? text(failed.localClass) : "";
    const failedMethod = failed ? text(failed.method) : "";
    const inFixture = failed?.fixture === true;
    const failure = failed ? failureMessage(text(failed.error)) : undefined;
    let placed = false;
    for (const t of tests) {
      const testClass = text(t.localClass);
      const method = text(t.method);
      const base = { cls, testClass, method, ...position(t) };
      if (
        failure &&
        !inFixture &&
        !placed &&
        method.toLowerCase() === failedMethod.toLowerCase() &&
        testClass.toLowerCase() === failedClass.toLowerCase()
      ) {
        placed = true;
        out.push({ ...base, status: "failed", ...failure, ...position(failed ?? {}) });
      } else if (text(t.skipped)) {
        out.push({ ...base, status: "skipped", message: `Skipped: ${text(t.skipped)}` });
      } else {
        out.push({ ...base, status: "passed" });
      }
    }
    if (failed && failure) {
      failures++;
      if (!placed) {
        // a fixture that threw - or a failing method the list does not hold
        out.push({
          cls,
          testClass: failedClass,
          method: failedMethod,
          status: "failed",
          ...failure,
          ...(inFixture ? { fixture: true } : {}),
          ...position(failed),
        });
      }
    }
  }
  // "not ok" with no failure anywhere: the runner broke outside a test, and
  // says where on stderr only
  if (report.ok === false && failures === 0) {
    out.push(...runError("The unit test runner failed outside a test.", context));
  }
  return out;
}

// ----------------------------------------------------------- per method ----

/** A test method the caller knows about (from `unitdiscovery.ts`). */
export interface KnownTest {
  cls: string;
  testClass: string;
  method: string;
}

export interface TestOutcome {
  status: UnitStatus;
  message?: string;
  expected?: string;
  actual?: string;
  file?: string;
  line?: number;
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * What the report says about each known test method, in the order given.
 *
 * A method the report names gets its own result. One it does not name gets
 * the result that covers it - the run's error, its class's (not deployed,
 * not reached), its test class's failing fixture - and otherwise "skipped":
 * the runner stops at the first failure, so silence about a method means it
 * never started. Silence is never "passed".
 */
export function outcomesFor(
  results: readonly UnitResult[],
  known: readonly KnownTest[]
): TestOutcome[] {
  const runWide = results.find((r) => !r.cls && r.status === "errored");
  const stopped = results.find((r) => r.status === "failed");
  return known.map((test) => {
    const own = results.find(
      (r) =>
        !r.fixture &&
        r.method !== "" &&
        same(r.cls, test.cls) &&
        same(r.testClass, test.testClass) &&
        same(r.method, test.method)
    );
    if (own) {
      const { status, message, expected, actual, file, line } = own;
      return {
        status,
        ...(message !== undefined ? { message } : {}),
        ...(expected !== undefined && actual !== undefined ? { expected, actual } : {}),
        ...(file ? { file } : {}),
        ...(line ? { line } : {}),
      };
    }
    const classWide = results.find((r) => same(r.cls, test.cls) && !r.testClass && !r.method);
    if (classWide) {
      return { status: classWide.status, message: classWide.message };
    }
    const fixture = results.find(
      (r) =>
        r.fixture &&
        same(r.cls, test.cls) &&
        (!r.testClass || same(r.testClass, test.testClass))
    );
    if (fixture) {
      return {
        status: "skipped",
        message: `Not run: the test class's ${fixture.method} failed before this method started.`,
      };
    }
    if (runWide) {
      return { status: "errored", message: runWide.message };
    }
    if (stopped) {
      const where = [stopped.cls.toUpperCase(), stopped.testClass, stopped.method]
        .filter(Boolean)
        .join(" ");
      return {
        status: "skipped",
        message: `Not run: the runner stops at the first failure (${where}).`,
      };
    }
    return {
      status: "skipped",
      message: "Not run: the runner's report does not name this method.",
    };
  });
}
