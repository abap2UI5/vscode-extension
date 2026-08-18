import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORPUS_DIRS,
  SAMPLES_DIRS,
  SAMPLES_STACK_DIRS,
  VIEW_CHECK_DIRS,
} from "../repolayout";
import snapshot from "../data/repo-dirs.json";

/*
 * The directory names come from abap2UI5/ai-mcp (lib/repo-dirs.json) through
 * a generated snapshot. `npm run repo-dirs:check` proves the snapshot matches
 * ai-mcp; this proves the module matches the snapshot. Together they close the
 * loop the hand-written copy in this file's predecessor never did.
 */

test("every exported list comes from the snapshot, not from a second copy", () => {
  assert.deepEqual(VIEW_CHECK_DIRS, snapshot.dirs.viewCheck);
  assert.deepEqual(CORPUS_DIRS, snapshot.dirs.corpus);
  assert.deepEqual(SAMPLES_DIRS, snapshot.dirs.samples);
  assert.deepEqual(SAMPLES_STACK_DIRS, snapshot.dirs.samplesStack);
});

test("a fresh clone resolves first - the current name heads every list", () => {
  assert.equal(VIEW_CHECK_DIRS[0], "linter");
  assert.equal(CORPUS_DIRS[0], "samples-controls");
  assert.equal(SAMPLES_DIRS[0], "samples");
  assert.equal(SAMPLES_STACK_DIRS[0], "samples-stack");
});

test("a checkout made under an older repository name is still found", () => {
  // Every one of these was a real directory name; dropping it silently
  // un-finds somebody's working checkout.
  for (const legacy of ["abap2UI5-linter", "ai-view-check"]) {
    assert.ok(VIEW_CHECK_DIRS.includes(legacy), `${legacy} must still resolve`);
  }
  for (const legacy of ["abap2UI5-api", "ai-demokit"]) {
    assert.ok(CORPUS_DIRS.includes(legacy), `${legacy} must still resolve`);
  }
  assert.ok(SAMPLES_DIRS.includes("abap2UI5-samples"));
  assert.ok(SAMPLES_STACK_DIRS.includes("abap2UI5-samples-stack"));
});
