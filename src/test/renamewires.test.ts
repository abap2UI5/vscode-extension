import { test } from "node:test";
import assert from "node:assert/strict";
import { attributeAt, attributeSpans, idAt, idLiterals, idSpans } from "../renamewires";

/*
 * The two names an abap2UI5 app ties itself together with, and the rule that
 * makes finding them safe: POSITION decides what a literal is, never its text.
 */

const SOURCE = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA mv_title TYPE string.
    DATA mt_tab TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
  PRIVATE SECTION.
    METHODS view_display.
ENDCLASS.

CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    " mv_title is set here
    mv_title = \`Hello\`.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`Page\` )->a( n = \`title\` v = client->_bind( mv_title )
        )->ele( n = \`Table\` )->a( n = \`id\` v = \`TABLE\`
        )->a( n = \`items\` v = client->_bind( mt_tab )
        )->tag( n = \`Text\` )->a( n = \`text\` v = \`{/MV_TITLE}\`
        )->tag( n = \`Input\` )->a( n = \`value\` v = \`{/MT_TAB/COLUMN}\` ).
    client->follow_up_action( client->_event_client(
        action = z2ui5_if_client=>cs_event-control_by_id
        t_arg  = VALUE #( ( \`TABLE\` ) ( \`setBusy\` ) ( \`true\` ) ) ) ).
    client->popover_display( by_id = \`TABLE\` xml = popover->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;

// ---------------------------------------------------------------------------
// Control ids
// ---------------------------------------------------------------------------

test("the id is found where it is declared and everywhere it is addressed", () => {
  const spans = idSpans(SOURCE, "TABLE");
  // the a( n = `id` ), the CONTROL_BY_ID wire, the popover anchor
  assert.equal(spans.length, 3);
  for (const span of spans) {
    assert.equal(SOURCE.slice(span.start, span.end), "TABLE");
  }
});

test("position decides what an id is, not the text", () => {
  // `setBusy` follows the id in the same wire and reads like a name; a
  // rename that took it would break the wire it belongs to
  const found = idLiterals(SOURCE).map((s) => s.name);
  assert.ok(!found.includes("setBusy"));
  assert.ok(!found.includes("true"));
  // and a control NAME is not an id either
  assert.ok(!found.includes("Table"));
  assert.ok(!found.includes("Page"));
});

test("the cursor has to be on the id itself", () => {
  const at = SOURCE.indexOf("`TABLE`") + 2;
  assert.equal(idAt(SOURCE, at)?.name, "TABLE");
  assert.equal(idAt(SOURCE, SOURCE.indexOf("`Page`") + 2), undefined);
});

test("an id nothing addresses is still renameable from its declaration", () => {
  const lonely = "view->ele( n = `Text` )->a( n = `id` v = `LONELY` ).";
  assert.deepEqual(
    idSpans(lonely, "LONELY").map((s) => s.name),
    ["LONELY"]
  );
});

// ---------------------------------------------------------------------------
// Bound attributes
// ---------------------------------------------------------------------------

test("an attribute is renamed in the class AND in the paths that bind it", () => {
  const spans = attributeSpans(SOURCE, "mv_title");
  const kinds = spans.map((s) => SOURCE.slice(s.start, s.end));
  // DATA declaration, the assignment, the _bind( ) argument, and {/MV_TITLE}
  assert.equal(spans.length, 4);
  assert.ok(kinds.includes("mv_title"));
  assert.ok(kinds.includes("MV_TITLE"));
});

test("a path INTO a structure renames only its root segment", () => {
  const spans = attributeSpans(SOURCE, "mt_tab");
  const texts = spans.map((s) => SOURCE.slice(s.start, s.end));
  assert.ok(texts.includes("MT_TAB"));
  // COLUMN is a field of the row, not the attribute being renamed
  assert.ok(!texts.includes("COLUMN"));
});

test("comments and unrelated text are left alone", () => {
  const spans = attributeSpans(SOURCE, "mv_title");
  const commentAt = SOURCE.indexOf('" mv_title is set here') + 2;
  assert.ok(!spans.some((s) => s.start === commentAt));
});

test("only a name the class declares is a rename target", () => {
  // a binding path into a nested structure, or a word that merely looks like
  // an attribute, must not offer a rename that would replace half a view
  assert.deepEqual(attributeSpans(SOURCE, "column"), []);
  assert.equal(attributeAt(SOURCE, SOURCE.indexOf("COLUMN") + 1), undefined);
});

test("the attribute is found from either of its two spellings", () => {
  assert.equal(attributeAt(SOURCE, SOURCE.indexOf("DATA mv_title") + 6)?.name, "mv_title");
  assert.equal(attributeAt(SOURCE, SOURCE.indexOf("{/MV_TITLE}") + 3)?.name, "MV_TITLE");
});
