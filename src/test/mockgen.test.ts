import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import { MOCK_ROWS, mockJson, mockSkeleton, sampleText } from "../mockgen";

/*
 * "Generate Mock Data for This App": the skeleton is built from the shape
 * the bundled linter derives, so the test runs a real class through
 * `prepareAbap( )` rather than a hand-written shape - a linter update that
 * changes how a table or an undeclared type is marked has to show up here.
 */

const SOURCE = `CLASS zcl_mock DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_stop,
             airport TYPE string,
           END OF ty_s_stop.
    TYPES ty_t_stop TYPE STANDARD TABLE OF ty_s_stop WITH EMPTY KEY.
    TYPES: BEGIN OF ty_s_row,
             id     TYPE string,
             count  TYPE i,
             active TYPE abap_bool,
             price  TYPE p LENGTH 8 DECIMALS 2,
             stops  TYPE ty_t_stop,
           END OF ty_s_row.
    TYPES: BEGIN OF ty_s_addr,
             city TYPE string,
             zip  TYPE string,
           END OF ty_s_addr.
    DATA mt_rows  TYPE STANDARD TABLE OF ty_s_row WITH EMPTY KEY.
    DATA mv_name  TYPE string.
    DATA mv_count TYPE i.
    DATA mv_flag  TYPE abap_bool.
    DATA ms_addr  TYPE ty_s_addr.
    DATA ms_ddic  TYPE sflight.
ENDCLASS.
CLASS zcl_mock IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->ele( \`Page\`
            )->tag( \`Input\`
                )->a( n = \`value\` v = client->_bind( mv_name )
            )->tag( \`Input\`
                )->a( n = \`value\` v = client->_bind( mv_count )
            )->tag( \`CheckBox\`
                )->a( n = \`selected\` v = client->_bind( mv_flag )
            )->tag( \`Text\`
                )->a( n = \`text\` v = client->_bind( ms_addr )
            )->tag( \`Text\`
                )->a( n = \`text\` v = client->_bind( ms_ddic )
            )->ele( \`List\`
                )->a( n = \`items\` v = client->_bind( mt_rows )
                )->tag( \`StandardListItem\`
                    )->a( n = \`title\` v = \`{ID}\` ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.
`;

const shape = () => prepareAbap(SOURCE).modelShape;

test("scalars get a sample of their kind", () => {
  const { data } = mockSkeleton(shape());
  assert.equal(data.MV_NAME, "Name");
  assert.equal(data.MV_COUNT, 0);
  assert.equal(data.MV_FLAG, false);
});

test("a structure is filled field by field", () => {
  const { data } = mockSkeleton(shape());
  assert.deepEqual(data.MS_ADDR, { CITY: "City", ZIP: "Zip" });
});

test("a table gets example rows of its row shape, nested tables included", () => {
  const { data } = mockSkeleton(shape());
  const rows = data.MT_ROWS as Array<Record<string, unknown>>;
  assert.equal(rows.length, MOCK_ROWS);
  assert.deepEqual(rows[0], {
    ID: "Id 1",
    COUNT: 0,
    ACTIVE: false,
    PRICE: 0,
    STOPS: [{ AIRPORT: "Airport 1" }, { AIRPORT: "Airport 2" }],
  });
  assert.equal(rows[1].ID, "Id 2");
});

test("a root the class does not declare is written empty and reported", () => {
  const { data, unknownRoots } = mockSkeleton(shape());
  assert.deepEqual(data.MS_DDIC, {});
  assert.deepEqual(unknownRoots, ["MS_DDIC"]);
});

test("the JSON is what the linter's mock reader parses, with a final newline", () => {
  const text = mockJson(shape());
  assert.ok(text.endsWith("}\n"));
  const parsed = JSON.parse(text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "MS_ADDR",
    "MS_DDIC",
    "MT_ROWS",
    "MV_COUNT",
    "MV_FLAG",
    "MV_NAME",
  ]);
  // the linter's marker never reaches the file
  assert.ok(!text.includes("__unknownShape"));
});

test("a class without bindings yields an empty skeleton, not a throw", () => {
  assert.deepEqual(mockSkeleton(undefined), { data: {}, unknownRoots: [] });
  assert.deepEqual(mockSkeleton([]), { data: {}, unknownRoots: [] });
  assert.equal(mockJson({}), "{}\n");
});

test("a self-referential shape stops at the depth cap instead of hanging", () => {
  const loop: Record<string, unknown> = {};
  loop.SELF = loop;
  const text = mockJson({ LOOP: loop });
  assert.ok(text.length < 10000);
});

test("sample texts read like the field, numbered per row", () => {
  assert.equal(sampleText("MV_TITLE"), "Title");
  assert.equal(sampleText("CITY", 2), "City 2");
  assert.equal(sampleText("MT_ROWS"), "Rows");
  assert.equal(sampleText("FIRST_NAME"), "First name");
  assert.equal(sampleText(""), "Sample");
});
