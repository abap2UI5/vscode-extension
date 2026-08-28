import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classNameOf,
  isAppClass,
  isAppClassDeep,
  superclassOf,
  usesBuilder,
} from "../abap";

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

/*
 * An app that inherits the interface (abap2UI5/vscode-extension#81).
 *
 * A shared base class carrying `INTERFACES z2ui5_if_app` and the lifecycle
 * methods, with each app redefining them, is a common way to keep a team's
 * apps uniform. To the editor those apps looked like ordinary classes: F9,
 * the CodeLens, the apps tree and the navigation map all went quiet.
 */

const BASE = `CLASS zcl_app_base DEFINITION PUBLIC ABSTRACT CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
  PROTECTED SECTION.
    METHODS on_init ABSTRACT.
ENDCLASS.

CLASS zcl_app_base IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
  ENDMETHOD.
ENDCLASS.`;

const CHILD = `CLASS zcl_my_app DEFINITION PUBLIC FINAL CREATE PUBLIC
  INHERITING FROM zcl_app_base.
  PROTECTED SECTION.
    METHODS on_init REDEFINITION.
ENDCLASS.

CLASS zcl_my_app IMPLEMENTATION.
  METHOD on_init.
  ENDMETHOD.
ENDCLASS.`;

const resolver = (classes: Record<string, string>) => (name: string) =>
  classes[name.toUpperCase()];

test("superclassOf reads the name out of the definition statement", () => {
  assert.equal(superclassOf(CHILD), "ZCL_APP_BASE");
  assert.equal(superclassOf(BASE), undefined);
  assert.equal(
    superclassOf("CLASS zcl_x DEFINITION INHERITING FROM zcl_b FINAL."),
    "ZCL_B"
  );
});

test("superclassOf ignores a commented-out INHERITING FROM", () => {
  const source = [
    "* CLASS zcl_old DEFINITION INHERITING FROM zcl_wrong.",
    "CLASS zcl_x DEFINITION PUBLIC.",
    '  " INHERITING FROM zcl_also_wrong',
    "  PUBLIC SECTION.",
    "ENDCLASS.",
  ].join("\n");
  assert.equal(superclassOf(source), undefined);
});

test("superclassOf does not read a second class's parent", () => {
  const source = [
    "CLASS zcl_first DEFINITION PUBLIC.",
    "  PUBLIC SECTION.",
    "ENDCLASS.",
    "CLASS zcl_second DEFINITION INHERITING FROM zcl_base.",
    "ENDCLASS.",
  ].join("\n");
  assert.equal(superclassOf(source), undefined);
});

test("a class inheriting the interface is an app", () => {
  const sourceOf = resolver({ ZCL_APP_BASE: BASE });
  assert.equal(isAppClass(CHILD), false, "it does not write the interface");
  assert.equal(isAppClassDeep(CHILD, sourceOf), true);
  assert.equal(isAppClassDeep(BASE, sourceOf), true);
});

test("the chain is followed over several levels", () => {
  const middle = `CLASS zcl_mid DEFINITION PUBLIC INHERITING FROM zcl_app_base.
ENDCLASS.`;
  const leaf = `CLASS zcl_leaf DEFINITION PUBLIC INHERITING FROM zcl_mid.
ENDCLASS.`;
  const sourceOf = resolver({ ZCL_APP_BASE: BASE, ZCL_MID: middle });
  assert.equal(isAppClassDeep(leaf, sourceOf), true);
});

test("an unreachable base class means 'not an app', not a guess", () => {
  // the normal case for a base class in another package this window cannot see
  assert.equal(isAppClassDeep(CHILD, () => undefined), false);
});

test("a class that inherits from something unrelated is not an app", () => {
  const other = `CLASS zcl_other DEFINITION PUBLIC.
ENDCLASS.`;
  assert.equal(
    isAppClassDeep(CHILD, resolver({ ZCL_APP_BASE: other })),
    false
  );
});

test("an inheritance cycle in a half-written buffer terminates", () => {
  const a = "CLASS zcl_a DEFINITION PUBLIC INHERITING FROM zcl_b.\nENDCLASS.";
  const b = "CLASS zcl_b DEFINITION PUBLIC INHERITING FROM zcl_a.\nENDCLASS.";
  assert.equal(isAppClassDeep(a, resolver({ ZCL_A: a, ZCL_B: b })), false);
});
