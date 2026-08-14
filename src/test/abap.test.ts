import { test } from "node:test";
import assert from "node:assert/strict";
import { classNameOf, isAppClass, usesBuilder } from "../abap";

test("an app class is recognised in both INTERFACES spellings", () => {
  assert.ok(isAppClass("CLASS zcl_a DEFINITION.\n  INTERFACES z2ui5_if_app.\n"));
  // The chained form is just as common - and used to fall through, so F9
  // silently toggled a breakpoint instead of launching the app.
  assert.ok(isAppClass("  INTERFACES: z2ui5_if_app.\n"));
  assert.ok(isAppClass("  INTERFACES:\n    z2ui5_if_app,\n    if_serializable_object.\n"));
  assert.ok(isAppClass("  interfaces z2ui5_if_app ."));
});

test("a class implementing something else is not an app", () => {
  assert.equal(isAppClass("INTERFACES z2ui5_if_app_types."), false);
  assert.equal(isAppClass("INTERFACES if_oo_adt_classrun."), false);
});

test("only the generic builder counts as checkable", () => {
  assert.ok(usesBuilder("DATA(v) = z2ui5_cl_ui5_view_builder=>factory( )."));
  assert.ok(usesBuilder("z2ui5_cl_ui5_view_builder=>FACTORY( )"));
  // The typed builder is on its way out and deliberately not reconstructed.
  assert.equal(usesBuilder("DATA(v) = z2ui5_cl_xml_view=>factory( )."), false);
});

test("the class name comes from the definition, upper-cased", () => {
  assert.equal(
    classNameOf("CLASS zcl_my_app DEFINITION PUBLIC.", "whatever.abap"),
    "ZCL_MY_APP"
  );
});

test("a class name quoted in a comment does not win", () => {
  const source = [
    '" CLASS zcl_from_the_docs DEFINITION',
    "* CLASS zcl_old DEFINITION",
    "CLASS zcl_real DEFINITION PUBLIC FINAL.",
  ].join("\n");
  assert.equal(classNameOf(source, "x.clas.abap"), "ZCL_REAL");
});

test("without a definition the file name is used", () => {
  assert.equal(classNameOf("* nothing here", "/tmp/zcl_fallback.clas.abap"), "ZCL_FALLBACK");
  assert.equal(classNameOf("", "zcl_plain.abap"), "ZCL_PLAIN");
});

test("errorTokens pulls paths and quoted names out of an error text", () => {
  const { errorTokens } = require("../abap") as typeof import("../abap");
  const tokens = errorTokens(
    `Failed to load "sap/m/Tabel" - binding /MT_TRAVELS/STATUS resolved to undefined`
  );
  assert.ok(tokens.includes("/MT_TRAVELS/STATUS"));
  assert.ok(tokens.includes("sap/m/Tabel"));
  // longest first, so the specific token wins the lookup
  assert.equal(tokens[0].length >= tokens[tokens.length - 1].length, true);
  assert.deepEqual(errorTokens("nothing to see"), []);
});

test("declarationSpan finds the TYPES field, else the DATA line", () => {
  const { declarationSpan } = require("../abap") as typeof import("../abap");
  const src =
    "CLASS zcl_x DEFINITION PUBLIC.\n" +
    "  PUBLIC SECTION.\n" +
    "    TYPES: BEGIN OF ty_s_travel,\n" +
    "             id TYPE string,\n" +
    "             status TYPE string,\n" +
    "           END OF ty_s_travel.\n" +
    "    DATA mt_travels TYPE STANDARD TABLE OF ty_s_travel WITH EMPTY KEY.\n" +
    "    DATA mv_title TYPE string.\n" +
    "ENDCLASS.\n";
  const field = declarationSpan(src, "/MT_TRAVELS/STATUS");
  assert.ok(field);
  assert.equal(src.slice(field!.start, field!.end), "status");
  const root = declarationSpan(src, "/MV_TITLE");
  assert.ok(root);
  assert.equal(src.slice(root!.start, root!.end), "mv_title");
  // a relative path (a row field) resolves through the TYPES block too:
  // its single segment is not a DATA variable, so the root fallback misses
  // and the field lookup must have answered
  const rel = declarationSpan(src, "/MT_TRAVELS/ID");
  assert.equal(src.slice(rel!.start, rel!.end), "id");
  assert.equal(declarationSpan(src, "/NOPE"), undefined);
});
