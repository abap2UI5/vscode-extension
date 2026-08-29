import { test } from "node:test";
import assert from "node:assert/strict";
import { abapNsMap, viewOutline } from "../context";
import { matchOutline } from "../inspect";

/*
 * The fixtures run the real pipeline: outline from the class, ns map from
 * the class, and a runtime chain the hook would send - innermost first.
 */

const SOURCE =
  "DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).\n" +
  "view->ele( n = `View` ns = `mvc`\n" +
  "    )->a( n = `xmlns` v = `sap.m`\n" +
  "    )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`\n" +
  "    )->ele( n = `Page`\n" +
  "    )->tag( n = `Button` )->a( n = `text` v = `In the page` )\n" +
  "    )->ele( n = `List` )->a( n = `items` v = `{/ROWS}`\n" +
  "    )->tag( n = `CustomListItem`\n" +
  "    )->tag( n = `Button` )->a( n = `id` v = `rowButton` )->a( n = `text` v = `In the row` )\n" +
  "    )->end(\n" +
  "    )->end( ).\n";

const outline = () => viewOutline(SOURCE);
const ns = () => abapNsMap(SOURCE);

test("the ancestor chain picks the right one of two same-type controls", () => {
  // Clicked: the Button inside the list row (a clone of the template).
  const node = matchOutline(outline(), ns(), [
    { type: "sap.m.Button", id: "__button42" },
    { type: "sap.m.CustomListItem", id: "__item7" },
    { type: "sap.m.List", id: "__list0" },
    { type: "sap.m.Page", id: "__page0" },
    { type: "sap.ui.core.mvc.XMLView", id: "__xmlview0" },
  ]);
  assert.equal(node?.id, "rowButton");

  // Clicked: the Button directly on the page.
  const pageButton = matchOutline(outline(), ns(), [
    { type: "sap.m.Button", id: "__button41" },
    { type: "sap.m.Page", id: "__page0" },
    { type: "sap.ui.core.mvc.XMLView", id: "__xmlview0" },
  ]);
  assert.equal(pageButton?.id, undefined);
  assert.equal(pageButton?.label, "Button");
});

test("an id written in the class settles the match outright", () => {
  const node = matchOutline(outline(), ns(), [
    { type: "sap.m.Button", id: "__xmlview0--rowButton" },
  ]);
  assert.equal(node?.id, "rowButton");
});

test("runtime-only layers between the controls do not break the match", () => {
  // UI5 often has internal controls in the parent chain the XML never wrote.
  const node = matchOutline(outline(), ns(), [
    { type: "sap.m.Button", id: "__button1" },
    { type: "sap.m.OverflowToolbar", id: "__tb0" }, // not in the view
    { type: "sap.m.CustomListItem", id: "__item0" },
    { type: "sap.m.List", id: "__list0" },
  ]);
  assert.equal(node?.id, "rowButton");
});

test("a generated runtime id is never treated as a written one", () => {
  const node = matchOutline(outline(), ns(), [
    { type: "sap.m.Page", id: "__page0-__clone3" },
  ]);
  assert.equal(node?.label, "Page");
});

test("aggregation elements between the controls do not break the match", () => {
  /*
   * Regression: corpus views write their aggregations out (`content`,
   * `items`, `cells`), and those outline ancestors never appear in the
   * runtime parent chain - the runtime reports controls only. The scorer
   * exhausted its cursor on the first such miss, every candidate scored
   * zero, and the FIRST Button in document order won: Inspect on a row
   * item jumped to the page's button instead of the row template's.
   */
  const source =
    "DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).\n" +
    "view->ele( n = `View` ns = `mvc`\n" +
    "    )->a( n = `xmlns` v = `sap.m`\n" +
    "    )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`\n" +
    "    )->ele( n = `Page`\n" +
    "    )->ele( n = `content`\n" +
    "    )->tag( n = `Button` )->a( n = `text` v = `In the page` )\n" +
    "    )->ele( n = `List` )->a( n = `items` v = `{/ROWS}`\n" +
    "    )->ele( n = `items`\n" +
    "    )->ele( n = `CustomListItem`\n" +
    "    )->ele( n = `content`\n" +
    "    )->tag( n = `Button` )->a( n = `text` v = `In the row` )\n" +
    "    )->end(\n" +
    "    )->end(\n" +
    "    )->end(\n" +
    "    )->end(\n" +
    "    )->end( ).\n";
  const node = matchOutline(viewOutline(source), abapNsMap(source), [
    { type: "sap.m.Button", id: "__button42" },
    { type: "sap.m.CustomListItem", id: "__item7" },
    { type: "sap.m.List", id: "__list0" },
    { type: "sap.m.Page", id: "__page0" },
    { type: "sap.ui.core.mvc.XMLView", id: "__xmlview0" },
  ]);
  assert.ok(node);
  assert.ok(
    node.selStart > source.indexOf("`In the row`") - 80,
    "the row template's Button wins, not the first Button in the document"
  );
});

test("nothing matching returns undefined, not a guess", () => {
  assert.equal(
    matchOutline(outline(), ns(), [{ type: "sap.f.ShellBar", id: "__bar0" }]),
    undefined
  );
  assert.equal(matchOutline(outline(), ns(), []), undefined);
});
