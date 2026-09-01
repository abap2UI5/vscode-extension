import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setSnapshotText,
  snapshot,
  snapshotError,
  snapshotUi5Version,
} from "../snapshot";

/*
 * `setSnapshotText` is the web build's one way to load the UI5 metadata -
 * the browser host has no `fs`, so the text arrives through
 * `vscode.workspace.fs` and this function has to mirror what the linter's
 * `loadSnapshot` does with the parsed file. Its contract is pinned here:
 * a good payload populates the metadata (enums and UI5 version riding along
 * non-enumerably), and every broken payload leaves an EMPTY cache with the
 * reason in `snapshotError` - never a throw, because the caller is the web
 * activation itself and an exception there would take the whole extension
 * down over a corrupt data file.
 */

const GOOD = JSON.stringify({
  controls: {
    "sap.m.Button": {
      properties: { text: { type: "string" } },
    },
  },
  enums: { "sap.ui.core.TextAlign": ["Begin", "Center", "End"] },
  ui5Version: "1.136.0",
});

test("a good payload populates the metadata", () => {
  setSnapshotText(GOOD);
  const data = snapshot();
  assert.ok(data["sap.m.Button"], "the controls map is the snapshot");
  assert.equal(snapshotError(), undefined);
  // the enum table rides along non-enumerably, as loadSnapshot does it -
  // enumerable, it would show up as a control named "__enums"
  assert.deepEqual(data.__enums, {
    "sap.ui.core.TextAlign": ["Begin", "Center", "End"],
  });
  assert.ok(!Object.keys(data).includes("__enums"));
  assert.equal(snapshotUi5Version(), "1.136.0");
});

test("malformed JSON leaves an empty cache without throwing", () => {
  setSnapshotText("this is not json {");
  assert.deepEqual(Object.keys(snapshot()), []);
  assert.ok(snapshotError(), "the reason has to be readable for the log");
  assert.equal(snapshotUi5Version(), undefined);
});

test("a wrong-shape body likewise", () => {
  // parses fine, but there is no `controls` section to hang the enums onto
  setSnapshotText('{"something": "else"}');
  assert.deepEqual(Object.keys(snapshot()), []);
  assert.ok(snapshotError());
  assert.equal(snapshotUi5Version(), undefined);
});

test("a payload without ui5Version exposes none, but stays usable", () => {
  setSnapshotText(JSON.stringify({ controls: { "sap.m.Text": {} } }));
  assert.ok(snapshot()["sap.m.Text"]);
  assert.equal(snapshotError(), undefined);
  // older snapshots predate the field - undefined, not "null"
  assert.equal(snapshotUi5Version(), undefined);
});

test("a broken payload after a good one empties the cache rather than keeping it", () => {
  setSnapshotText(GOOD);
  assert.ok(snapshot()["sap.m.Button"]);
  setSnapshotText("{broken");
  assert.deepEqual(Object.keys(snapshot()), []);
  assert.ok(snapshotError());
});
