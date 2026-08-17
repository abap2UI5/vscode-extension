import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abapLiterals,
  abapSpans,
  abapStatements,
  blankNonCode,
  declaredNames,
  insideLiteral,
} from "../abapscan";

/*
 * The lexer every feature that reads ABAP with a regex goes through. Each of
 * these cases is one that a hand-rolled scan in some module got wrong before
 * they all came here.
 */

test("a quote inside a comment starts no literal", () => {
  // the one that made F2 rename find nothing: `don't` opened a literal that
  // ran to the next apostrophe anywhere in the file
  const source = [
    `    " that's the table wire`,
    "    mv_title = `Hello`.",
    "    mv_other = `World`.",
  ].join("\n");
  const literals = abapLiterals(source);
  assert.deepEqual(
    literals.map((l) => source.slice(l.start, l.end)),
    ["Hello", "World"]
  );
});

test("a literal does not survive a line break", () => {
  // an unclosed quote ends with its line rather than eating the rest of the
  // file - the difference between one broken line and a dead scan
  const source = "  mv_a = 'unclosed\n  mv_b = `fine`.";
  const literals = abapLiterals(source);
  assert.equal(literals.length, 2);
  assert.equal(source.slice(literals[1].start, literals[1].end), "fine");
});

test("both comment forms are found, and a quote in one is part of it", () => {
  const source = ["* a full line comment with 'quotes'", "DATA x. \" trailing"].join(
    "\n"
  );
  const comments = abapSpans(source).filter((s) => s.kind === "comment");
  assert.equal(comments.length, 2);
  assert.deepEqual(abapLiterals(source), []);
});

test("a doubled quote escapes rather than closes", () => {
  const source = "mv_a = 'it''s here'.";
  const literals = abapLiterals(source);
  assert.equal(literals.length, 1);
  assert.equal(source.slice(literals[0].start, literals[0].end), "it''s here");
});

test("blanking keeps every offset and every line break", () => {
  const source = "a = `x)y`. \" a comment (\nb = |t{ e }|.\n";
  const blanked = blankNonCode(source);
  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split("\n").length, source.split("\n").length);
  // what is left is code: the parens inside the literal and the comment are gone
  assert.equal(blanked.includes(")y"), false);
  assert.equal(blanked.includes("comment"), false);
  // and the code characters are where they were
  assert.equal(blanked[0], "a");
  assert.equal(blanked[source.indexOf(".")], ".");
});

test("a period inside a literal or a comment ends no statement", () => {
  const source = [
    "DATA(x) = '3.14'.",
    "mv_b = 1. \" done. really",
    "mv_c = 2.",
  ].join("\n");
  const statements = abapStatements(source);
  assert.equal(statements.length, 3);
  assert.ok(statements[0].text.includes("3.14"));
  assert.ok(statements[2].text.includes("mv_c"));
});

test("insideLiteral answers for the content, not the delimiters", () => {
  const source = "mv_a = `text`.";
  const at = source.indexOf("text");
  assert.equal(insideLiteral(source, at + 1), true);
  assert.equal(insideLiteral(source, 0), false);
});

// ---------------------------------------------------------------------------
// What a declaration declares
// ---------------------------------------------------------------------------

test("a declaration declares its name, not the words around it", () => {
  // F2 on the `string` here used to offer a rename that would have rewritten
  // every TYPE clause in the class
  const names = declaredNames("DATA mv_title TYPE string").map((d) => d.name);
  assert.deepEqual(names, ["mv_title"]);
});

test("every entry of a chained declaration counts", () => {
  const statement = "DATA: mv_a TYPE string,\n        mv_b TYPE i,\n        mv_c TYPE abap_bool";
  assert.deepEqual(
    declaredNames(statement).map((d) => d.name),
    ["mv_a", "mv_b", "mv_c"]
  );
});

test("a commented-out chain entry declares nothing", () => {
  const statement = [
    "DATA: mv_a TYPE string, \" old: mv_b TYPE string",
    "        mv_c TYPE i",
  ].join("\n");
  assert.deepEqual(
    declaredNames(statement).map((d) => d.name),
    ["mv_a", "mv_c"]
  );
});

test("the reported offset points at the name in the original text", () => {
  const statement = "DATA: mv_a TYPE string, mv_b TYPE i";
  for (const declared of declaredNames(statement)) {
    assert.equal(
      statement.slice(declared.at, declared.at + declared.name.length),
      declared.name
    );
  }
});

test("a statement that is not a declaration declares nothing", () => {
  assert.deepEqual(declaredNames("mv_title = `Hello`"), []);
});
