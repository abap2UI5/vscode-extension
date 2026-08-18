import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CORPUS_DIRS,
  SAMPLES_DIRS,
  SAMPLES_STACK_DIRS,
  SERVER_DIRS,
  VIEW_CHECK_DIRS,
} from "../repolayout";
import snapshot from "../data/repo-dirs.json";

/*
 * The directory names come from abap2UI5/mcp-server (lib/repo-dirs.json)
 * through a generated snapshot. `npm run repo-dirs:check` proves the snapshot
 * matches mcp-server; this proves the module matches the snapshot. Together
 * they close the loop the hand-written copy in this file's predecessor never
 * did.
 */

test("every exported list comes from the snapshot, not from a second copy", () => {
  assert.deepEqual(VIEW_CHECK_DIRS, snapshot.dirs.viewCheck);
  assert.deepEqual(CORPUS_DIRS, snapshot.dirs.corpus);
  assert.deepEqual(SAMPLES_DIRS, snapshot.dirs.samples);
  assert.deepEqual(SAMPLES_STACK_DIRS, snapshot.dirs.samplesStack);
  assert.deepEqual(SERVER_DIRS, snapshot.dirs.server);
});

test("a fresh clone resolves first - the current name heads every list", () => {
  assert.equal(VIEW_CHECK_DIRS[0], "linter");
  assert.equal(CORPUS_DIRS[0], "samples-controls");
  assert.equal(SAMPLES_DIRS[0], "samples");
  assert.equal(SAMPLES_STACK_DIRS[0], "samples-stack");
  assert.equal(SERVER_DIRS[0], "mcp-server");
});

/* serverCommand() walks SERVER_DIRS to find a local checkout before falling
 * back to npx. It used to join one hard-coded "ai-mcp", so the day the
 * repository was renamed a user who had pointed reposRoot at their clones
 * would silently get the network copy instead of the one they cloned - the
 * server still starts, which is why nothing would have reported it.
 *
 * Both names have to stay resolvable: a checkout made before the rename is
 * still a working checkout. */
test("the previous repository name still resolves a local checkout", () => {
  assert.ok(SERVER_DIRS.includes("ai-mcp"),
    "a clone made before the 2026-08 rename must keep being found");
  assert.ok(SERVER_DIRS.length >= 2,
    "the list is the rename history - one entry means the history was dropped");
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
