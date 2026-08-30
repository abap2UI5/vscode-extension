import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abapLiterals,
  abapSpans,
  abapStatements,
  blankComments,
  blankNonCode,
  declaredNames,
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

test("a BEGIN OF block declares the structure, not BEGIN and END", () => {
  // `BEGIN` and `END` used to come back as declared names, and the
  // roundtrip-cost annotation labelled them as attributes the class ships
  const statement =
    "DATA: BEGIN OF ms_head,\n        title TYPE string,\n      END OF ms_head";
  const declared = declaredNames(statement);
  assert.deepEqual(
    declared.map((d) => d.name),
    ["ms_head", "title"]
  );
  const structure = declared.find((d) => d.name === "ms_head");
  const component = declared.find((d) => d.name === "title");
  assert.equal(structure?.component, undefined, "the structure is the attribute");
  assert.equal(component?.component, true, "a field is a component of it");
  assert.equal(
    statement.slice(structure!.at, structure!.at + structure!.name.length),
    "ms_head"
  );
});

test("a nested BEGIN OF is a component of the outer structure", () => {
  const statement =
    "DATA: BEGIN OF ms_outer, BEGIN OF ms_inner, x TYPE i, END OF ms_inner, END OF ms_outer";
  const declared = declaredNames(statement);
  assert.deepEqual(
    declared.map((d) => [d.name, d.component === true]),
    [
      ["ms_outer", false],
      ["ms_inner", true],
      ["x", true],
    ]
  );
});

/*
 * String templates with embedded expressions.
 *
 * What is inside `{ }` is ABAP code, not template text - it nests, it holds
 * literals, and it holds further templates. Reading it as text let the
 * template close on the first `|` it met in there, and everything after that
 * was misread: the two cases below used to leak a nested template's contents
 * out as code, and to swallow the whole rest of the line - the following
 * statement with it.
 */

test("a template inside an embedded expression does not close the outer one", () => {
  const source = "x = |a { |b| } c|.";
  const blanked = blankNonCode(source);
  assert.equal(blanked.length, source.length);
  assert.ok(
    !blanked.includes("b"),
    `the nested template leaked out as code: ${JSON.stringify(blanked)}`
  );
  assert.equal(blanked.trimEnd().endsWith("."), true, "the statement still ends");
});

test("a pipe inside a literal inside an embedded expression is not the closer", () => {
  const source = "x = |val { get( 'a|b' ) }|. tag( `Text` ).";
  const blanked = blankNonCode(source);
  assert.equal(blanked.length, source.length);
  // the statement after the template is still code - this is the one that
  // used to disappear, taking F2, the outline and the formatter with it
  assert.ok(
    blanked.includes("tag("),
    `the following statement was swallowed: ${JSON.stringify(blanked)}`
  );
});

test("an escaped pipe does not close a template", () => {
  const source = "x = |esc \\| still|. tag( `T` ).";
  const blanked = blankNonCode(source);
  assert.equal(blanked.length, source.length);
  assert.ok(blanked.includes("tag("));
  assert.ok(!blanked.includes("still"));
});

test("a template spans lines, and the embedded code goes with it", () => {
  const source = "x = |a\n{ 1 + 2 }\nb|.\ntag( `T` ).";
  const blanked = blankNonCode(source);
  assert.equal(blanked.length, source.length);
  assert.equal(
    blanked.split("\n").length,
    source.split("\n").length,
    "line breaks inside the template have to survive the blanking"
  );
  assert.ok(blanked.includes("tag("));
});

/*
 * The blanking is built from the slices BETWEEN the spans now, rather than by
 * writing over a per-character array - the array cost one single-character
 * string per character of the class, several times per keystroke. The edges
 * of "between" are what the cases below pin down.
 */

test("a span that runs to the end of the source keeps the length", () => {
  for (const source of [
    "DATA x. \" trailing comment to EOF",
    "mv_a = `unterminated",
    "* a full line comment to EOF",
    "mv_a = |template to EOF",
  ]) {
    assert.equal(
      blankNonCode(source).length,
      source.length,
      `length changed for ${JSON.stringify(source)}`
    );
  }
});

test("a source without a single span comes back unchanged", () => {
  const source = "DATA mv_a TYPE i.\nmv_a = 1.\n";
  assert.equal(blankNonCode(source), source);
  assert.equal(blankComments(source), source);
});

test("CRLF survives the blanking as it always did - the \\n stays", () => {
  // the \r sits INSIDE the comment span (which ends at the \n), so it is
  // blanked like any other content character; the \n is what has to survive
  const source = "DATA x. \" note\r\nDATA y.\r\n";
  const blanked = blankNonCode(source);
  assert.equal(blanked.length, source.length);
  assert.equal(
    blanked.split("\n").length,
    source.split("\n").length,
    "line breaks have to survive"
  );
  assert.equal(blanked.includes("note"), false);
  assert.ok(blanked.startsWith("DATA x. "));
  assert.ok(blanked.includes("DATA y."));
});

test("blankComments leaves the literals and the templates alone", () => {
  const source = "mv_a = `keep`. \" drop\nmv_b = |t{ 1 }|.\n";
  const code = blankComments(source);
  assert.equal(code.length, source.length);
  assert.ok(code.includes("`keep`"));
  assert.ok(code.includes("|t{ 1 }|"));
  assert.equal(code.includes("drop"), false);
});

test("every code character keeps its offset through both blankings", () => {
  const source = [
    "CLASS zcl DEFINITION.",
    "  PUBLIC SECTION.",
    "    DATA mv_a TYPE string. \" the title",
    "ENDCLASS.",
    "CLASS zcl IMPLEMENTATION.",
    "  METHOD go.",
    "    mv_a = 'it''s here'.",
    "    lo_view->tag( n = `Button` )->a( n = `text` v = |x { mv_a } y| ).",
    "  ENDMETHOD.",
    "ENDCLASS.",
    "",
  ].join("\n");
  for (const blanked of [blankNonCode(source), blankComments(source)]) {
    assert.equal(blanked.length, source.length);
    for (let i = 0; i < source.length; i++) {
      const before = source[i];
      const after = blanked[i];
      assert.ok(
        after === before || after === " ",
        `offset ${i} became ${JSON.stringify(after)}, not a space`
      );
      if (before === "\n") {
        assert.equal(after, "\n", `the newline at ${i} was blanked`);
      }
    }
  }
});

/*
 * The memo. It is keyed on the source as handed in - which for the VS Code
 * callers is the identical string INSTANCE per document version - and it must
 * be invisible: the same text answers the same way whether it hits or misses,
 * and a different text is never served an older answer.
 */

test("the memo answers a repeat call with the same lex", () => {
  // long enough to be worth a memo slot, so this exercises the cached path
  const source =
    "CLASS zcl DEFINITION.\n" +
    "  PUBLIC SECTION.\n" +
    `    DATA mv_a TYPE string. \" a comment\n`.repeat(200) +
    "ENDCLASS.\n";
  const first = abapSpans(source);
  const second = abapSpans(source);
  assert.equal(second, first, "the spans are handed out once, not rebuilt");
  assert.equal(blankNonCode(source), blankNonCode(source));
  assert.equal(blankComments(source), blankComments(source));
  // and the answer is the same one the uncached path gives for equal text
  const copy = source.slice(0, source.length - 1) + "\n";
  assert.equal(blankNonCode(copy), blankNonCode(source));
});

test("a changed source is not served the previous answer", () => {
  const head = "CLASS zcl DEFINITION.\n" + `    DATA mv TYPE i.\n`.repeat(200);
  const before = head + "    mv = 'one'.\n";
  const after = head + "    mv = 'two'.\n";
  assert.ok(blankNonCode(before).length === before.length);
  const blankedAfter = blankNonCode(after);
  assert.equal(blankedAfter.length, after.length);
  assert.equal(blankedAfter.includes("two"), false);
  // back again - the first entry is still correct after the second evicted
  // nothing it needed
  assert.equal(blankNonCode(before).includes("one"), false);
  assert.equal(
    abapLiterals(after).map((l) => after.slice(l.start, l.end)).pop(),
    "two"
  );
});

test("blanking keeps its length even on a trailing escape mid-typing", () => {
  // `j += 2` used to step one past the end, and the blanking loop then wrote
  // a character that was not there before
  for (const source of ["x = |a\\", "x = |{ 'a\\", "x = `a"]) {
    assert.equal(
      blankNonCode(source).length,
      source.length,
      `length changed for ${JSON.stringify(source)}`
    );
  }
});
