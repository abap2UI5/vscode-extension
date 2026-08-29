import { test } from "node:test";
import assert from "node:assert/strict";
import { expandAbbreviation, parseAbbreviation } from "../abbreviation";

/*
 * Emmet for builder chains. The grammar is small; what has to be right is the
 * precedence (which decides what the view IS) and the two shapes an expansion
 * can take (which decide whether it compiles).
 */

/** `Page(content(Button+Input))` - a tree as one readable string. */
function shape(nodes: ReturnType<typeof parseAbbreviation>["roots"]): string {
  return nodes
    .map((n) => n.name + (n.children.length ? `(${shape(n.children)})` : ""))
    .join("+");
}

test("`>` binds tighter than `+`, as it does in Emmet", () => {
  // the obvious implementation - split on + first - makes the Input a sibling
  // of the Page. It reads the same and builds a different view.
  assert.equal(
    shape(parseAbbreviation("Page>content>Button+Input").roots),
    "Page(content(Button+Input))"
  );
});

test("a repeated parent gets its own copy of what follows", () => {
  assert.equal(shape(parseAbbreviation("Column*2>Text").roots), "Column(Text)+Column(Text)");
  assert.equal(shape(parseAbbreviation("Button*3").roots), "Button+Button+Button");
});

test("attributes, id and text all reach the chain", () => {
  const [button] = parseAbbreviation("Button#GO[type=Emphasized]{Press}").roots;
  assert.deepEqual(button.attrs, [
    ["id", "GO"],
    ["type", "Emphasized"],
    ["text", "Press"],
  ]);
});

test("a quoted value keeps its spaces, braces and plus signs", () => {
  // an expression binding is exactly the value that would otherwise be read
  // as four attributes with no values
  const [input] = parseAbbreviation(`Input[value="{= \${/A} + \${/B} }" editable=false]`).roots;
  assert.deepEqual(input.attrs, [
    ["value", "{= ${/A} + ${/B} }"],
    ["editable", "false"],
  ]);
});

test("a namespace prefix survives", () => {
  assert.equal(shape(parseAbbreviation("f:Card>f:Header").roots), "f:Card(f:Header)");
});

test("entity-looking text survives the round trip as written", () => {
  // regression: `&` was not escaped on the way INTO the XML, so the
  // emitter's entity decoding silently rewrote what the user typed
  const { abap } = expandAbbreviation("Button{5 &gt; 3}", "", false);
  assert.ok(abap.includes("v = `5 &gt; 3`"), abap);
  const amp = expandAbbreviation('Button[text="Save &amp; close"]', "", false);
  assert.ok(amp.abap.includes("v = `Save &amp; close`"), amp.abap);
});

test("a group repeats as a unit", () => {
  assert.equal(
    shape(parseAbbreviation("Page>(Label+Input)*2").roots),
    "Page(Label+Input+Label+Input)"
  );
  // and a nested group keeps its own children together
  assert.equal(
    shape(parseAbbreviation("VBox>(Panel>Text)*2").roots),
    "VBox(Panel(Text)+Panel(Text))"
  );
});

test("$ numbers the copies, $$ pads, ${…} stays a binding", () => {
  const [b1, b2, b3] = parseAbbreviation("Button#btn$*3").roots;
  assert.deepEqual(
    [b1.attrs[0][1], b2.attrs[0][1], b3.attrs[0][1]],
    ["btn1", "btn2", "btn3"]
  );
  const padded = parseAbbreviation("Item{no $$}*2").roots;
  assert.deepEqual(
    padded.map((i) => i.attrs[0][1]),
    ["no 01", "no 02"]
  );
  // an expression binding's `${…}` is not a counter, even in a repeat
  const inputs = parseAbbreviation(`Input[value="{= \${/A} + $ }"]*2`).roots;
  assert.deepEqual(
    inputs.map((i) => i.attrs[0][1]),
    ["{= ${/A} + 1 }", "{= ${/A} + 2 }"]
  );
  // and without a repeat there is no counter to count
  const [plain] = parseAbbreviation(`Input[value="{= \${/A} }"]`).roots;
  assert.equal(plain.attrs[0][1], "{= ${/A} }");
});

test("a group's counter reaches everything inside it", () => {
  const roots = parseAbbreviation("(Label{row $}+Input#in$)*2").roots;
  assert.deepEqual(
    roots.map((r) => r.attrs[0][1]),
    ["row 1", "in1", "row 2", "in2"]
  );
});

// ---------------------------------------------------------------------------
// The two shapes an expansion takes
// ---------------------------------------------------------------------------

test("outside a chain it scaffolds the whole statement", () => {
  const { abap } = expandAbbreviation("Page>content>Button{Go}", "    ", false);
  assert.ok(abap.includes("DATA(view) = z2ui5_cl_ui5_view_builder=>factory( )."));
  assert.ok(abap.includes("view->ele( `Page`"));
  assert.ok(abap.includes("client->view_display( view->stringify( ) )."));
  assert.ok(abap.includes("n = `text` v = `Go`"));
});

test("inside a chain it continues the one that is there", () => {
  const { abap } = expandAbbreviation("content>Button", "        ", true);
  // hangs off the previous call, and neither opens nor closes the statement
  assert.ok(abap.startsWith("        )->ele( `content`"));
  assert.ok(!abap.includes("factory("));
  assert.ok(!abap.includes("view_display"));
  assert.ok(!abap.trimEnd().endsWith(")."), "the statement continues below");
});

test("siblings at the top of a continuation stay siblings", () => {
  // they need the emitter's own end( ) placement between them, which is the
  // part that is genuinely easy to get wrong by hand
  const { abap } = expandAbbreviation("Button+Input", "        ", true);
  const calls = abap.split("\n").filter((l) => l.includes(")->tag("));
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((l) => (/^[ \t]*/.exec(l)?.[0].length ?? 0)),
    [8, 8]
  );
});

test("a view has one root, and an abbreviation that is not one says so", () => {
  assert.match(
    expandAbbreviation("Page+Page", "", false).error ?? "",
    /a view has one root/
  );
  assert.match(expandAbbreviation("Page>>", "", false).error ?? "", /on both sides/);
  assert.match(expandAbbreviation("Page>Butt on", "", false).error ?? "", /not an abbreviation/);
  assert.match(expandAbbreviation(">Button", "", false).error ?? "", /needs an element/);
  assert.match(expandAbbreviation("   ", "", false).error ?? "", /nothing to expand/);
});

test("a wild repeat count is capped rather than obeyed", () => {
  // a typo is not a reason to write four thousand lines
  assert.equal(parseAbbreviation("Button*4000").roots.length, 50);
});
