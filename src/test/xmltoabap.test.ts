import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import type { ViewNode } from "@abap2ui5/linter/reconstruct";
import { decodeEntities, parseXml, xmlToAbap } from "../xmltoabap";
import { chainFormatEdits } from "../chainformat";

const SAMPLE = `<mvc:View
  xmlns="sap.m"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns:f="sap.f">
  <Page title="Products &amp; Prices">
    <!-- a comment the converter ignores -->
    <Table items="{/PRODUCTS}">
      <columns>
        <Column>
          <Text text="Name"/>
        </Column>
      </columns>
      <items>
        <ColumnListItem>
          <cells>
            <Text text="{NAME}"/>
          </cells>
        </ColumnListItem>
      </items>
    </Table>
    <f:Card/>
  </Page>
</mvc:View>`;

test("parseXml reads elements, attributes and nesting", () => {
  const { roots, warnings } = parseXml(SAMPLE);
  assert.equal(warnings.length, 0);
  assert.equal(roots.length, 1);
  const view = roots[0];
  assert.equal(view.name, "mvc:View");
  assert.equal(view.attrs.length, 3);
  const page = view.children[0];
  assert.equal(page.name, "Page");
  assert.deepEqual(page.attrs, [["title", "Products & Prices"]]);
  const table = page.children[0];
  assert.equal(table.name, "Table");
  assert.equal(table.children.length, 2); // columns, items
  assert.equal(page.children[1].name, "f:Card");
});

test("decodeEntities covers named and numeric entities", () => {
  assert.equal(decodeEntities("a &amp; b &lt;x&gt; &#65;&#x42;"), "a & b <x> AB");
});

/* String.fromCodePoint THROWS above U+10FFFF, so a numeric entity out of
 * range used to take the whole paste-as-ABAP conversion down with a
 * RangeError. It is left as written now, like an unknown named entity. */
test("decodeEntities leaves an out-of-range numeric entity alone", () => {
  assert.equal(decodeEntities("&#x110000;"), "&#x110000;");
  assert.equal(decodeEntities("&#99999999;"), "&#99999999;");
  assert.equal(decodeEntities("&#x10FFFF;"), String.fromCodePoint(0x10ffff));
  assert.equal(decodeEntities("&nosuch;"), "&nosuch;");
});

test("parseXml survives an out-of-range numeric entity in an attribute", () => {
  const { roots } = parseXml(`<Text text="&#x110000;"/>`);
  assert.equal(roots[0].attrs[0][1], "&#x110000;");
});

test("xmlToAbap emits the corpus chain style", () => {
  const { abap, warnings } = xmlToAbap(SAMPLE);
  assert.deepEqual(warnings, []);
  assert.match(abap, /DATA\(view\) = z2ui5_cl_ui5_view_builder=>factory\( \)\./);
  assert.match(abap, /view->ele\( n = `View` ns = `mvc`/);
  // namespace declarations become plain attributes
  assert.match(abap, /\)->a\( n = `xmlns:f` v = `sap\.f`/);
  // decoded entity survives into the literal
  assert.match(abap, /\)->a\( n = `title` v = `Products & Prices`/);
  // an aggregation without a namespace is positional
  assert.match(abap, /\)->ele\( `columns`/);
  // a namespaced control carries its prefix
  assert.match(abap, /\)->tag\( n = `Card` ns = `f` \)\./);
  // the statement ends once, at the deepest point - trailing ends dropped
  assert.match(abap, /client->view_display\( view->stringify\( \) \)\./);
});

test("the emitted chain is a no-op for Format Document", () => {
  const { abap } = xmlToAbap(SAMPLE, "    ");
  assert.deepEqual(chainFormatEdits(abap), []);
});

test("the emitted chain reconstructs back to the same view", () => {
  const { abap } = xmlToAbap(SAMPLE, "    ");
  const source = `CLASS zcl_conv DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.
CLASS zcl_conv IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
${abap}
  ENDMETHOD.
ENDCLASS.`;
  const prep = prepareAbap(source);
  assert.ok(prep.usesBuilder);
  const names: string[] = [];
  const walk = (node: ViewNode): void => {
    if (node.name !== null) {
      names.push(node.ns ? `${node.ns}:${node.name}` : node.name);
    }
    node.children.forEach(walk);
  };
  prep.nodes.forEach(walk);
  assert.deepEqual(names, [
    "mvc:View",
    "Page",
    "Table",
    "columns",
    "Column",
    "Text",
    "items",
    "ColumnListItem",
    "cells",
    "Text",
    "f:Card",
  ]);

  /* The names alone do not prove the round trip: an attribute that was
   * dropped, reordered or mangled on the way through the builder chain looks
   * identical here. `title="Products &amp; Prices"` is the case that matters -
   * it decodes to a literal `&` and has to survive as one. So compare the
   * FULL tree the linter reconstructs against the one parseXml read from the
   * same source. (Verified to hold over 498 real corpus ports before being
   * pinned here; the extension's own CI has no corpus to run that against.) */
  const flatten = (nodes: ViewNode[], out: string[] = []): string[] => {
    for (const n of nodes) {
      if (n.name !== null) {
        const attrs = n.attrs.map(([k, v]) => `${k}=${v}`).sort().join(",");
        out.push(`${n.ns ? `${n.ns}:${n.name}` : n.name}{${attrs}}`);
      }
      flatten(n.children, out);
    }
    return out;
  };
  assert.deepEqual(flatten(prep.nodes), flatten(parseXml(SAMPLE).roots as ViewNode[]),
    "converting XML to a builder chain and reconstructing it must give the same tree, attributes included");
});

test("dropped text and mismatched tags are reported, not swallowed", () => {
  const { warnings } = xmlToAbap("<VBox><Text>hello</Text></VBox>");
  assert.ok(warnings.some((w) => w.includes("hello")));
  const bad = parseXml("<VBox><Text/></HBox>");
  assert.ok(bad.warnings.some((w) => w.includes("does not match")));
});

test("a childless root converts as a single tag", () => {
  const { abap } = xmlToAbap(`<Text text="hi"/>`);
  assert.match(abap, /view->tag\( `Text`/);
  assert.match(abap, /\)->a\( n = `text` v = `hi` \)\./);
});
