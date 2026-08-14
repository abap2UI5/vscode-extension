import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abapBindingContextAt,
  abapContextAt,
  abapNsMap,
  xmlContextAt,
  xmlNsMap,
} from "../context";

/** The cursor is marked with `‸` in the fixtures - easier to read than an
 *  offset, and it keeps the fixture and the position from drifting apart. */
function at(marked: string) {
  const offset = marked.indexOf("‸");
  assert.notEqual(offset, -1, "the fixture needs a ‸ for the cursor");
  return { source: marked.replace("‸", ""), offset };
}

function abapAt(marked: string) {
  const { source, offset } = at(marked);
  return abapContextAt(source, offset);
}

function xmlAt(marked: string) {
  const { source, offset } = at(marked);
  return xmlContextAt(source, offset);
}

const HEAD =
  "DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).\n" +
  "view->ele( n = `View` ns = `mvc`\n" +
  "    )->a( n = `xmlns` v = `sap.m`\n" +
  "    )->a( n = `xmlns:f` v = `sap.f`\n";

test("the xmlns declarations are read out of the builder calls", () => {
  assert.deepEqual(abapNsMap(HEAD), { "": "sap.m", f: "sap.f" });
  // The attribute-list spelling says the same thing.
  assert.deepEqual(abapNsMap("a = VALUE #( ( `xmlns:l=sap.ui.layout` ) )"), {
    l: "sap.ui.layout",
  });
});

test("a control name completes against the default namespace", () => {
  const context = abapAt(HEAD + "    )->tag( n = `Butt‸` )");
  assert.equal(context?.kind, "control");
  assert.equal(context?.library, "sap.m");
  assert.equal(context?.prefix, "Butt");
});

test("the ns argument decides the library", () => {
  const context = abapAt(HEAD + "    )->tag( n = `Ca‸` ns = `f` )");
  assert.equal(context?.kind, "control");
  assert.equal(context?.library, "sap.f");
});

test("a prefix baked into the name wins, and only the local part is replaced", () => {
  const { source, offset } = at(HEAD + "    )->tag( n = `f:Ca‸` )");
  const context = abapContextAt(source, offset);
  assert.equal(context?.library, "sap.f");
  assert.equal(context?.prefix, "Ca");
  assert.equal(source.slice(context!.start, context!.end), "Ca");
});

test("a member belongs to the control the a( ) is chained to", () => {
  const context = abapAt(HEAD + "    )->tag( n = `Button` )->a( n = `te‸` )");
  assert.equal(context?.kind, "member");
  assert.equal(context?.control, "sap.m.Button");
});

test("a second a( ) still belongs to the same control", () => {
  const context = abapAt(
    HEAD + "    )->tag( n = `Button` )->a( n = `text` v = `Hi` )->a( n = `ty‸` )"
  );
  assert.equal(context?.kind, "member");
  assert.equal(context?.control, "sap.m.Button");
});

test("a value knows both the control and the member it belongs to", () => {
  const context = abapAt(HEAD + "    )->tag( n = `Button` )->a( n = `type` v = `Emph‸` )");
  assert.equal(context?.kind, "value");
  assert.equal(context?.control, "sap.m.Button");
  assert.equal(context?.member, "type");
});

test("a control inside a comment is never the owner", () => {
  const context = abapAt(
    HEAD +
      "    )->tag( n = `Button` )\n" +
      '    " )->tag( n = `Table` ) - the old version\n' +
      "    view->a( n = `te‸` )"
  );
  assert.equal(context?.control, "sap.m.Button");
});

test("a builder call quoted inside a string is not a call", () => {
  const context = abapAt(
    HEAD +
      "    )->tag( n = `Button` )\n" +
      "    DATA(note) = `->tag( n = ~Table~ )`.\n".replace(/~/g, "'") +
      "    view->a( n = `te‸` )"
  );
  assert.equal(context?.control, "sap.m.Button");
});

test("a quotation mark inside a string template does not start a comment", () => {
  // Without template handling the `"` swallows the rest of the line, the
  // call never closes, and every context after it is wrong.
  const context = abapAt(
    HEAD +
      "    )->tag( n = `Text` )->a( n = `text` v = |He said \"hi\"| )\n" +
      "    )->tag( n = `Button` )->a( n = `te‸` )"
  );
  assert.equal(context?.kind, "member");
  assert.equal(context?.control, "sap.m.Button");
});

test("the ns argument itself completes to the declared prefixes", () => {
  const context = abapAt(HEAD + "    )->tag( n = `Card` ns = `‸` )");
  assert.equal(context?.kind, "namespace");
});

test("outside a literal there is nothing to offer", () => {
  assert.equal(abapAt(HEAD + "    )->tag( n = `Button` )‸ "), undefined);
  assert.equal(abapAt("DATA(x) = ‸1."), undefined);
});

test("raw XML: the tag name, an attribute and a value", () => {
  const head = '<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc" xmlns:f="sap.f">\n';
  const tag = xmlAt(head + "  <Butt‸");
  assert.equal(tag?.kind, "control");
  assert.equal(tag?.library, "sap.m");

  const prefixed = xmlAt(head + "  <f:Ca‸");
  assert.equal(prefixed?.library, "sap.f");

  const attribute = xmlAt(head + '  <Button te‸');
  assert.equal(attribute?.kind, "member");
  assert.equal(attribute?.control, "sap.m.Button");

  const value = xmlAt(head + '  <Button type="Emph‸"');
  assert.equal(value?.kind, "value");
  assert.equal(value?.control, "sap.m.Button");
  assert.equal(value?.member, "type");
});

test("raw XML: between two tags there is nothing to offer", () => {
  assert.deepEqual(xmlNsMap('<mvc:View xmlns="sap.m">'), { "": "sap.m" });
  assert.equal(xmlAt('<mvc:View xmlns="sap.m">\n  ‸\n</mvc:View>'), undefined);
});

// ---------------------------------------------------------------------------
// Binding paths
// ---------------------------------------------------------------------------

/** `items` is the only aggregation - enough resolution for these fixtures. */
const isAggregation = (_control: string, member: string) => member === "items";

function bindingAt(marked: string) {
  const { source, offset } = at(marked);
  return abapBindingContextAt(source, offset, isAggregation);
}

test("a { in a value literal is a binding being written", () => {
  const context = bindingAt(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NA‸` )"
  );
  assert.equal(context?.prefix, "/NA");
  assert.deepEqual(context?.aggregations, []);
});

test("the replace span covers the whole path written so far", () => {
  const { source, offset } = at(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NA‸ME}` )"
  );
  const context = abapBindingContextAt(source, offset, isAggregation);
  assert.equal(source.slice(context!.start, context!.end), "/NAME");
});

test("inside an aggregation template the bound path is known", () => {
  const context = bindingAt(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = `{/TRAVELS}`\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{‸` )"
  );
  assert.deepEqual(context?.aggregations, ["/TRAVELS"]);
});

test("nested aggregations stack, outermost first", () => {
  const context = bindingAt(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = `{/TRAVELS}`\n" +
      "    )->ele( n = `List` )->a( n = `items` v = `{STOPS}`\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{‸` )"
  );
  assert.deepEqual(context?.aggregations, ["/TRAVELS", "STOPS"]);
});

test("an end( ) closes its container's row context", () => {
  const context = bindingAt(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = `{/TRAVELS}`\n" +
      "    )->end(\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{‸` )"
  );
  assert.deepEqual(context?.aggregations, []);
});

test("a container's own attributes are outside its row context", () => {
  const context = bindingAt(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = `{/TRAVELS}`" +
      " )->a( n = `headerText` v = `{‸` )"
  );
  assert.deepEqual(context?.aggregations, []);
});

test("the complex aggregation binding syntax still names its path", () => {
  const context = bindingAt(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = `{path: '/TRAVELS', templateShareable: false}`\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{‸` )"
  );
  assert.deepEqual(context?.aggregations, ["/TRAVELS"]);
});

test("named models, expressions and complex syntax are not completed", () => {
  const base = HEAD + "    )->tag( n = `Text` )->a( n = `text` v = ";
  assert.equal(bindingAt(base + "`{device>/NA‸` )"), undefined);
  assert.equal(bindingAt(base + "`{= ${/A} + ‸` )"), undefined);
  assert.equal(bindingAt(base + "`{path: '/NA‸'}` )"), undefined);
});

test("behind the closing brace the binding is over", () => {
  assert.equal(
    bindingAt(HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NAME} ‸` )"),
    undefined
  );
});

test("a { in the n argument is not a binding", () => {
  assert.equal(
    bindingAt(HEAD + "    )->tag( n = `Text` )->a( n = `{‸` )"),
    undefined
  );
});

test("an aggregation bound via client->_bind( ) still names its path", () => {
  const context = bindingAt(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = client->_bind( mt_travels )\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{‸` )"
  );
  assert.deepEqual(context?.aggregations, ["/MT_TRAVELS"]);
});

test("a structure component bound via _bind flattens like the framework does", () => {
  const context = bindingAt(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = client->_bind( val = ms_data-rows )\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{‸` )"
  );
  assert.deepEqual(context?.aggregations, ["/MS_DATA/ROWS"]);
});

// ---------------------------------------------------------------------------
// Outline and events
// ---------------------------------------------------------------------------

test("the outline nests the way the builder does", () => {
  const { viewOutline } = require("../context") as typeof import("../context");
  const src =
    HEAD +
    "    )->ele( n = `Page` )->a( n = `id` v = `main` )\n" +
    "    )->tag( n = `Text` )->a( n = `text` v = `Hi` )\n" +
    "    )->end(\n" +
    "    )->tag( n = `Button` ns = `m` ).\n";
  const roots = viewOutline(src);
  assert.equal(roots.length, 1);
  const view = roots[0];
  assert.equal(view.label, "mvc:View");
  assert.equal(view.container, true);
  assert.equal(view.children.length, 2); // Page, then the Button after end
  const page = view.children[0];
  assert.equal(page.label, "Page");
  assert.equal(page.id, "main");
  assert.deepEqual(page.children.map((c: { label: string }) => c.label), ["Text"]);
  assert.equal(view.children[1].label, "m:Button");
  // a parent spans its children
  assert.ok(page.end >= page.children[0].end);
  assert.ok(view.end >= page.end);
});

test("a second factory( ) starts a second root", () => {
  const { viewOutline } = require("../context") as typeof import("../context");
  const src = HEAD + "    )->tag( n = `Text` ).\n" + HEAD + "    )->tag( n = `Input` ).\n";
  const roots = viewOutline(src);
  assert.equal(roots.length, 2);
});

test("event navigation finds the WHEN branch and the way back", () => {
  const {
    eventNameAt,
    eventUsagesOf,
    whenBranchOf,
    whenNameAt,
  } = require("../context") as typeof import("../context");
  const src =
    HEAD +
    "    )->tag( n = `Button` )->a( n = `press` v = client->_event( `GO` ) ).\n" +
    "    CASE client->get( )-event.\n" +
    "      WHEN `GO`.\n" +
    "        do_something( ).\n" +
    "    ENDCASE.\n";
  const inEvent = src.indexOf("`GO`") + 2;
  const ev = eventNameAt(src, inEvent);
  assert.equal(ev?.name, "GO");
  const target = whenBranchOf(src, "GO");
  assert.ok(target !== undefined && target > src.indexOf("CASE"));
  const inWhen = src.indexOf("WHEN `GO`") + 7;
  const back = whenNameAt(src, inWhen);
  assert.equal(back?.name, "GO");
  assert.equal(eventUsagesOf(src, "GO").length, 1);
});

test("a literal outside an _event call is not an event", () => {
  const { eventNameAt } = require("../context") as typeof import("../context");
  const src = HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `GO` ).";
  assert.equal(eventNameAt(src, src.lastIndexOf("`GO`") + 2), undefined);
});

test("whenBranches and eventNameSpans see every naming of an event", () => {
  const {
    eventNameSpans,
    whenBranches,
  } = require("../context") as typeof import("../context");
  const src =
    HEAD +
    "    )->tag( n = `Button` )->a( n = `press` v = client->_event( `GO` ) ).\n" +
    "    )->tag( n = `Button` )->a( n = `press` v = client->_event( val = `GO` ) ).\n" +
    "    CASE client->get( )-event.\n" +
    "      WHEN `GO`.\n" +
    "      WHEN `STOP`.\n" +
    "    ENDCASE.\n";
  assert.deepEqual(
    whenBranches(src).map((b: { name: string }) => b.name),
    ["GO", "STOP"]
  );
  const spans = eventNameSpans(src, "GO");
  assert.equal(spans.length, 3); // two raises, one WHEN
  for (const span of spans) {
    assert.equal(src.slice(span.start, span.end), "GO");
  }
});
