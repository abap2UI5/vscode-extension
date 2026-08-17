import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { addToBaseline, readBaseline, rebuildBaseline } from "../baselinefile";

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

// ---------------------------------------------------------------------------
// rebuildBaseline - the editor's --update-baseline
// ---------------------------------------------------------------------------

test("a rebuild replaces the file: today's findings, nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2u5-baseline-"));
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ note: "kept", findings: { "gone/zcl_old.clas.abap|dead-rule": 3 } })
  );
  const written = rebuildBaseline(file, [
    {
      file: path.join(dir, "src", "zcl_a.clas.abap"),
      findings: [
        { type: "unknown-binding-path", control: "sap.m.Input", value: "{/TYPO}" },
        { type: "unknown-binding-path", control: "sap.m.Input", value: "{/TYPO}" },
      ] as never,
    },
    {
      file: path.join(dir, "src", "zcl_b.clas.abap"),
      findings: [{ type: "event-without-handler", control: "sap.m.Button" }] as never,
    },
  ]);
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  // the stale entry is GONE - a baseline that only grows is one the CLI fails on
  assert.ok(!Object.keys(stored.findings).some((k) => k.includes("zcl_old")));
  assert.equal(written.entries, 2);
  assert.equal(written.findings, 3);
  // repeated findings are counted, not deduplicated
  assert.ok(Object.values(stored.findings).includes(2));
  // keys are relative to the baseline file and sorted, as the CLI writes them
  assert.ok(Object.keys(stored.findings).every((k) => k.startsWith("src/")));
  assert.deepEqual(Object.keys(stored.findings), Object.keys(stored.findings).slice().sort());
  assert.equal(stored.note, "kept");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a baseline that does not parse is not silently replaced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2u5-baseline-"));
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  fs.writeFileSync(file, "{ this is not json");
  assert.throws(() => rebuildBaseline(file, []), /not a valid baseline file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a workspace with nothing to waive writes an empty baseline, not a broken one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2u5-baseline-"));
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  const written = rebuildBaseline(file, [
    { file: path.join(dir, "src", "zcl_clean.clas.abap"), findings: [] },
  ]);
  assert.deepEqual(written, { entries: 0, findings: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).findings, {});
  fs.rmSync(dir, { recursive: true, force: true });
});
