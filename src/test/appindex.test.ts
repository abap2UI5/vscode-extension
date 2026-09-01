import { test } from "node:test";
import assert from "node:assert/strict";
import { AppClassIndex } from "../appindex";
import { AppClassInfo, appClassInfoOf } from "../abap";

/*
 * The rename bookkeeping of the app-class index.
 *
 * The regression pinned here: dropping a renamed-away class name used to be
 * keyed on OBJECT IDENTITY against the per-version parse memo - and a
 * background rebuild landing between the rename keystroke and the save
 * stores fresh objects (the disk scan still yields the old name for an
 * unsaved rename), so the identity never matched and the stale name kept
 * answering. The index now records which name each document contributed and
 * deletes by that record, whatever object a rebuild has since stored.
 */

const info = (isApp: boolean, superclass?: string): AppClassInfo => ({
  isApp,
  superclass,
});

test("a rename drops the name the document contributed", () => {
  const index = new AppClassIndex();
  index.update("adt://sys/ZCL_BASE", "ZCL_BASE", info(true));
  const stale = index.update("adt://sys/ZCL_BASE", "ZCL_BASE_V2", info(true));
  assert.equal(stale, "ZCL_BASE");
  assert.equal(index.get("ZCL_BASE"), undefined, "the old name must be gone");
  assert.ok(index.get("ZCL_BASE_V2"));
});

test("the drop survives a rebuild that stored a DIFFERENT object under the old name", () => {
  // the exact sequence the identity check missed: rename typed but not
  // saved, a background rebuild runs - the disk scan still parses the old
  // name out of the file, as a fresh object - then the save updates in place
  const index = new AppClassIndex();
  const base = "CLASS zcl_base DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES z2ui5_if_app.\nENDCLASS.";
  index.update("file:///zcl_base.clas.abap", "ZCL_BASE", appClassInfoOf(base));

  const rebuilt = new Map<string, AppClassInfo>([
    // the file on disk still says ZCL_BASE - a NEW AppClassInfo object
    ["ZCL_BASE", appClassInfoOf(base)],
    ["ZCL_OTHER", info(false)],
  ]);
  index.replace(
    rebuilt,
    new Map([["file:///zcl_base.clas.abap", "ZCL_BASE"]])
  );

  const stale = index.update(
    "file:///zcl_base.clas.abap",
    "ZCL_BASE_V2",
    info(true)
  );
  assert.equal(stale, "ZCL_BASE");
  assert.equal(
    index.get("ZCL_BASE"),
    undefined,
    "the rebuild's fresh object must not shield the stale name from the rename"
  );
  assert.ok(index.get("ZCL_BASE_V2"));
  assert.ok(index.get("ZCL_OTHER"), "unrelated entries stay");
});

test("a rebuild that already recorded the new name makes the save a no-op rename-wise", () => {
  // the other half of the same window: the rebuild's open-documents pass saw
  // the renamed buffer, so the contribution is already the NEW name and the
  // rebuild itself dropped the old one - the save must not report a rename
  const index = new AppClassIndex();
  index.update("adt://sys/ZCL_A", "ZCL_OLD", info(true));
  index.replace(
    new Map([["ZCL_NEW", info(true)]]),
    new Map([["adt://sys/ZCL_A", "ZCL_NEW"]])
  );
  const stale = index.update("adt://sys/ZCL_A", "ZCL_NEW", info(true));
  assert.equal(stale, undefined);
  assert.ok(index.get("ZCL_NEW"));
});

test("restore puts back an entry another owner still defines, without stealing the contribution", () => {
  const index = new AppClassIndex();
  index.update("doc:a", "ZCL_SHARED", info(true));
  index.update("doc:b", "ZCL_SHARED", info(true));
  // doc:b renames away; doc:a still defines ZCL_SHARED and is restored
  const stale = index.update("doc:b", "ZCL_B", info(false));
  assert.equal(stale, "ZCL_SHARED");
  index.restore("ZCL_SHARED", info(true));
  assert.ok(index.get("ZCL_SHARED"));
  // a later rename of doc:a still owns and drops the shared name
  assert.equal(index.update("doc:a", "ZCL_A", info(true)), "ZCL_SHARED");
  assert.equal(index.get("ZCL_SHARED"), undefined);
});

test("a closed document's contribution is forgotten, its entry left for the rebuild", () => {
  const index = new AppClassIndex();
  index.update("doc:a", "ZCL_A", info(true));
  index.forget("doc:a");
  // the entry itself stays until the scheduled rebuild replaces the map -
  // a file on disk is picked up again there
  assert.ok(index.get("ZCL_A"));
  // and a reopened document under the same key starts without a phantom
  // previous contribution
  assert.equal(index.update("doc:a", "ZCL_B", info(true)), undefined);
});
