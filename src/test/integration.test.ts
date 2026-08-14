import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import { prettyDocument } from "../xmlformat";
import { absoluteOffers, relativeOffers, rowShapeFor } from "../bindingpaths";
import { abapBindingContextAt } from "../context";

const SOURCE = `CLASS zcl_demo DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_travel,
             id TYPE string,
             status TYPE string,
           END OF ty_s_travel.
    DATA mt_travels TYPE STANDARD TABLE OF ty_s_travel WITH EMPTY KEY.
    DATA mv_title TYPE string VALUE \`Hello\`.
ENDCLASS.
CLASS zcl_demo IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->ele( n = \`Page\` )->a( n = \`title\` v = client->_bind( mv_title )
        )->ele( n = \`List\` )->a( n = \`items\` v = client->_bind( mt_travels )
        )->tag( n = \`StandardListItem\` )->a( n = \`title\` v = \`{STATUS}\` ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;

/* Deliberately runs against the REAL bundled linter, like metadata.test.ts
 * does: a linter update that changes the shape of prepareAbap( ) output
 * must fail here, not silently empty the XML preview and the offers. */
test("reconstruction, formatting and binding offers line up end to end", () => {
  const prep = prepareAbap(SOURCE);
  assert.equal(prep.usesBuilder, true);
  assert.equal(prep.nodes.length, 1);
  const xml = prettyDocument(prep.nodes, "ZCL_DEMO");
  assert.ok(xml.includes("<mvc:View"));
  assert.ok(xml.includes("StandardListItem"));

  const abs = absoluteOffers(prep.modelShape);
  assert.ok(abs.some((o) => o.path === "/MT_TRAVELS" && o.table));
  assert.ok(abs.some((o) => o.path === "/MV_TITLE"));

  const cursor = SOURCE.indexOf("`{STATUS}`") + 2;
  const ctx = abapBindingContextAt(SOURCE, cursor, (_c, member) => member === "items");
  assert.ok(ctx);
  const row = rowShapeFor(prep.modelShape, ctx!.aggregations);
  const rel = relativeOffers(row);
  assert.ok(rel.some((o) => o.path === "STATUS"));
});
