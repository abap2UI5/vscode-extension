import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attributeAt,
  attributeSpans,
  declaredIds,
  idAt,
  idCompletionAt,
  idLiterals,
  idSpans,
  renameNameError,
} from "../renamewires";

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

test("a nested segment is left alone even when a declared name reads the same", () => {
  /*
   * Regression: the path pattern matched EVERY `/SEG`, so a class declaring
   * both `DATA title` and a row type with a `title` field had the nested
   * `{/MT_TAB/TITLE}` rewritten along with the attribute - the row binding
   * then resolved to nothing and the column rendered empty, silently.
   */
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA mt_tab TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
    DATA title TYPE string.
ENDCLASS.
CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`Page\` )->a( n = \`title2\` v = \`{/TITLE}\`
        )->tag( n = \`Text\` )->a( n = \`text\` v = \`{/MT_TAB/TITLE}\` ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;
  const spans = attributeSpans(source, "title");
  const nested = source.indexOf("{/MT_TAB/TITLE}") + "{/MT_TAB/".length;
  assert.ok(spans.length > 0, "the attribute itself is renameable");
  assert.ok(
    !spans.some((s) => s.start === nested),
    "the nested TITLE stays what it is - a field of the row"
  );
  const root = source.indexOf("{/TITLE}") + 2;
  assert.ok(spans.some((s) => s.start === root), "the root path is renamed");
});

test("an icon URL is not a binding path", () => {
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    DATA delete TYPE string.
ENDCLASS.
CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    view->tag( n = \`Button\` )->a( n = \`icon\` v = \`sap-icon://delete\` ).
  ENDMETHOD.
ENDCLASS.`;
  const spans = attributeSpans(source, "delete");
  assert.ok(
    !spans.some((s) => source.slice(s.start - 2, s.start) === "//"),
    "sap-icon://delete keeps its icon"
  );
});

test("a structure field is not a rename target - its relative bindings are not tracked", () => {
  /*
   * A field is addressed by RELATIVE paths (`{TITLE}` inside the row
   * template) that no pattern here finds - offering the rename would
   * rewrite the declaration and leave the binding behind, the exact
   * half-renamed wire this module exists to prevent.
   */
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_row,
             title TYPE string,
           END OF ty_row.
    DATA mt_tab TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
ENDCLASS.`;
  assert.deepEqual(attributeSpans(source, "title"), []);
  assert.equal(
    attributeAt(source, source.indexOf("title TYPE") + 1),
    undefined
  );
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

// ---------------------------------------------------------------------------
// What a comment must not do to a rename
// ---------------------------------------------------------------------------

test("an apostrophe in a comment does not hide the wires", () => {
  // regression: the scan read `don't` as the start of a literal, which then
  // ran to the next apostrophe anywhere in the file - every id after it
  // became invisible, so F2 renamed the declaration and left the wire behind
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    " don't rename one end of this and not the other
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`Page\` )->ele( n = \`Table\` )->a( n = \`id\` v = \`TABLE\` ).
    client->follow_up_action( client->_event_client(
        action = z2ui5_if_client=>cs_event-control_by_id
        t_arg  = VALUE #( ( \`TABLE\` ) ( \`setSelected\` ) ) ) ).
  ENDMETHOD.
ENDCLASS.`;
  const spans = idSpans(source, "TABLE");
  assert.equal(spans.length, 2, "both ends of the wire are found");
  for (const span of spans) {
    assert.equal(source.slice(span.start, span.end), "TABLE");
  }
});

test("a type name is not an attribute that can be renamed", () => {
  // regression: any word inside a declaration statement counted as declared,
  // so F2 on `string` offered to rewrite every TYPE clause in the class
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    DATA mv_title TYPE string.
    DATA mv_other TYPE string.
ENDCLASS.`;
  const at = source.indexOf("string");
  assert.equal(attributeAt(source, at + 1), undefined, "no rename on a type");
  // the attribute itself is still renamable
  const attr = attributeAt(source, source.indexOf("mv_title") + 1);
  assert.equal(attr?.name, "mv_title");
});

test("a chained declaration makes every entry renamable", () => {
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    DATA: mv_title TYPE string,
          mv_count TYPE i.
ENDCLASS.`;
  assert.equal(attributeAt(source, source.indexOf("mv_count") + 1)?.name, "mv_count");
});

test("a marker inside a comment arms nothing", () => {
  /*
   * Read raw, "TODO use control_by_id here" armed the scan and the next
   * literal - a toast text - was recorded as a control id. F2 then offered to
   * rename it, and renaming a real id whose text matched rewrote it too,
   * because the other end is found by text.
   */
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  \" TODO use control_by_id here",
    "  client->message_toast_display( `SAVE` ).",
    "ENDMETHOD.",
  ].join("\n");
  assert.deepEqual(
    idLiterals(source).map((s) => s.name),
    []
  );
});

test("a marker whose statement carries no literal does not reach the next one", () => {
  // `set_focus( lv_id )` passes a variable; the literal below belongs to the
  // statement after it and is not this wire's id
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  client->set_focus( lv_id ).",
    "  client->message_toast_display( `SAVED` ).",
    "ENDMETHOD.",
  ].join("\n");
  assert.deepEqual(
    idLiterals(source).map((s) => s.name),
    []
  );
});

test("a marker with its id in the same statement is still found", () => {
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  client->set_focus( `INPUT1` ).",
    "  client->message_toast_display( `SAVED` ).",
    "ENDMETHOD.",
  ].join("\n");
  assert.deepEqual(
    idLiterals(source).map((s) => s.name),
    ["INPUT1"]
  );
});

test("a multi-line wire still reaches its id", () => {
  // the VALUE #( ( … ) ) table spans lines - the statement, not the line, is
  // what bounds the search
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  client->follow_up_action( client->_event_client(",
    "      action = z2ui5_if_client=>cs_event-control_by_id",
    "      t_arg  = VALUE #( ( `TABLE` ) ( `setBusy` ) ( `true` ) ) ) ).",
    "ENDMETHOD.",
  ].join("\n");
  assert.deepEqual(
    idLiterals(source).map((s) => s.name),
    ["TABLE"]
  );
});

// ---------------------------------------------------------------------------
// What a renamed wire may be called
// ---------------------------------------------------------------------------

test("an attribute may not be renamed to something with a hyphen in it", () => {
  // one permissive `[\w-]+` test used to serve all three kinds, so
  // `mv_title` -> `mv-title` passed and the rename rewrote the DATA
  // declaration and every use into a component selector that does not compile
  const message = renameNameError("attribute", "mv-title");
  assert.ok(message, "a hyphen in an attribute name has to be refused");
  assert.match(message, /component selector/);
});

test("an attribute name is an ABAP identifier", () => {
  assert.equal(renameNameError("attribute", "mv_title"), undefined);
  assert.equal(renameNameError("attribute", "_hidden"), undefined);
  assert.equal(renameNameError("attribute", "MV_TITLE2"), undefined);
  for (const bad of ["1mv", "mv title", "mv.title", "", "mv#"]) {
    assert.ok(
      renameNameError("attribute", bad),
      `${JSON.stringify(bad)} is not an ABAP identifier`
    );
  }
  assert.equal(renameNameError("attribute", "m".repeat(30)), undefined);
  assert.match(
    renameNameError("attribute", "m".repeat(31)) ?? "",
    /at most 30 characters/
  );
});

test("an event name and a control id may carry a hyphen", () => {
  // they are STRINGS - nothing but the framework's own comparison reads them
  assert.equal(renameNameError("event", "SAVE-ALL"), undefined);
  assert.equal(renameNameError("id", "TABLE-1"), undefined);
  assert.match(renameNameError("event", "SAVE ALL") ?? "", /An event name/);
  assert.match(renameNameError("id", "TABLE.1") ?? "", /A control id/);
});

// ---------------------------------------------------------------------------
// attributeAt now delegates to attributeSpans - same answers, one walk
// ---------------------------------------------------------------------------

test("the attribute under the cursor is the one the spans agree on", () => {
  const at = SOURCE.indexOf("mv_title = ");
  const span = attributeAt(SOURCE, at + 2);
  assert.equal(span?.name, "mv_title");
  const spans = attributeSpans(SOURCE, "mv_title");
  assert.ok(
    spans.some((s) => s.start === span!.start && s.end === span!.end),
    "attributeAt has to answer with one of attributeSpans' own spans"
  );
});

test("a word the class does not declare is no attribute", () => {
  // `string` in `DATA mv_title TYPE string` - F2 on it used to offer a rename
  // that would have rewritten every TYPE clause in the class
  const at = SOURCE.indexOf("TYPE string") + "TYPE ".length;
  assert.equal(attributeAt(SOURCE, at + 1), undefined);
  assert.deepEqual(attributeSpans(SOURCE, "string"), []);
});

// ---------------------------------------------------------------------------
// Closing the wiring loop: which ids exist, and completing one where a wire
// addresses it
// ---------------------------------------------------------------------------

test("an id literal knows which end of the wire it is", () => {
  const roles = idLiterals(SOURCE).map((s) => [s.name, s.role]);
  assert.deepEqual(roles, [
    ["TABLE", "declaration"],
    ["TABLE", "wire"],
    ["TABLE", "wire"],
  ]);
});

test("only the view's own a( n = `id` ) declares an id", () => {
  assert.deepEqual(declaredIds(SOURCE), ["TABLE"]);
  // a wire alone declares nothing - completing from it would offer the typo
  const wireOnly = [
    "METHOD z2ui5_if_app~main.",
    "  client->set_focus( `INPUT1` ).",
    "ENDMETHOD.",
  ].join("\n");
  assert.deepEqual(declaredIds(wireOnly), []);
});

test("every declared id is offered once, in source order", () => {
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  view->ele( n = `Page` )->tag( n = `Table` )->a( n = `id` v = `TABLE` )",
    "      )->tag( n = `Input` )->a( n = `id` v = `INPUT1` )",
    "      )->tag( n = `Other` )->a( n = `id` v = `TABLE` ).",
    "  client->set_focus( `` ).",
    "ENDMETHOD.",
  ].join("\n");
  const at = source.indexOf("set_focus( `") + "set_focus( `".length;
  const offer = idCompletionAt(source, at);
  assert.deepEqual(offer?.ids, ["TABLE", "INPUT1"]);
  // an empty literal is where somebody is about to type an id, so the span to
  // replace is empty and starts right where the cursor is
  assert.equal(offer?.prefix, "");
  assert.equal(offer?.start, at);
  assert.equal(offer?.end, at);
});

test("a half-typed id in a wire is replaced whole", () => {
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  view->tag( n = `Table` )->a( n = `id` v = `TABLE` ).",
    "  client->popover_display( by_id = `TAB` ).",
    "ENDMETHOD.",
  ].join("\n");
  const start = source.indexOf("by_id = `") + "by_id = `".length;
  const offer = idCompletionAt(source, start + 2);
  assert.deepEqual(offer?.ids, ["TABLE"]);
  assert.equal(offer?.prefix, "TA");
  assert.equal(source.slice(offer!.start, offer!.end), "TAB");
});

test("the declaring literal itself is not completed", () => {
  // it is the source of truth for what the id is called - offering the ids it
  // defines back into it says nothing
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  view->tag( n = `Table` )->a( n = `id` v = `TABLE` ).",
    "ENDMETHOD.",
  ].join("\n");
  const at = source.indexOf("v = `TABLE") + "v = `".length;
  assert.equal(idCompletionAt(source, at + 1), undefined);
});

test("a literal that is no id offers nothing", () => {
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  view->tag( n = `Table` )->a( n = `id` v = `TABLE` ).",
    "  client->message_toast_display( `Saved` ).",
    "ENDMETHOD.",
  ].join("\n");
  const at = source.indexOf("`Saved`") + 2;
  assert.equal(idCompletionAt(source, at), undefined);
});

test("a wire quoted in a comment is not an id position", () => {
  const source = [
    "METHOD z2ui5_if_app~main.",
    "  view->tag( n = `Table` )->a( n = `id` v = `TABLE` ).",
    "  \" client->set_focus( `TABLE` ) once lived here",
    "ENDMETHOD.",
  ].join("\n");
  const at = source.indexOf("set_focus( `TABLE`") + "set_focus( `".length;
  assert.equal(idCompletionAt(source, at + 1), undefined);
});
