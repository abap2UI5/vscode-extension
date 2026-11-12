import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverTests } from "../unitdiscovery";

/*
 * What the Testing view lists comes from the text of a test include alone:
 * the local classes that are FOR TESTING and their FOR TESTING methods, each
 * at the range it is declared at - which is also where a failure is shown,
 * because the runner's report names a method and no line.
 */

const INCLUDE = [
  "CLASS ltcl_one DEFINITION FINAL FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.",
  "  PRIVATE SECTION.",
  "    METHODS setup.",
  "    METHODS adds FOR TESTING.",
  "    METHODS fails FOR TESTING RAISING cx_static_check.",
  "    METHODS helper IMPORTING iv TYPE i.",
  "ENDCLASS.",
  "",
  "CLASS ltcl_one IMPLEMENTATION.",
  "  METHOD setup.",
  "  ENDMETHOD.",
  "  METHOD adds.",
  "  ENDMETHOD.",
  "  METHOD fails.",
  "  ENDMETHOD.",
  "  METHOD helper.",
  "  ENDMETHOD.",
  "ENDCLASS.",
  "",
  "CLASS ltcl_two DEFINITION FOR TESTING",
  "  DURATION SHORT",
  "  RISK LEVEL HARMLESS.",
  "  PRIVATE SECTION.",
  "    CLASS-METHODS class_setup.",
  "    METHODS: first FOR TESTING,",
  "             second FOR TESTING RAISING cx_root,",
  "             not_a_test.",
  "ENDCLASS.",
  "",
  "CLASS ltcl_two IMPLEMENTATION.",
  "  METHOD class_setup. ENDMETHOD.",
  "  METHOD first. ENDMETHOD.",
  "  METHOD second. ENDMETHOD.",
  "  METHOD not_a_test. ENDMETHOD.",
  "ENDCLASS.",
].join("\n");

const names = (source: string): Array<[string, string[]]> =>
  discoverTests(source).map((cls) => [cls.name, cls.methods.map((m) => m.name)]);

test("several test classes in one include, each with its own methods", () => {
  assert.deepEqual(names(INCLUDE), [
    ["ltcl_one", ["adds", "fails"]],
    ["ltcl_two", ["first", "second"]],
  ]);
});

test("every range is the name where it is declared", () => {
  const lines = INCLUDE.split("\n");
  const at = (r: { startLine: number; startCharacter: number; endLine: number; endCharacter: number }): string => {
    assert.equal(r.startLine, r.endLine);
    return lines[r.startLine].slice(r.startCharacter, r.endCharacter);
  };
  const [one, two] = discoverTests(INCLUDE);
  assert.equal(at(one.range), "ltcl_one");
  assert.equal(one.range.startLine, 0);
  assert.deepEqual(one.methods.map((m) => [at(m.range), m.range.startLine]), [
    ["adds", 3],
    ["fails", 4],
  ]);
  assert.equal(at(two.range), "ltcl_two");
  assert.equal(two.range.startLine, 19);
  // the chained declaration: each name on its own line
  assert.deepEqual(two.methods.map((m) => [at(m.range), m.range.startLine]), [
    ["first", 24],
    ["second", 25],
  ]);
});

test("the fixtures are kept apart from the tests, with their declaration", () => {
  const [one, two] = discoverTests(INCLUDE);
  assert.deepEqual(one.fixtures.map((f) => [f.name, f.range.startLine]), [["setup", 2]]);
  assert.deepEqual(two.fixtures.map((f) => [f.name, f.range.startLine]), [["class_setup", 23]]);
});

test("a keyword inside a comment declares nothing", () => {
  const source = [
    "* CLASS ltcl_old DEFINITION FOR TESTING.",
    '" CLASS ltcl_older DEFINITION FOR TESTING.',
    "CLASS ltcl_real DEFINITION FOR TESTING. \" FOR TESTING, said twice",
    "  PRIVATE SECTION.",
    "*   METHODS gone FOR TESTING.",
    '    " METHODS gone_too FOR TESTING.',
    "    METHODS stays FOR TESTING. \" METHODS trailing FOR TESTING.",
    '    METHODS plain. " FOR TESTING',
    "ENDCLASS.",
  ].join("\n");
  assert.deepEqual(names(source), [["ltcl_real", ["stays"]]]);
});

test("a keyword inside a literal or a string template declares nothing", () => {
  const source = [
    "CLASS ltcl_real DEFINITION FOR TESTING.",
    "  PRIVATE SECTION.",
    "    CONSTANTS c_text TYPE string VALUE 'METHODS fake FOR TESTING.'.",
    "    CONSTANTS c_more TYPE string VALUE `ENDCLASS. CLASS ltcl_fake DEFINITION FOR TESTING.`.",
    "    METHODS real FOR TESTING.",
    "ENDCLASS.",
    "CLASS ltcl_real IMPLEMENTATION.",
    "  METHOD real.",
    "    DATA(lv) = |CLASS ltcl_tmpl DEFINITION FOR TESTING. METHODS x FOR TESTING.|.",
    "    DATA(lw) = 'CLASS ltcl_lit DEFINITION FOR TESTING.'.",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  assert.deepEqual(names(source), [["ltcl_real", ["real"]]]);
});

test("a class that is not FOR TESTING is left out - a double, a helper", () => {
  const source = [
    "CLASS ltd_double DEFINITION.",
    "  PUBLIC SECTION.",
    "    METHODS looks_like_one FOR TESTING.",
    "ENDCLASS.",
    "CLASS ltcl_test DEFINITION FOR TESTING.",
    "  PRIVATE SECTION.",
    "    METHODS one FOR TESTING.",
    "ENDCLASS.",
  ].join("\n");
  assert.deepEqual(names(source), [["ltcl_test", ["one"]]]);
});

test("DEFERRED and ABSTRACT definitions are not test classes to run", () => {
  const source = [
    "CLASS ltcl_test DEFINITION DEFERRED.",
    "CLASS zcl_app DEFINITION LOCAL FRIENDS ltcl_test.",
    "CLASS ltcl_base DEFINITION ABSTRACT FOR TESTING.",
    "  PROTECTED SECTION.",
    "    METHODS shared FOR TESTING.",
    "ENDCLASS.",
    "CLASS ltcl_test DEFINITION FOR TESTING INHERITING FROM ltcl_base.",
    "  PRIVATE SECTION.",
    "    METHODS own FOR TESTING.",
    "ENDCLASS.",
  ].join("\n");
  assert.deepEqual(names(source), [["ltcl_test", ["own"]]]);
});

test("case and layout do not matter, CRLF keeps the lines right", () => {
  const source = [
    "class LTCL_Up definition",
    "  for  testing.",
    "  private section.",
    "    methods Check_It for",
    "      testing.",
    "endclass.",
  ].join("\r\n");
  const [cls] = discoverTests(source);
  assert.equal(cls.name, "LTCL_Up");
  assert.deepEqual(cls.methods.map((m) => [m.name, m.range.startLine, m.range.startCharacter]), [
    ["Check_It", 3, 12],
  ]);
});

test("a test class without a test method is listed with none", () => {
  assert.deepEqual(names("CLASS ltcl_empty DEFINITION FOR TESTING.\nENDCLASS."), [
    ["ltcl_empty", []],
  ]);
});

test("an empty include, and one cut off mid-class, do not throw", () => {
  assert.deepEqual(discoverTests(""), []);
  assert.deepEqual(names("CLASS ltcl_cut DEFINITION FOR TESTING.\n  PRIVATE SECTION.\n    METHODS a FOR TESTING.\n    METHODS b FOR TEST"), [
    ["ltcl_cut", ["a"]],
  ]);
  assert.deepEqual(names("CLASS ltcl_cut DEFINITION FOR TESTING"), []);
});
