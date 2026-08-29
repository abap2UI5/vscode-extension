import { test } from "node:test";
import assert from "node:assert/strict";
import type { ViewNode } from "@abap2ui5/linter/reconstruct";
import { formatDocument, lineForOffset, prettyDocument, prettyXml } from "../xmlformat";

const node = (
  name: string | null,
  attrs: Array<[string, string]> = [],
  children: ViewNode[] = [],
  ns: string | null = null
): ViewNode => ({ name, ns, attrs, children });

test("nesting becomes indentation", () => {
  const view = node("View", [["xmlns", "sap.m"]], [
    node("Page", [["title", "Hello"]], [node("Text", [["text", "Hi"]])]),
  ]);
  assert.equal(
    prettyXml(view),
    [
      `<View xmlns="sap.m">`,
      `  <Page title="Hello">`,
      `    <Text text="Hi"/>`,
      `  </Page>`,
      `</View>`,
    ].join("\n")
  );
});

test("the synthetic root wrapper is invisible", () => {
  const wrapped = node(null, [], [node("Text", [["text", "Hi"]])]);
  assert.equal(prettyXml(wrapped), `<Text text="Hi"/>`);
});

test("many attributes wrap to one per line, xmlns first", () => {
  const view = node("View", [
    ["controllerName", "a.long.controller.name.that.pushes.past.the.limit"],
    ["xmlns:mvc", "sap.ui.core.mvc"],
    ["displayBlock", "true"],
  ]);
  const lines = prettyXml(view).split("\n");
  assert.equal(lines[0], "<View");
  assert.ok(lines[1].trim().startsWith("xmlns:mvc="), "namespaces first");
  assert.ok(lines[lines.length - 1].trim().endsWith("/>"));
});

test("attribute values are escaped", () => {
  const view = node("Text", [["text", `a < b & "c"`]]);
  assert.equal(prettyXml(view), `<Text text="a &lt; b &amp; &quot;c&quot;"/>`);
});

test("a namespaced control keeps its prefix", () => {
  const view = node("Card", [], [], "f");
  assert.equal(prettyXml(view), `<f:Card/>`);
});

test("two views are labelled, one is not", () => {
  const one = prettyDocument([node("Text")], "ZCL_ONE");
  assert.ok(one.includes("ZCL_ONE"));
  assert.ok(!one.includes("view 1 of"));
  const two = prettyDocument([node("Text"), node("Text")], "ZCL_TWO");
  assert.ok(two.includes("view 1 of 2"));
  assert.ok(two.includes("view 2 of 2"));
});

test("formatDocument carries the builder-call offsets line by line", () => {
  const view: ViewNode = {
    name: "View",
    ns: null,
    attrs: [["xmlns", "sap.m", 10]],
    children: [
      { name: "Text", ns: null, attrs: [["text", "Hi", 40]], children: [], offset: 30 },
    ],
    offset: 5,
  };
  const { text, lineOffsets } = formatDocument([view], "ZCL_X");
  const lines = text.split("\n");
  assert.equal(lines.length, lineOffsets.length);
  const viewLine = lines.findIndex((l) => l.includes("<View"));
  const textLine = lines.findIndex((l) => l.includes("<Text"));
  assert.equal(lineOffsets[viewLine], 5);
  assert.equal(lineOffsets[textLine], 30);
  assert.equal(lineOffsets[0], undefined); // the header comment maps nowhere
});

test("lineForOffset lands on the element's OPENING line", () => {
  /*
   * An element's opening and closing line both carry the element's offset. A
   * finding recorded a few characters into the call's argument list has no
   * exact line, and the tie used to go to the LATEST line - for the root
   * element that was `</mvc:View>` at the bottom of the document.
   */
  const page: ViewNode = {
    name: "Page",
    ns: null,
    attrs: [["title", "T", 110]],
    children: [{ name: "Text", ns: null, attrs: [], children: [], offset: 200 }],
    offset: 100,
  };
  const { text, lineOffsets } = formatDocument([page], "ZCL_X");
  const lines = text.split("\n");
  const opening = lines.findIndex((l) => l.includes("<Page"));
  const closing = lines.findIndex((l) => l.includes("</Page>"));
  assert.ok(closing > opening);
  assert.equal(lineForOffset(lineOffsets, 100), opening, "exact hit");
  assert.equal(lineForOffset(lineOffsets, 105), opening, "inside the argument list");
  assert.equal(lineForOffset(lineOffsets, 205), lines.findIndex((l) => l.includes("<Text")));
  assert.equal(lineForOffset(lineOffsets, 50), undefined, "before every call");
});

test("wrapped attributes carry their own offsets", () => {
  const view: ViewNode = {
    name: "View",
    ns: null,
    attrs: [
      ["controllerName", "a.long.controller.name.that.pushes.past.the.limit", 11],
      ["displayBlock", "true", 22],
    ],
    children: [],
    offset: 3,
  };
  const { text, lineOffsets } = formatDocument([view], "ZCL_X");
  const lines = text.split("\n");
  const attrLine = lines.findIndex((l) => l.trim().startsWith("displayBlock"));
  assert.equal(lineOffsets[attrLine], 22);
});
