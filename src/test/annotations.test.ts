import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import {
  costAnnotations,
  formatBytes,
  publicAttributes,
  sinceAnnotations,
  versionAbove,
} from "../annotations";

/*
 * What the editor says about a line unasked: the UI5 version something arrived
 * in, and what a PUBLIC attribute costs per roundtrip.
 */

const SOURCE = `CLASS zcl_app DEFINITION PUBLIC.

  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA mv_title TYPE string.
    DATA: mt_rows TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY,
          mv_flag TYPE abap_bool.

  PROTECTED SECTION.
    DATA client TYPE REF TO z2ui5_if_client.
    DATA hidden TYPE string.

ENDCLASS.

CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->ele( n = \`Page\` )->a( n = \`title\` v = \`Demo\`
        )->ele( n = \`content\`
        )->tag( n = \`Avatar\` )->a( n = \`displaySize\` v = \`S\` ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.`;

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

test("1.71 is older than 1.120, whatever a string comparison thinks", () => {
  // the mistake that would make every three-digit minor look ancient
  assert.equal(versionAbove("1.120", "1.71"), true);
  assert.equal(versionAbove("1.71", "1.120"), false);
  assert.equal(versionAbove("1.71", "1.71"), false);
  assert.equal(versionAbove("1.71.2", "1.71"), true);
});

// ---------------------------------------------------------------------------
// @since next to what is being written
// ---------------------------------------------------------------------------

const LOOKUP = {
  control: (control: string) => (control === "sap.m.Avatar" ? "1.46" : undefined),
  member: (control: string, member: string) =>
    control === "sap.m.Avatar" && member === "displaySize" ? "1.92" : undefined,
};

test("the control and the member each get their own version", () => {
  const prep = prepareAbap(SOURCE);
  const found = sinceAnnotations(
    prep.nodes,
    { "": "sap.m", mvc: "sap.ui.core.mvc" },
    "1.71",
    LOOKUP
  );
  const texts = found.map((a) => a.text);
  assert.deepEqual(texts, ["1.46", "1.92"]);
  // the control is old enough, the member is not
  assert.equal(found[0].warn, false);
  assert.equal(found[1].warn, true);
  assert.match(found[1].tooltip ?? "", /displaySize is available from UI5 1\.92/);
});

test("the annotations sit on the call that writes them", () => {
  const prep = prepareAbap(SOURCE);
  const [control, member] = sinceAnnotations(
    prep.nodes,
    { "": "sap.m", mvc: "sap.ui.core.mvc" },
    "1.71",
    LOOKUP
  );
  assert.ok(SOURCE.slice(control.offset, control.offset + 40).includes("Avatar"));
  assert.ok(SOURCE.slice(member.offset, member.offset + 40).includes("displaySize"));
});

test("what the metadata does not know gets no annotation, not a guess", () => {
  const prep = prepareAbap(SOURCE);
  const found = sinceAnnotations(prep.nodes, { "": "sap.m" }, "1.71", {
    control: () => undefined,
    member: () => undefined,
  });
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// What a roundtrip carries
// ---------------------------------------------------------------------------

test("only the PUBLIC section is what gets shipped", () => {
  const names = publicAttributes(SOURCE).map((a) => a.name);
  assert.deepEqual(names, ["mv_title", "mt_rows", "mv_flag"]);
  // a protected attribute costs nothing per roundtrip and must not be labelled
  assert.ok(!names.includes("client"));
  assert.ok(!names.includes("hidden"));
});

test("the chained DATA: form is read to its last entry", () => {
  // a per-line regex would find mt_rows and silently drop mv_flag
  const attrs = publicAttributes(SOURCE);
  assert.equal(attrs.length, 3);
  assert.ok(SOURCE.slice(attrs[2].offset).startsWith("mv_flag"));
});

test("a measured attribute says its size, an unknown one says it is sent", () => {
  const found = costAnnotations(
    SOURCE,
    { MV_TITLE: "Hello", MT_ROWS: [{ NAME: "Berlin" }, { NAME: "Rome" }] },
    true
  );
  assert.match(found[0].text, /B \/ roundtrip$/);
  assert.match(found[1].text, /roundtrip$/);
  // nothing is known about mv_flag - it still ships, and says so
  assert.equal(found[2].text, "sent every roundtrip");
  assert.match(found[2].tooltip ?? "", /size here is unknown/);
});

test("a model measured in kilobytes is worth a warning", () => {
  const big = { MV_TITLE: "x".repeat(4000) };
  const [annotation] = costAnnotations(SOURCE, big, false);
  assert.equal(annotation.warn, true);
  assert.match(annotation.text, /kB \/ roundtrip/);
  assert.match(annotation.tooltip ?? "", /the class's own seeds/);
});

test("bytes are readable at both ends of the scale", () => {
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(2048), "2.0 kB");
});
