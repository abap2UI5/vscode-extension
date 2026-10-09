import { test } from "node:test";
import * as assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  addAllToBaseline,
  addToBaseline,
  baselineWriteRefusal,
  readBaseline,
  rebuildBaseline,
} from "../baselinefile";

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
  assert.throws(() => addToBaseline(file, path.join(dir, "x.clas.abap"), FINDING, dir));
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
  const key = addToBaseline(file, src, FINDING, dir);

  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.note, "mine", "an existing note survives");
  assert.equal(after.findings["other/f.clas.abap|x||"], 2, "existing entries survive");
  assert.equal(after.findings[key], 1);

  addToBaseline(file, src, FINDING, dir);
  assert.equal(
    JSON.parse(fs.readFileSync(file, "utf8")).findings[key],
    2,
    "the same finding again raises the count"
  );
});

test("addAllToBaseline writes many findings once, counted like one at a time", () => {
  const dir = tmp();
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  fs.writeFileSync(file, JSON.stringify({ findings: { "keep|me||": 1 } }));
  const a = path.join(dir, "a.clas.abap");
  const b = path.join(dir, "b.clas.abap");
  const keys = addAllToBaseline(file, [
    { file: a, findings: [FINDING, FINDING] },
    { file: b, findings: [FINDING] },
  ], dir);
  assert.equal(keys.length, 3);
  const after = JSON.parse(fs.readFileSync(file, "utf8")).findings;
  assert.equal(after["keep|me||"], 1);
  assert.equal(after[keys[0]], 2, "two findings with one key count twice");
  assert.equal(after[keys[2]], 1);
  // nothing to add, nothing written
  const before = fs.statSync(file).mtimeMs;
  assert.deepEqual(addAllToBaseline(file, [{ file: a, findings: [] }], dir), []);
  assert.equal(fs.statSync(file).mtimeMs, before);
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
  ], dir);
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
  assert.throws(() => rebuildBaseline(file, [], dir), /not a valid baseline file/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a workspace with nothing to waive writes an empty baseline, not a broken one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2u5-baseline-"));
  const file = path.join(dir, "abap2ui5lint-baseline.json");
  const written = rebuildBaseline(file, [
    { file: path.join(dir, "src", "zcl_clean.clas.abap"), findings: [] },
  ], dir);
  assert.deepEqual(written, { entries: 0, findings: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).findings, {});
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The confinement - a repository's config names the file, the user's click
// writes it
// ---------------------------------------------------------------------------

test("a baseline outside the workspace folder is refused, nothing written", () => {
  /*
   * regression: "Add to Baseline" / "Update Baseline" wrote whatever path
   * the repo's abap2ui5lint.jsonc named - `"baseline": "../../somewhere.json"`
   * replaced a file of the user's with a baseline on the first click.
   */
  const outer = tmp();
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo);
  const victim = path.join(outer, "settings.json");
  fs.writeFileSync(victim, '{ "mine": true }');
  const src = path.join(repo, "zcl_app.clas.abap");
  const files = [{ file: src, findings: [FINDING] }];

  assert.throws(() => addToBaseline(victim, src, FINDING, repo), /outside the workspace folder/);
  assert.throws(() => addAllToBaseline(victim, files, repo), /outside the workspace folder/);
  assert.throws(() => rebuildBaseline(victim, files, repo), /outside the workspace folder/);
  assert.equal(fs.readFileSync(victim, "utf8"), '{ "mine": true }', "the file must be untouched");

  // the folder itself is no file to write, and no root means no write
  assert.ok(baselineWriteRefusal(repo, repo));
  assert.match(baselineWriteRefusal(path.join(repo, "b.json"), undefined) ?? "", /no abap2ui5lint\.jsonc/);
  // a sibling folder whose name starts like the root is outside too
  assert.ok(baselineWriteRefusal(path.join(`${repo}-evil`, "b.json"), repo));

  // inside - nested or not, existing or not - is fine
  assert.equal(baselineWriteRefusal(path.join(repo, "abap2ui5lint-baseline.json"), repo), undefined);
  assert.equal(baselineWriteRefusal(path.join(repo, "ci", "b.json"), repo), undefined);
  addToBaseline(path.join(repo, "abap2ui5lint-baseline.json"), src, FINDING, repo);
  fs.rmSync(outer, { recursive: true, force: true });
});

test("a symbolic link inside the folder does not carry the write outside", (t) => {
  const outer = tmp();
  const repo = path.join(outer, "repo");
  fs.mkdirSync(repo);
  const victim = path.join(outer, "settings.json");
  fs.writeFileSync(victim, "{}");
  const link = path.join(repo, "abap2ui5lint-baseline.json");
  try {
    fs.symlinkSync(victim, link);
  } catch {
    t.skip("no symbolic links here (Windows without the privilege)");
    return;
  }
  assert.match(baselineWriteRefusal(link, repo) ?? "", /outside the workspace folder/);
  assert.throws(() =>
    addToBaseline(link, path.join(repo, "zcl_app.clas.abap"), FINDING, repo)
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "{}");
  fs.rmSync(outer, { recursive: true, force: true });
});
