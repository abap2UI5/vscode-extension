import { test } from "node:test";
import assert from "node:assert/strict";
import { ExtractPlan, planExtract } from "../extractview";

/*
 * Moving the tail of a chain into a method. What is asserted is what would
 * otherwise have to be checked by hand every time: that the halves are both
 * balanced ABAP, that the handle is passed rather than invented twice, and
 * that everything the planner will not do is refused with a reason.
 */

const SOURCE = `CLASS zcl_app DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA name TYPE string.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.

ENDCLASS.

CLASS zcl_app IMPLEMENTATION.

  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).

    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->ele( n = \`Page\` )->a( n = \`title\` v = \`Demo\`
        )->ele( n = \`content\`
        )->tag( n = \`Button\` )->a( n = \`text\` v = \`Go\` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

ENDCLASS.`;

/** Apply a plan the way the command does - back to front. */
function apply(source: string, plan: ExtractPlan): string {
  let out = source;
  for (const edit of plan.edits) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

function planAt(source: string, marker: string, name = "render_button") {
  const plan = planExtract(source, source.indexOf(marker), name);
  assert.ok(!("error" in plan), `refused: ${"error" in plan ? plan.error : ""}`);
  return plan as ExtractPlan;
}

test("the tail becomes a method and the head keeps a handle", () => {
  const out = apply(SOURCE, planAt(SOURCE, ")->tag( n = `Button`"));
  // the head is captured and closed
  assert.ok(out.includes("DATA(content) = view->ele( n = `View`"));
  // the call takes the handle
  assert.ok(out.includes("render_button( content )."));
  // the method exists, is declared, and hangs off the parameter
  assert.ok(out.includes("METHODS render_button"));
  assert.ok(out.includes("box           TYPE REF TO z2ui5_cl_ui5_view_builder"));
  assert.ok(out.includes("result = box->tag( n = `Button` )"));
  assert.ok(out.includes("ENDMETHOD."));
});

test("both halves stay balanced ABAP", () => {
  const out = apply(SOURCE, planAt(SOURCE, ")->ele( n = `content`"));
  const opens = (out.match(/\(/g) ?? []).length;
  const closes = (out.match(/\)/g) ?? []).length;
  assert.equal(opens, closes);
  // the chain that was one statement is now two, each ending in a period
  assert.ok(/\)\.\n\n\s+render_button\( content \)\./.test(out));
});

test("a chain already captured keeps its own handle", () => {
  const captured = SOURCE.replace("    view->ele( n = `View`", "    DATA(page) = view->ele( n = `View`");
  const plan = planAt(captured, ")->tag( n = `Button`");
  assert.equal(plan.handle, "page");
  const out = apply(captured, plan);
  assert.ok(out.includes("render_button( page )."));
  // no second capture of the same chain
  assert.ok(!out.includes("DATA(content)"));
});

test("the extracted block keeps the shape of the tree it draws", () => {
  const out = apply(SOURCE, planAt(SOURCE, ")->ele( n = `Page`"));
  const body = out.slice(out.indexOf("METHOD render_button"));
  const first = body.split("\n").find((l) => l.includes("result = box"));
  assert.ok(first);
  // the statement starts at the method's own indent, and every continuation
  // line of the chain stays deeper than it - which is the only picture of the
  // view's tree a chain has
  assert.equal(/^[ \t]*/.exec(first)?.[0].length, 4);
  const continuations = body
    .split("\n")
    .filter((l) => l.trimStart().startsWith(")->"))
    .map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  assert.ok(continuations.length >= 2);
  assert.ok(
    continuations.every((indent) => indent > 4),
    `continuations stay deeper than the statement (${continuations.join(",")})`
  );
});

// ---------------------------------------------------------------------------
// What it refuses
// ---------------------------------------------------------------------------

test("a cursor outside a chain is refused, not guessed at", () => {
  const plan = planExtract(SOURCE, SOURCE.indexOf("DATA name TYPE string"), "render_x");
  assert.ok("error" in plan && /not a view builder chain/.test(plan.error));
});

test("a name that is not a name, or one already taken, is refused", () => {
  const bad = planExtract(SOURCE, SOURCE.indexOf(")->tag("), "2fast");
  assert.ok("error" in bad && /method name/i.test(bad.error));
  const taken = planExtract(
    SOURCE.replace("  PROTECTED SECTION.", "  PROTECTED SECTION.\n    METHODS render_button."),
    SOURCE.indexOf(")->tag("),
    "render_button"
  );
  assert.ok("error" in taken && /already declares/.test(taken.error));
});

test("a 30-character name - ABAP's limit - is a legal name", () => {
  const name = "render_the_whole_button_area_x"; // 30 characters
  assert.equal(name.length, 30);
  const plan = planExtract(SOURCE, SOURCE.indexOf(")->tag("), name);
  assert.ok(!("error" in plan), `refused: ${"error" in plan ? plan.error : ""}`);
});

test("a chained METHODS: declaration takes the name too", () => {
  // regression: `METHODS: view_display, render_button.` declares just as
  // well as the plain form, but the guard missed it - the plan then wrote a
  // second declaration and the class stopped compiling
  const taken = planExtract(
    SOURCE.replace(
      "  PROTECTED SECTION.",
      "  PROTECTED SECTION.\n    METHODS: view_display, render_button."
    ),
    SOURCE.indexOf(")->tag("),
    "render_button"
  );
  assert.ok("error" in taken && /already declares/.test(taken.error));
});

test("a method name in a comment declares nothing", () => {
  const plan = planExtract(
    SOURCE.replace(
      "  PROTECTED SECTION.",
      "  PROTECTED SECTION.\n    \" TODO write METHODS render_button here"
    ),
    SOURCE.indexOf(")->tag("),
    "render_button"
  );
  assert.ok(!("error" in plan), `refused: ${"error" in plan ? plan.error : ""}`);
});

test("a section named in a comment is not an insertion point", () => {
  // regression: `declarationPoint` searched the raw source, and a comment
  // mentioning `PROTECTED SECTION.` had the METHODS block inserted into its
  // middle - splitting the comment and leaving its tail behind as code
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    " later: move helpers to the PROTECTED SECTION. of this class
ENDCLASS.

CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`Page\`
        )->tag( n = \`Button\` )->a( n = \`text\` v = \`Go\` ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;
  const out = apply(source, planAt(source, ")->tag("));
  // the comment line survives in one piece
  assert.ok(out.includes('" later: move helpers to the PROTECTED SECTION. of this class'));
  // and the declaration sits inside the definition, before its ENDCLASS
  const decl = out.indexOf("METHODS render_button");
  assert.ok(decl >= 0 && decl < out.indexOf("CLASS zcl_app IMPLEMENTATION"));
});

test("both halves land in the class the chain lives in", () => {
  // regression: the declaration went into the FIRST class with a section
  // (the base class) while the implementation went before the LAST
  // ENDCLASS - the halves ended up in different classes and neither compiled
  const source = `CLASS zcl_base DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
ENDCLASS.
CLASS zcl_base IMPLEMENTATION.
ENDCLASS.

CLASS zcl_app DEFINITION PUBLIC INHERITING FROM zcl_base.
  PUBLIC SECTION.
ENDCLASS.
CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`Page\`
        )->tag( n = \`Button\` )->a( n = \`text\` v = \`Go\` ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;
  const out = apply(source, planAt(source, ")->tag("));
  const decl = out.indexOf("METHODS render_button");
  const impl = out.indexOf("METHOD render_button.");
  assert.ok(decl > out.indexOf("CLASS zcl_app DEFINITION"), "declared in zcl_app");
  assert.ok(decl < out.indexOf("CLASS zcl_app IMPLEMENTATION"), "declared in the definition");
  assert.ok(impl > out.indexOf("CLASS zcl_app IMPLEMENTATION"), "implemented in zcl_app");
  // the base class is untouched
  assert.ok(!out.slice(0, out.indexOf("CLASS zcl_app")).includes("render_button"));
});

test("every edit says what it does, for a refactor preview", () => {
  const plan = planAt(SOURCE, ")->tag( n = `Button`");
  assert.ok(plan.edits.length >= 3);
  for (const edit of plan.edits) {
    assert.ok(edit.label.trim(), "each edit carries a label");
  }
  assert.ok(plan.edits.some((e) => /Declare render_button/.test(e.label)));
  assert.ok(plan.edits.some((e) => /Implement render_button/.test(e.label)));
});

test("the first call of a chain has no head to leave behind", () => {
  // `view->ele( )` - there is nothing before it to keep
  const plan = planExtract(SOURCE, SOURCE.indexOf("view->ele( n = `View`") + 4, "render_all");
  assert.ok("error" in plan && /No chain call starts here/.test(plan.error));
});

test("an apostrophe in a comment does not move the statement's end", () => {
  // regression: the literal scan ignored comments, so `don't` opened a
  // literal that ran on and every period after it was read as being inside
  // one - the statement then ran past its real end and the cut was wrong
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
  PROTECTED SECTION.
ENDCLASS.

CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    " don't touch the layout below
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`Page\`
        )->ele( n = \`VBox\`
            )->a( n = \`text\` v = \`Hi\`
        )->end( ).
  ENDMETHOD.
ENDCLASS.`;
  const at = source.indexOf(")->ele( n = `VBox`");
  const plan = planExtract(source, at, "render_box");
  assert.ok(!("error" in plan), `refused: ${JSON.stringify(plan)}`);
});

test("a chain written inside client->view_display( ) is refused, not mangled", () => {
  /*
   * The classic one-statement style. Cut at a `)->`, the head keeps an
   * unclosed `view_display(` and the tail carries a `)` and a `stringify( )`
   * that belong to it - the result was a head that does not compile and a
   * method body with a foreign call and a spare paren.
   */
  const source = [
    "CLASS zcl_x DEFINITION PUBLIC.",
    "  PUBLIC SECTION.",
    "    INTERFACES z2ui5_if_app.",
    "ENDCLASS.",
    "",
    "CLASS zcl_x IMPLEMENTATION.",
    "  METHOD z2ui5_if_app~main.",
    "    client->view_display( z2ui5_cl_ui5_view_builder=>factory(",
    "      )->ele( `Page`",
    "      )->tag( `Button`",
    "      )->stringify( ) ).",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const plan = planExtract(source, source.indexOf(")->tag("), "build_button");
  assert.ok("error" in plan, "the shape was not refused");
  assert.match(plan.error, /inside another call/);
});

test("the same view captured in a variable extracts normally", () => {
  const source = [
    "CLASS zcl_x DEFINITION PUBLIC.",
    "  PUBLIC SECTION.",
    "    INTERFACES z2ui5_if_app.",
    "ENDCLASS.",
    "",
    "CLASS zcl_x IMPLEMENTATION.",
    "  METHOD z2ui5_if_app~main.",
    "    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).",
    "    view->ele( `Page`",
    "      )->tag( `Button`",
    "      )->a( n = `text` v = `Go` ).",
    "    client->view_display( view->stringify( ) ).",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const plan = planExtract(source, source.indexOf(")->tag("), "build_button");
  assert.ok(!("error" in plan), `refused: ${"error" in plan ? plan.error : ""}`);
});

test("a selection reaching past stringify is refused", () => {
  const source = [
    "CLASS zcl_x DEFINITION PUBLIC.",
    "  PUBLIC SECTION.",
    "    INTERFACES z2ui5_if_app.",
    "ENDCLASS.",
    "",
    "CLASS zcl_x IMPLEMENTATION.",
    "  METHOD z2ui5_if_app~main.",
    "    DATA(xml) = z2ui5_cl_ui5_view_builder=>factory(",
    "      )->ele( `Page`",
    "      )->tag( `Button`",
    "      )->stringify( ).",
    "  ENDMETHOD.",
    "ENDCLASS.",
  ].join("\n");
  const plan = planExtract(source, source.indexOf(")->tag("), "build_button");
  assert.ok("error" in plan);
  assert.match(plan.error, /stringify/);
});

test("a method name may start with an underscore, like the framework's own", () => {
  const { methodNameError } = require("../extractview") as typeof import("../extractview");
  assert.equal(methodNameError("_render_section"), undefined);
  assert.equal(methodNameError("render_section"), undefined);
  assert.match(methodNameError("2fast") ?? "", /starts with a letter or _/);
  assert.match(methodNameError("a".repeat(31)) ?? "", /at most 30 characters/);
  assert.match(methodNameError("with-dash") ?? "", /letters, digits and _/);
  // the plan applies the same rule - the input box and the refusal used to
  // carry two copies, and both rejected the leading `_`
  const plan = planExtract(SOURCE, SOURCE.indexOf(")->tag("), "_render_button");
  assert.ok(!("error" in plan), "error" in plan ? plan.error : "");
});
