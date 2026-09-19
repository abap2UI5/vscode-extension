import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompatRecord,
  compareRelease,
  compatFinding,
  compatLine,
  compatOf,
  compatVerdict,
  frameworkPinAt,
  frameworkPinOf,
  readCompat,
  releaseParts,
} from "../compat";
import { TEMPLATE_FILES, frameworkPin } from "../scaffold";

/*
 * The record is a FIXTURE here, deliberately: the bundled linter may be
 * pinned to a commit older than `data/compat.json`, and then `readCompat( )`
 * answers null - which is a contract of its own (last test), not a reason
 * for these to go quiet. The shape is the linter's `./compat` export:
 * `{ note, linter, framework: { minimum, mirrored }, ui5: { floor, snapshot } }`.
 */
const COMPAT: CompatRecord = {
  note: "fixture",
  linter: "0.6.1",
  framework: { minimum: "1.144.0", mirrored: "1.144.0" },
  ui5: { floor: "1.71", snapshot: "1.151.0" },
};

/** An abaplint.jsonc the way app-template writes one - comments in the
 *  dependency object, and a second dependency that must not be mistaken for
 *  the framework. */
const config = (pinLine: string): string => `{
  "global": {
    "files": "/src/**/*.*"
  },
  "dependencies": [
    {
      // some other library, unpinned
      "url": "https://github.com/example/zlib",
      "files": "/src/**/*.*"
    },
    {
      // the abap2UI5 framework this app runs on - cloned by abaplint
      // The key is "branch", and it is not a typo.
      "url": "https://github.com/abap2UI5/abap2UI5",
${pinLine}
      "files": "/src/**/*.*"
    }
  ],
  "syntax": { "version": "v750", "errorNamespace": "^(Z|Y)" }
}
`;

const BELOW = config('      "branch": "1.142.0",');
const EQUAL = config('      "branch": "1.144.0",');
const ABOVE = config('      "branch": "1.145.2",');
const UNPINNED = config("");
const ON_MAIN = config('      "branch": "main",');

test("frameworkPinOf reads the framework dependency's branch, not the first one", () => {
  assert.equal(frameworkPinOf(BELOW), "1.142.0");
  assert.equal(frameworkPinOf(EQUAL), "1.144.0");
  assert.equal(frameworkPinOf(ON_MAIN), "main");
  assert.equal(frameworkPinOf(UNPINNED), "", "no branch on the framework dependency");
  assert.equal(frameworkPinOf("{}"), "", "no dependencies at all");
  // url spellings abaplint accepts just the same
  assert.equal(
    frameworkPinOf('{ "url": "https://github.com/abap2ui5/abap2ui5.git", "branch": "1.144.0" }'),
    "1.144.0"
  );
  assert.equal(
    frameworkPinOf('{ "url": "https://github.com/abap2UI5/abap2UI5/", "branch": "1.144.0" }'),
    "1.144.0"
  );
  // a dependency of the organisation that is not the framework
  assert.equal(
    frameworkPinOf('{ "url": "https://github.com/abap2UI5/samples", "branch": "1.144.0" }'),
    ""
  );
});

test("frameworkPinAt places the pin on its value", () => {
  const at = frameworkPinAt(BELOW);
  assert.ok(at);
  assert.equal(BELOW.slice(at.offset, at.offset + at.length), "1.142.0");
  // the line is the branch line, and only it
  const line = BELOW.slice(0, at.offset).split("\n").length - 1;
  assert.match(BELOW.split("\n")[line], /^\s*"branch": "1\.142\.0",$/);
  // an empty value still has a position, of length 0
  const empty = frameworkPinAt(config('      "branch": "",'));
  assert.ok(empty);
  assert.equal(empty.length, 0);
  assert.equal(config('      "branch": "",')[empty.offset], '"');
});

test("the scaffold names the template's pin through the shared parser", () => {
  // scaffold.ts used to carry its own "branch" regex - the first branch in
  // the file, whichever dependency it belonged to
  assert.equal(frameworkPin(), frameworkPinOf(TEMPLATE_FILES["abaplint.jsonc"]));
  assert.match(frameworkPin(), /^\d+\.\d+\.\d+$/);
});

test("compareRelease orders X.Y.Z tags numerically and refuses anything else", () => {
  assert.equal(compareRelease("1.142.0", "1.144.0"), -1);
  assert.equal(compareRelease("1.144.0", "1.144.0"), 0);
  assert.equal(compareRelease("1.145.2", "1.144.0"), 1);
  // numeric, not lexical
  assert.equal(compareRelease("1.9.0", "1.10.0"), -1);
  assert.equal(compareRelease("2.0.0", "1.999.999"), 1);
  assert.equal(compareRelease("1.144.10", "1.144.9"), 1);
  // a leading v is the same tag
  assert.equal(compareRelease("v1.144.0", "1.144.0"), 0);
  // not releases: a branch, a suffix, nothing
  assert.equal(compareRelease("main", "1.144.0"), undefined);
  assert.equal(compareRelease("1.144.0", "1.144.0-rc1"), undefined);
  assert.equal(compareRelease("", "1.144.0"), undefined);
  assert.equal(releaseParts("1.144"), undefined);
  assert.deepEqual(releaseParts(" 1.144.0 "), [1, 144, 0]);
});

test("compatVerdict flags only a release pinned below the minimum", () => {
  const below = compatVerdict(COMPAT, "1.142.0");
  assert.equal(below.ok, false);
  if (!below.ok) {
    // the message names the pin, the minimum and the remedy
    assert.ok(below.message.includes("1.142.0"), "names the pin");
    assert.ok(below.message.includes("1.144.0"), "names the minimum");
    assert.ok(below.message.includes("0.6.1"), "names the linter");
    assert.ok(below.message.includes('"branch"'), "names the key to bump");
    assert.ok(below.message.includes("abaplint.jsonc"), "names the file");
    assert.ok(below.message.includes("npm run check"), "names the gate to run");
  }
  assert.deepEqual(compatVerdict(COMPAT, "1.144.0"), { ok: true }, "equal");
  assert.deepEqual(compatVerdict(COMPAT, "1.145.2"), { ok: true }, "above");
  assert.deepEqual(compatVerdict(COMPAT, ""), { ok: true }, "unpinned");
  assert.deepEqual(compatVerdict(COMPAT, "main"), { ok: true }, "a branch name");
  assert.deepEqual(compatVerdict(null, "1.0.0"), { ok: true }, "no record");
  // a record whose minimum is not a release compares to nothing either
  const odd = { ...COMPAT, framework: { minimum: "main", mirrored: "main" } };
  assert.deepEqual(compatVerdict(odd, "1.0.0"), { ok: true });
});

test("compatFinding is the verdict placed on the pin", () => {
  const finding = compatFinding(COMPAT, BELOW);
  assert.ok(finding);
  assert.equal(BELOW.slice(finding.offset, finding.offset + finding.length), "1.142.0");
  assert.equal(finding.message, (compatVerdict(COMPAT, "1.142.0") as { message: string }).message);
  assert.equal(compatFinding(COMPAT, EQUAL), undefined);
  assert.equal(compatFinding(COMPAT, ABOVE), undefined);
  assert.equal(compatFinding(COMPAT, UNPINNED), undefined);
  assert.equal(compatFinding(COMPAT, ON_MAIN), undefined);
  assert.equal(compatFinding(null, BELOW), undefined, "no record, no finding");
});

test("compatLine is the one sentence the log and the status print", () => {
  assert.equal(
    compatLine(COMPAT),
    "linter 0.6.1 assumes abap2UI5 >= 1.144.0 (mirrors 1.144.0), UI5 snapshot 1.151.0"
  );
  assert.equal(compatLine(null), "the bundled linter ships no compatibility record");
});

test("compatOf accepts the export's shape and nothing less", () => {
  assert.deepEqual(compatOf({ ...COMPAT }), COMPAT);
  // the note is documentation, not data
  const { note: _note, ...bare } = COMPAT;
  assert.deepEqual(compatOf(bare), { ...bare, note: undefined });
  assert.equal(compatOf(null), null);
  assert.equal(compatOf("0.6.1"), null);
  assert.equal(compatOf({ linter: "0.6.1" }), null);
  assert.equal(compatOf({ ...COMPAT, framework: { minimum: "1.144.0" } }), null);
  assert.equal(compatOf({ ...COMPAT, ui5: { floor: "1.71", snapshot: "" } }), null);
});

test("readCompat answers the bundled record or null, never a throw", () => {
  // The test bundle gets `dist-test/compat.json` from the pinned linter when
  // that pin ships one, and nothing otherwise - both are valid states of
  // this repository, and the second is what every older pin looks like.
  const real = readCompat();
  if (real === null) {
    return;
  }
  assert.deepEqual(compatOf(real), real, "well-formed");
  assert.match(real.framework.minimum, /^\d+\.\d+\.\d+$/);
  assert.match(real.linter, /^\d+\.\d+\.\d+/, "the linter's own version");
});
