import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { addToBaseline, readBaseline } from "../baselinefile";

const FINDING = {
  type: "control-too-new",
  control: "sap.m.Avatar",
  member: "",
  value: "",
} as never;

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "a2ui5-baseline-"));
}

test("readBaseline treats an absent or empty file as a fresh baseline", () => {
  const dir = tmp();
  assert.deepEqual(readBaseline(path.join(dir, "nope.json")), {});
  const empty = path.join(dir, "empty.json");
  fs.writeFileSync(empty, "   \n");
  assert.deepEqual(readBaseline(empty), {});
});

/* A baseline that is THERE but does not parse used to be treated as absent,
 * so the next quick-fix rewrote the file with a single entry and dropped
 * every other one. A hand-edit or a merge conflict is exactly how a baseline
 * stops parsing, which makes that a silent loss of the whole accepted debt. */
test("readBaseline refuses a file that exists but does not parse", () => {
  const dir = tmp();
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  fs.writeFileSync(file, '{"findings": {"a|b||": 1}\n<<<<<<< HEAD\n');
  assert.throws(() => readBaseline(file), /not a valid baseline file/);
});

test("addToBaseline leaves an unparseable file untouched", () => {
  const dir = tmp();
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  const corrupt = '{"findings": {"keep|me||": 3},,,}';
  fs.writeFileSync(file, corrupt);
  assert.throws(() => addToBaseline(file, path.join(dir, "x.clas.abap"), FINDING));
  assert.equal(fs.readFileSync(file, "utf8"), corrupt, "the file must not be rewritten");
});

test("addToBaseline keeps the existing entries and counts repeats", () => {
  const dir = tmp();
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ note: "mine", findings: { "other/f.clas.abap|x||": 2 } })
  );
  const src = path.join(dir, "app.clas.abap");
  const key = addToBaseline(file, src, FINDING);

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.note, "mine", "an existing note survives");
  assert.equal(after.findings["other/f.clas.abap|x||"], 2, "existing entries survive");
  assert.equal(after.findings[key], 1);

  addToBaseline(file, src, FINDING);
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).findings[key],
    2,
    "the same finding again raises the count"
  );
});
