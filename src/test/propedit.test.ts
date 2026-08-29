import { test } from "node:test";
import assert from "node:assert/strict";
import { controlCallAt } from "../context";
import { removeAttributeEdit, setAttributeEdit } from "../propedit";

const SOURCE = `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA mv_value TYPE string.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->ele( \`Page\`
            )->a( n = \`title\` v = \`Hello\`
            )->tag( \`Button\`
                )->a( n = \`text\`  v = \`Press me\`
                )->a( n = \`press\` v = client->_event( \`GO\` )
            )->tag( \`Input\`
                )->a( n = \`value\` v = client->_bind( mv_value ) ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;

function apply(source: string, edit: { start: number; end: number; text: string }): string {
  return source.slice(0, edit.start) + edit.text + source.slice(edit.end);
}

test("controlCallAt finds the control block under the cursor", () => {
  const at = SOURCE.indexOf("`Press me`");
  const call = controlCallAt(SOURCE, at)!;
  assert.equal(call.label, "Button");
  assert.equal(call.control, "sap.m.Button");
  assert.equal(call.attrs.length, 2);
  assert.deepEqual(
    call.attrs.map((a) => [a.name, a.literal]),
    [
      ["text", true],
      ["press", false],
    ]
  );
  assert.equal(call.attrs[1].value, "client->_event( `GO` )");
});

test("controlCallAt resolves the namespace of the root", () => {
  const call = controlCallAt(SOURCE, SOURCE.indexOf("`View`"))!;
  assert.equal(call.control, "sap.ui.core.mvc.View");
});

test("the cursor outside any control block finds nothing", () => {
  assert.equal(controlCallAt(SOURCE, SOURCE.indexOf("view_display")), undefined);
  assert.equal(controlCallAt(SOURCE, 0), undefined);
});

test("setAttributeEdit rewrites an existing literal in place", () => {
  const call = controlCallAt(SOURCE, SOURCE.indexOf("`Press me`"))!;
  const edit = setAttributeEdit(SOURCE, call, "text", "Go!")!;
  const next = apply(SOURCE, edit);
  assert.ok(next.includes("n = `text`  v = `Go!`"));
  assert.ok(!next.includes("Press me"));
});

test("setAttributeEdit escapes the literal's quote", () => {
  const call = controlCallAt(SOURCE, SOURCE.indexOf("`Press me`"))!;
  const edit = setAttributeEdit(SOURCE, call, "text", "a ` b")!;
  assert.equal(edit.text, "a `` b");
});

test("setAttributeEdit appends a new chain line for an unset member", () => {
  const call = controlCallAt(SOURCE, SOURCE.indexOf("`Press me`"))!;
  const edit = setAttributeEdit(SOURCE, call, "enabled", "false")!;
  const next = apply(SOURCE, edit);
  assert.ok(
    next.includes(
      ")->a( n = `press` v = client->_event( `GO` )\n" +
        "                )->a( n = `enabled` v = `false`\n"
    ),
    next.slice(edit.start - 120, edit.start + 120)
  );
});

test("an expression value is not rewritten", () => {
  const call = controlCallAt(SOURCE, SOURCE.indexOf("`Press me`"))!;
  assert.equal(setAttributeEdit(SOURCE, call, "press", "GO2"), undefined);
});

test("removeAttributeEdit drops the whole chain line", () => {
  const call = controlCallAt(SOURCE, SOURCE.indexOf("`Press me`"))!;
  const edit = removeAttributeEdit(SOURCE, call, "text")!;
  const next = apply(SOURCE, edit);
  assert.ok(!next.includes("Press me"));
  // the chain stays intact: tag directly followed by the press attribute
  assert.ok(
    next.includes(")->tag( `Button`\n                )->a( n = `press`")
  );
});

test("a control with no attributes appends one step under its own line", () => {
  const source = `    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->tag( \`Text\`
        )->end( ).`;
  const call = controlCallAt(source, source.indexOf("`Text`"))!;
  assert.equal(call.attrs.length, 0);
  const edit = setAttributeEdit(source, call, "text", "hi")!;
  const next = apply(source, edit);
  assert.ok(
    next.includes(")->tag( `Text`\n            )->a( n = `text` v = `hi`\n")
  );
});

test("the last attribute of a chain can be removed too", () => {
  // its `)` sits on its own line (`)->a( … ).`), which used to be refused as
  // "not chain style" - and that is the shape of the final attribute of
  // every chain, not an exotic layout
  const call = controlCallAt(SOURCE, SOURCE.indexOf("mv_value )"))!;
  const edit = removeAttributeEdit(SOURCE, call, "value");
  assert.ok(edit, "the edit is offered");
  const next = apply(SOURCE, edit!);
  assert.ok(!next.includes("n = `value`"), "the attribute is gone");
  // the chain still closes and the statement still ends
  assert.ok(next.includes(")->tag( `Input`\n                )."), next);
  // and the parens still balance
  const parens = (s: string, ch: string) => s.split(ch).length - 1;
  const chain = next.slice(next.indexOf("DATA(view)"), next.indexOf("client->view_display"));
  assert.equal(parens(chain, "("), parens(chain, ")"));
});

test("a value that would cross ABAP's 255-character line limit is refused", () => {
  const long = "x".repeat(300);
  const call = controlCallAt(SOURCE, SOURCE.indexOf("`Press me`"))!;
  // in place - the rewritten line would not survive an abapGit import
  assert.equal(setAttributeEdit(SOURCE, call, "text", long), undefined);
  // appended - the new line would not either
  assert.equal(setAttributeEdit(SOURCE, call, "enabled", long), undefined);
  // and a value that fits still goes through
  assert.ok(setAttributeEdit(SOURCE, call, "text", "x".repeat(100)));
});

test("rewriting a value with a doubled quote replaces all of it", () => {
  /*
   * The literal's span used to stop at the first half of a doubled quote, so
   * the editor showed "it" for `it``s fine` and writing "hello" produced
   * `hello``s fine` - silent corruption of the source it was asked to edit.
   */
  const source =
    "    view->tag( n = `Text` )->a( n = `text` v = `it``s fine` ).";
  const call = controlCallAt(source, source.indexOf("Text` )"));
  assert.ok(call);
  const attr = call.attrs.find((a) => a.name === "text");
  assert.equal(attr?.value, "it`s fine");

  const edit = setAttributeEdit(source, call, "text", "hello");
  assert.ok(edit);
  const after = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  assert.equal(
    after,
    "    view->tag( n = `Text` )->a( n = `text` v = `hello` )."
  );
});

test("a new value containing a quote is written escaped", () => {
  const source = "    view->tag( n = `Text` )->a( n = `text` v = `plain` ).";
  const call = controlCallAt(source, source.indexOf("Text` )"));
  assert.ok(call);
  const edit = setAttributeEdit(source, call, "text", "it`s fine");
  assert.ok(edit);
  const after = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  assert.equal(
    after,
    "    view->tag( n = `Text` )->a( n = `text` v = `it``s fine` )."
  );
  // and it reads back as what was asked for - the round trip closes
  const reread = controlCallAt(after, after.indexOf("Text` )"));
  assert.equal(
    reread?.attrs.find((a) => a.name === "text")?.value,
    "it`s fine"
  );
});
