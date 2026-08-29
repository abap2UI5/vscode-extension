import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abapColorSpans,
  formatCssColor,
  parseCssColor,
  xmlColorSpans,
} from "../colors";

test("parseCssColor covers hex, rgb(), hsl() and named colours", () => {
  assert.deepEqual(parseCssColor("#ff0000"), {
    red: 1,
    green: 0,
    blue: 0,
    alpha: 1,
  });
  assert.deepEqual(parseCssColor("#f00"), {
    red: 1,
    green: 0,
    blue: 0,
    alpha: 1,
  });
  assert.equal(parseCssColor("#ff000080")!.alpha.toFixed(2), "0.50");
  assert.deepEqual(parseCssColor("rgb(0, 255, 0)"), {
    red: 0,
    green: 1,
    blue: 0,
    alpha: 1,
  });
  assert.equal(parseCssColor("rgba(0,0,255,0.5)")!.alpha, 0.5);
  const hsl = parseCssColor("hsl(0, 100%, 50%)")!;
  assert.equal(hsl.red, 1);
  assert.equal(hsl.green, 0);
  assert.deepEqual(parseCssColor("red"), {
    red: 1,
    green: 0,
    blue: 0,
    alpha: 1,
  });
  assert.equal(parseCssColor("Highlight"), undefined); // not a CSS colour
});

/* CSS clamps an out-of-range channel instead of rejecting it, so these are
 * real colours a stylesheet may carry. Unclamped they broke both ends: the
 * swatch got a Color outside 0..1, and formatCssColor wrote a negative alpha
 * straight back as `rgba(0,0,0,-1)` - not a colour - the moment the user
 * touched the picker. */
test("parseCssColor clamps out-of-range channels the way CSS does", () => {
  assert.deepEqual(parseCssColor("rgb(300, 0, 0)"), { red: 1, green: 0, blue: 0, alpha: 1 });
  assert.deepEqual(parseCssColor("rgb(110%, 0%, 0%)"), { red: 1, green: 0, blue: 0, alpha: 1 });
  assert.deepEqual(parseCssColor("rgb(-20,0,0)"), { red: 0, green: 0, blue: 0, alpha: 1 });
  assert.deepEqual(parseCssColor("hsl(0, 300%, 50%)"), { red: 1, green: 0, blue: 0, alpha: 1 });
  assert.equal(parseCssColor("rgba(0,0,0,5)")!.alpha, 1);
  assert.equal(parseCssColor("rgba(0,0,0,-1)")!.alpha, 0);
});

test("formatCssColor never emits a channel outside CSS range", () => {
  assert.equal(formatCssColor({ red: 2, green: -1, blue: 0.5, alpha: 1 }), "#ff0080");
  assert.equal(formatCssColor({ red: 0, green: 0, blue: 0, alpha: -1 }), "rgba(0,0,0,0)");
  assert.equal(formatCssColor({ red: 0, green: 0, blue: 0, alpha: 0.5 }), "rgba(0,0,0,0.5)");
  assert.equal(parseCssColor("{/COLOR}"), undefined); // a binding, not a value
  assert.equal(parseCssColor(""), undefined);
});

test("formatCssColor writes hex while opaque, rgba() with alpha", () => {
  assert.equal(
    formatCssColor({ red: 1, green: 0, blue: 0, alpha: 1 }),
    "#ff0000"
  );
  assert.equal(
    formatCssColor({ red: 0, green: 0, blue: 1, alpha: 0.5 }),
    "rgba(0,0,255,0.5)"
  );
});

const ABAP = `
  DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
  view->ele( n = \`View\` ns = \`mvc\`
      )->a( n = \`xmlns\` v = \`sap.m\`
      )->tag( \`ObjectStatus\`
          )->a( n = \`text\` v = \`red\`
          )->a( n = \`iconColor\` v = \`#1873b4\`
      )->tag( \`Text\`
          )->a( n = \`text\` v = \`#123456\` ).
`;

test("abapColorSpans finds colour-typed values, not colour-looking text", () => {
  const spans = abapColorSpans(ABAP, (control, member) => {
    assert.match(control, /^sap\./);
    return member === "iconColor";
  });
  assert.equal(spans.length, 1);
  const value = ABAP.slice(spans[0].start, spans[0].end);
  assert.equal(value, "#1873b4");
  // `text = red` and the hex in a non-colour member never become swatches
});

test("a commented-out control does not become the owner", () => {
  // the dead line used to shift ownership: the attribute was judged against
  // sap.m.Button, and the swatch on Avatar's real colour property vanished
  const source = [
    "view->ele( n = `View` )->a( n = `xmlns` v = `sap.m`",
    "    )->tag( n = `Avatar`",
    "    \" )->tag( n = `Button` )",
    "    )->a( n = `backgroundColor` v = `#123456` ).",
  ].join("\n");
  const asked: string[] = [];
  const spans = abapColorSpans(source, (control) => {
    asked.push(control);
    return control === "sap.m.Avatar";
  });
  assert.ok(!asked.includes("sap.m.Button"), `asked for: ${asked.join(", ")}`);
  assert.equal(spans.length, 1);
  assert.equal(source.slice(spans[0].start, spans[0].end), "#123456");
});

const XML = `<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc">
  <ObjectStatus text="ok" iconColor="rgb(24, 115, 180)"/>
  <Text text="#abcdef"/>
</mvc:View>`;

test("xmlColorSpans resolves the tag's control and filters by member", () => {
  const spans = xmlColorSpans(XML, (control, member) => {
    return control === "sap.m.ObjectStatus" && member === "iconColor";
  });
  assert.equal(spans.length, 1);
  assert.equal(XML.slice(spans[0].start, spans[0].end), "rgb(24, 115, 180)");
});
