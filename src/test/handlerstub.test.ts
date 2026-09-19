import { test } from "node:test";
import assert from "node:assert/strict";
import { handlerStub } from "../handlerstub";

/*
 * The "add a WHEN branch" quick fix: where the branch goes and how it is
 * written. The linter says WHICH event has no handler; this decides the
 * edit, and the edit has to land inside the right CASE, in the class's own
 * style, or the fix is a second finding waiting to happen.
 */

const RAISE = "        )->a( n = `press` v = client->_event( `SAVE` ) ).";

function classWith(dispatcher: string, raise = RAISE): string {
  return `CLASS zcl_x DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.
CLASS zcl_x IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->tag( \`Button\`
${raise}
    client->view_display( view->stringify( ) ).
${dispatcher}
  ENDMETHOD.
ENDCLASS.
`;
}

/** The source after the stub is applied. */
function applied(source: string, name: string, near?: number): string {
  const stub = handlerStub(source, name, near);
  assert.ok(stub, "a stub was expected");
  return source.slice(0, stub.offset) + stub.text + source.slice(stub.offset);
}

test("with WHEN OTHERS the branch goes right before it", () => {
  const source = classWith(`    CASE client->get_event( ).
      WHEN \`OPEN\`.
        popup_open( ).
      WHEN OTHERS.
        client->message_toast_display( \`?\` ).
    ENDCASE.`);
  const out = applied(source, "SAVE");
  assert.ok(
    out.includes(
      "      WHEN `OPEN`.\n" +
        "        popup_open( ).\n" +
        "      WHEN `SAVE`.\n" +
        '        " handle SAVE\n' +
        "      WHEN OTHERS.\n"
    ),
    out
  );
});

test("without WHEN OTHERS the branch goes last, before ENDCASE", () => {
  const source = classWith(`    CASE client->get_event( ).
      WHEN \`OPEN\`.
        popup_open( ).
    ENDCASE.`);
  const out = applied(source, "SAVE");
  assert.ok(
    out.includes(
      "        popup_open( ).\n" +
        "      WHEN `SAVE`.\n" +
        '        " handle SAVE\n' +
        "    ENDCASE."
    ),
    out
  );
});

test("the struct-read spelling of the dispatcher counts too", () => {
  const source = classWith(`    CASE client->get( )-event.
      WHEN \`OPEN\`.
        popup_open( ).
    ENDCASE.`);
  assert.ok(handlerStub(source, "SAVE"));
});

test("lower-case keywords get a lower-case when", () => {
  const source = classWith(`    case client->get_event( ).
      when \`OPEN\`.
        popup_open( ).
      when others.
        popup_close( ).
    endcase.`);
  const out = applied(source, "SAVE");
  assert.ok(out.includes("      when `SAVE`.\n        \" handle SAVE\n      when others.\n"), out);
});

test("an empty CASE gets its first branch, indented under the CASE", () => {
  const source = classWith(`    CASE client->get_event( ).
    ENDCASE.`);
  const out = applied(source, "SAVE");
  assert.ok(
    out.includes("    CASE client->get_event( ).\n      WHEN `SAVE`.\n        \" handle SAVE\n    ENDCASE."),
    out
  );
});

test("the quote follows the neighbouring branches", () => {
  const source = classWith(`    CASE client->get_event( ).
      WHEN 'OPEN'.
        popup_open( ).
    ENDCASE.`);
  const out = applied(source, "SAVE");
  assert.ok(out.includes("      WHEN 'SAVE'.\n"), out);
});

test("without neighbours the quote follows the raise", () => {
  const source = classWith(
    `    CASE client->get_event( ).
    ENDCASE.`,
    "        )->a( n = `press` v = client->_event( 'SAVE' ) )."
  );
  const out = applied(source, "SAVE");
  assert.ok(out.includes("      WHEN 'SAVE'.\n"), out);
});

test("the branch spells the name the way the view raises it", () => {
  // the linter reports the name upper-cased; get_event( ) compares letter
  // for letter, so the branch has to say what the raise says
  const source = classWith(
    `    CASE client->get_event( ).
      WHEN \`OPEN\`.
        popup_open( ).
    ENDCASE.`,
    "        )->a( n = `press` v = client->_event( `save_draft` ) )."
  );
  const stub = handlerStub(source, "SAVE_DRAFT", source.indexOf("client->_event"));
  assert.equal(stub?.name, "save_draft");
  assert.ok(stub?.text.includes("WHEN `save_draft`."));
  assert.ok(stub?.text.includes('" handle save_draft'));
});

test("no CASE over the event: nothing is offered", () => {
  const source = classWith(`    IF client->check_on_event( \`OPEN\` ).
      popup_open( ).
    ENDIF.`);
  assert.equal(handlerStub(source, "SAVE"), undefined);
});

test("a CASE over something else is not the dispatcher", () => {
  const source = classWith(`    CASE mv_status.
      WHEN \`A\`.
        popup_open( ).
      WHEN OTHERS.
    ENDCASE.`);
  assert.equal(handlerStub(source, "SAVE"), undefined);
});

test("a nested CASE's WHEN OTHERS does not steer the placement", () => {
  const source = classWith(`    CASE client->get_event( ).
      WHEN \`OPEN\`.
        CASE mv_status.
          WHEN \`A\`.
            popup_open( ).
          WHEN OTHERS.
            popup_close( ).
        ENDCASE.
    ENDCASE.`);
  const out = applied(source, "SAVE");
  assert.ok(
    out.includes("        ENDCASE.\n      WHEN `SAVE`.\n        \" handle SAVE\n    ENDCASE."),
    out
  );
});

test("a dispatcher inside a comment is not one", () => {
  const source = classWith(`    " CASE client->get_event( ).
    "   WHEN OTHERS.
    " ENDCASE.`);
  assert.equal(handlerStub(source, "SAVE"), undefined);
});

test("a commented-out WHEN OTHERS is not the anchor", () => {
  const source = classWith(`    CASE client->get_event( ).
      WHEN \`OPEN\`.
        popup_open( ).
*     WHEN OTHERS.
    ENDCASE.`);
  const out = applied(source, "SAVE");
  assert.ok(out.includes("*     WHEN OTHERS.\n      WHEN `SAVE`.\n"), out);
});

test("the body indentation follows the first branch's statements", () => {
  const source = classWith(`    CASE client->get_event( ).
      WHEN \`OPEN\`.
          popup_open( ).
    ENDCASE.`);
  const stub = handlerStub(source, "SAVE");
  assert.equal(stub?.text, "      WHEN `SAVE`.\n          \" handle SAVE\n");
});
