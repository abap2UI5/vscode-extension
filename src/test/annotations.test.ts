import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import type { ViewNode } from "@abap2ui5/linter/reconstruct";
import { parseXml } from "@abap2ui5/linter/properties";
import {
  costAnnotations,
  deprecationAnnotations,
  publicAttributes,
  sinceAnnotations,
  xmlNamespaceScopes,
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

test("an undeclared prefix qualifies nothing, not the default namespace", () => {
  // `x:Card` with no xmlns:x used to fall back to sap.m.Card and could be
  // annotated with that unrelated control's version
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.
CLASS zcl_app IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->tag( n = \`Card\` ns = \`x\` ).
  ENDMETHOD.
ENDCLASS.`;
  const prep = prepareAbap(source);
  const asked: string[] = [];
  const found = sinceAnnotations(prep.nodes, { "": "sap.m" }, "1.71", {
    control: (control) => {
      asked.push(control);
      return "1.0";
    },
    member: () => undefined,
  });
  assert.ok(!asked.includes("sap.m.Card"), `asked for: ${asked.join(", ")}`);
  assert.ok(!found.some((a) => a.tooltip?.includes("sap.m.Card")));
});

test("a deprecated control and member are labelled with the metadata's line", () => {
  const prep = prepareAbap(SOURCE);
  const found = deprecationAnnotations(
    prep.nodes,
    { "": "sap.m", mvc: "sap.ui.core.mvc" },
    {
      control: (control) =>
        control === "sap.m.Avatar" ? "Deprecated since 1.120" : undefined,
      member: (control, member) =>
        control === "sap.m.Avatar" && member === "displaySize"
          ? "Deprecated — use avatarSize"
          : undefined,
    }
  );
  assert.equal(found.length, 2);
  assert.ok(found.every((a) => a.text === "deprecated" && a.warn));
  assert.match(found[0].tooltip ?? "", /sap\.m\.Avatar: Deprecated since 1\.120/);
  assert.match(found[1].tooltip ?? "", /displaySize: Deprecated — use avatarSize/);
  assert.ok(SOURCE.slice(found[0].offset, found[0].offset + 40).includes("Avatar"));
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

test("a BEGIN OF block ships as the structure, not as BEGIN and END", () => {
  // three bogus "sent every roundtrip" lines - on BEGIN, the component and
  // END - while the attribute actually serialized had none
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    DATA: BEGIN OF ms_head,
            title TYPE string,
          END OF ms_head.
    DATA mv_x TYPE string.
ENDCLASS.`;
  const names = publicAttributes(source).map((a) => a.name);
  assert.deepEqual(names, ["ms_head", "mv_x"]);
});

test("a static or reference attribute is not labelled as shipped", () => {
  // regression: CLASS-DATA and a REF TO got "sent every roundtrip", though
  // the framework serializes neither - the same rule `_bind( )` completion
  // already follows
  const source = `CLASS zcl_app DEFINITION PUBLIC.
  PUBLIC SECTION.
    CLASS-DATA gv_count TYPE i.
    DATA mo_helper TYPE REF TO zcl_helper.
    DATA: mv_x TYPE string,
          mr_data TYPE REF TO data,
          mt_rows TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
ENDCLASS.`;
  const names = publicAttributes(source).map((a) => a.name);
  assert.deepEqual(names, ["mv_x", "mt_rows"]);
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

// byte formatting is `traffic.ts`'s `formatBytes`, pinned in traffic.test.ts

test("a raw XML view is annotated too, each element in its own namespace scope", () => {
  const xml = [
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">',
    '  <VBox xmlns:f="sap.f">',
    '    <f:Card headerPosition="Top"/>',
    "  </VBox>",
    '  <Panel xmlns="sap.ui.layout.form">',
    "    <SimpleForm/>",
    "  </Panel>",
    "  <f:Card/>",
    "</mvc:View>",
  ].join("\n");
  const root = parseXml(xml) as ViewNode;
  const asked: string[] = [];
  const found = sinceAnnotations(root.children, xmlNamespaceScopes(root), "1.71", {
    control: (control) => {
      asked.push(control);
      return control === "sap.f.Card" ? "1.64" : undefined;
    },
    member: (control, member) =>
      control === "sap.f.Card" && member === "headerPosition" ? "1.65" : undefined,
  });
  // the inner default namespace re-resolves its subtree - and only that
  assert.ok(asked.includes("sap.ui.layout.form.SimpleForm"), asked.join(", "));
  assert.ok(asked.includes("sap.m.VBox") && !asked.includes("sap.ui.layout.form.VBox"));
  // `f:` is declared in the VBox only: the Card outside it resolves to nothing
  assert.equal(asked.filter((c) => c === "sap.f.Card").length, 1);
  // the annotations sit on the element and the attribute that need them
  assert.deepEqual(
    found.map((a) => [xml.slice(a.offset, a.offset + 7), a.text]),
    [
      ["<f:Card", "1.64"],
      ["headerP", "1.65"],
    ]
  );
});
