import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { loadSnapshot } from "@abap2ui5/linter/properties";
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
  enumSince: { "sap.ui.core.TextAlign": { End: "1.120" } },
  ui5Version: "1.136.0",
});

/** The keys an object carries WITHOUT enumerating them - the tables the
 *  linter hangs onto the controls map. */
const hiddenKeys = (o: object): string[] => {
  const visible = new Set(Object.keys(o));
  return Object.getOwnPropertyNames(o)
    .filter((k) => !visible.has(k))
    .sort();
};

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
  // the per-value @since table too - properties.mjs reads it for
  // enum-value-too-new, which never fired on vscode.dev while it was missing
  assert.deepEqual((data as Record<string, unknown>).__enumSince, {
    "sap.ui.core.TextAlign": { End: "1.120" },
  });
});

test("every hidden table loadSnapshot attaches, setSnapshotText attaches too", () => {
  /* The web build's contract, measured against the linter itself rather than
   * against a list written here: the next table the linter starts reading
   * off the controls map has to arrive in the browser host as well, or a
   * rule goes quiet there with no symptom. The desktop test bundle carries
   * the real snapshot next to itself - the same file `snapshot()` would load. */
  setSnapshotText(GOOD);
  const mine = hiddenKeys(snapshot());
  const theirs = hiddenKeys(loadSnapshot(path.join(__dirname, "properties.json")) as object);
  assert.deepEqual(mine, theirs, "setSnapshotText and loadSnapshot disagree about the hidden tables");
  assert.ok(theirs.includes("__enumSince"), "the linter no longer attaches __enumSince - the comparison lost its subject");
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
