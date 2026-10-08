import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import {
  CLOUD_GUI_DIRS,
  CORPUS_DIRS,
  checkoutHomes,
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

test("every checkout under the repos root is handed to the server by its env variable", () => {
  const root = path.join(path.sep, "repos");
  const present = new Set(
    ["abap2UI5", "samples-controls", "ai-demokit", "linter", "samples", "samples-stack", "abap-cloud-gui"].map(
      (d) => path.join(root, d)
    )
  );
  const env = checkoutHomes(root, (dir) => present.has(dir));
  assert.deepEqual(env, {
    A2UI5_HOME: path.join(root, "abap2UI5"),
    // the current name over the legacy one beside it
    SAMPLES_CONTROLS_HOME: path.join(root, "samples-controls"),
    AI_VIEW_CHECK_HOME: path.join(root, "linter"),
    SAMPLES_HOME: path.join(root, "samples"),
    SAMPLES_STACK_HOME: path.join(root, "samples-stack"),
    /* mcp-server's migrate_report reads abap-cloud-gui from a local checkout
     * only, and a server started through npx does not look beside the repos
     * root - the variable is the one way it finds the clone. */
    ABAP_CLOUD_GUI_HOME: path.join(root, "abap-cloud-gui"),
  });
  assert.ok(CLOUD_GUI_DIRS.length, "the snapshot names the abap-cloud-gui checkout");
});

test("no repos root, or nothing under it, hands nothing over", () => {
  assert.deepEqual(checkoutHomes("", () => true), {});
  assert.deepEqual(checkoutHomes("   ", () => true), {});
  assert.deepEqual(checkoutHomes("/repos", () => false), {});
});
