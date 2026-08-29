import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abapBindingContextAt,
  abapContextAt,
  abapNsMap,
  controlCallAt,
  eventNameSpans,
  eventUsagesOf,
  whenBranches,
  whenBranchOf,
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

test("an a( ) after end( ) belongs to the closed container, not the last tag", () => {
  // the builder (and the linter's reconstruction) pops on end( ): what
  // follows is an attribute of the container - reading it lexically offered
  // the tag's members where the gate validates the container's
  const context = abapAt(
    HEAD +
      "    )->ele( n = `VBox`\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `x`\n" +
      "    )->end(\n" +
      "    )->a( n = `wid‸` )"
  );
  assert.equal(context?.kind, "member");
  assert.equal(context?.control, "sap.m.VBox");
});

test("a commented-out xmlns declares nothing", () => {
  const source = HEAD + '    " )->a( n = `xmlns:x` v = `sap.x`\n';
  assert.equal(abapNsMap(source).x, undefined);
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

// ---------------------------------------------------------------------------
// The positional element name - the shape the XML converter emits
// ---------------------------------------------------------------------------

/*
 * `tag( \`Button\` )` is not an exotic spelling: a lone `n =` trips abaplint's
 * omit_parameter_name, so xmltoabap.ts writes the name positionally and the
 * corpus does too. Reading only `n = \`Button\`` meant the extension went
 * silent on the code it generates itself.
 */

test("a member belongs to a control named positionally", () => {
  const context = abapAt(HEAD + "    )->tag( `Button` )->a( n = `te‸` )");
  assert.equal(context?.kind, "member");
  assert.equal(context?.control, "sap.m.Button");
});

test("a value completes for a control named positionally", () => {
  const context = abapAt(
    HEAD + "    )->tag( `Button` )->a( n = `type` v = `Emph‸` )"
  );
  assert.equal(context?.kind, "value");
  assert.equal(context?.control, "sap.m.Button");
  assert.equal(context?.member, "type");
});

test("the positional name itself completes as a control", () => {
  const context = abapAt(HEAD + "    )->tag( `Butt‸` )");
  assert.equal(context?.kind, "control");
  assert.equal(context?.library, "sap.m");
  assert.equal(context?.prefix, "Butt");
});

test("a positional container still supplies the row context", () => {
  // the binding inside it is relative to the aggregation the container binds,
  // and resolving the container is what naming it positionally used to defeat
  const context = bindingAt(
    HEAD +
      "    )->ele( `List`\n" +
      "        )->a( n = `items` v = `{/MT_TAB}`\n" +
      "        )->tag( `Text` )->a( n = `text` v = `{‸}`\n"
  );
  assert.deepEqual(context?.aggregations, ["/MT_TAB"]);
});

test("the outline labels a positional element by its name", () => {
  const { viewOutline } = require("../context") as typeof import("../context");
  const src =
    "DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).\n" +
    "view->ele( `Page`\n" +
    "    )->tag( `Button` )->a( n = `text` v = `Go`\n" +
    ")->end( ).";
  const roots = viewOutline(src);
  assert.equal(roots[0].label, "Page", "not the old '?'");
  assert.equal(roots[0].children[0].label, "Button");
});

test("a single-quoted attribute value is a value position", () => {
  // regression: only `"` was counted, so the cursor here looked like an
  // attribute NAME position and completing would have replaced the value
  const context = xmlAt(`<mvc:View xmlns="sap.m"><Button type='Emph‸'/></mvc:View>`);
  assert.equal(context?.kind, "value");
  assert.equal(context?.control, "sap.m.Button");
  assert.equal(context?.member, "type");
  assert.equal(context?.prefix, "Emph");
});

test("a double quote inside a single-quoted value does not end it", () => {
  const context = xmlAt(
    `<mvc:View xmlns="sap.m"><Button text='say "hi"' type='Emph‸'/></mvc:View>`
  );
  assert.equal(context?.kind, "value");
  assert.equal(context?.member, "type");
});

test("between attributes is still a name position", () => {
  const context = xmlAt(`<mvc:View xmlns="sap.m"><Button text='Go' ty‸/></mvc:View>`);
  assert.equal(context?.kind, "member");
  assert.equal(context?.prefix, "ty");
});

/*
 * Two things a call's argument text is not: raw, and quote-free.
 *
 * Every reader takes the FIRST match inside the parentheses, and in the
 * line-per-argument style a commented-out argument sits inside them too - so
 * a dead `n = ` line decided what control the cursor was on. And ABAP escapes
 * a quote by doubling it, which the literal patterns stopped at.
 */

test("a commented-out argument does not win over the real one", () => {
  const context = abapAt(
    [
      "    view->tag(",
      "       \" n = `Button` was wrong",
      "       n = `Text`",
      "    )->a( n = `text` v = `‸X` ).",
    ].join("\n")
  );
  assert.equal(context?.control, "sap.m.Text");
});

test("a commented-out attribute name does not win either", () => {
  const context = abapAt(
    [
      "    view->tag( n = `Button`",
      "        )->a(",
      "            \" n = `press`",
      "            n = `text` v = `‸X` ).",
    ].join("\n")
  );
  assert.equal(context?.member, "text");
});

test("a doubled quote is part of the literal, not the end of it", () => {
  // the whole written literal is the attribute's span, doubling included -
  // the property editor rewrites exactly this, and a span that stopped at the
  // first half left the tail of the old value behind
  const source =
    "    view->tag( n = `Text` )->a( n = `text` v = `it``s fine` ).";
  const call = controlCallAt(source, source.indexOf("Text` )"));
  const attr = call?.attrs.find((a) => a.name === "text");
  assert.ok(attr, "the attribute was not read at all");
  assert.equal(attr.literal, true);
  assert.equal(attr.value, "it`s fine", "the doubling should be unescaped");
  assert.equal(
    source.slice(attr.valueStart, attr.valueEnd),
    "it``s fine",
    "the span has to cover the literal AS WRITTEN"
  );
});

test("the positional name survives a doubled quote in an earlier argument", () => {
  const context = abapAt(
    [
      "    view->tag( `Text`",
      "        )->a( n = `text` v = `a``b`",
      "        )->a( n = `‸tooltip` v = `x` ).",
    ].join("\n")
  );
  assert.equal(context?.control, "sap.m.Text");
});

test("a commented-out WHEN branch is not where the event is handled", () => {
  /*
   * The FIRST match wins, so a dead branch left above a live one is where
   * Go-to-Definition landed - and F2 rewrote it as if it were code.
   */
  const source = [
    "CASE lv_event.",
    "* WHEN 'SAVE'.",
    "*   old_save( ).",
    "  WHEN 'SAVE'.",
    "    save( ).",
    "ENDCASE.",
  ].join("\n");
  const at = whenBranchOf(source, "SAVE");
  assert.ok(at !== undefined);
  assert.equal(
    source.slice(0, at).split("\n").length,
    4,
    "the dead branch was taken for the live one"
  );
  assert.deepEqual(
    whenBranches(source).map((b) => b.name),
    ["SAVE"]
  );
  assert.equal(eventNameSpans(source, "SAVE").length, 1);
});

test("a commented-out _event wire is not a usage", () => {
  const source = [
    "  view->tag( `Button`",
    '      " )->a( n = `press` v = client->_event( `SAVE` )',
    "      )->a( n = `press` v = client->_event( `SAVE` ) ).",
  ].join("\n");
  assert.equal(eventUsagesOf(source, "SAVE").length, 1);
});

test("a nested VALUE #( ) before val does not hide the raise", () => {
  /*
   * `[^)]*?` stood in for a parenthesis walk and stopped at the `)` of the
   * nested constructor - F2 then renamed the WHEN branch and silently left
   * this end of the wire behind.
   */
  const source =
    "view->a( n = `press` v = client->_event( t_arg = VALUE #( ( lv ) ) val = 'GO' ) ).\n" +
    "WHEN 'GO'.";
  assert.equal(eventUsagesOf(source, "GO").length, 1);
  const spans = eventNameSpans(source, "GO");
  assert.equal(spans.length, 2); // the raise and the WHEN
  for (const span of spans) {
    assert.equal(source.slice(span.start, span.end), "GO");
  }
});

test("a literal that is an argument, not the event name, is no usage", () => {
  const source =
    "view->a( n = `press` v = client->_event( val = 'GO' t_arg = VALUE #( ( `STOP` ) ) ) ).";
  assert.equal(eventUsagesOf(source, "STOP").length, 0);
  assert.equal(eventUsagesOf(source, "GO").length, 1);
});

test("every alternative of WHEN 'A' OR 'B' is a branch of its own", () => {
  const source = [
    "CASE lv_event.",
    "  WHEN 'SAVE' OR 'SAVE_ALL'.",
    "    save( ).",
    "ENDCASE.",
  ].join("\n");
  assert.deepEqual(
    whenBranches(source).map((b) => b.name),
    ["SAVE", "SAVE_ALL"]
  );
  // goto from the raise finds the branch whichever alternative names it
  assert.ok(whenBranchOf(source, "SAVE_ALL") !== undefined);
  // and the cursor on the second alternative is recognised
  const { whenNameAt } = require("../context") as typeof import("../context");
  const at = source.indexOf("SAVE_ALL") + 2;
  assert.equal(whenNameAt(source, at)?.name, "SAVE_ALL");
  // an OR outside a WHEN chain arms nothing
  const cond = "IF lv_a = 'X' OR lv_b = 'Y'.";
  assert.equal(whenNameAt(cond, cond.indexOf("Y") + 1), undefined);
});

test("a > inside a quoted attribute value does not end the XML tag", () => {
  const context = xmlAt(
    '<mvc:View xmlns="sap.m"><Button tooltip="a > b" te‸xt="x"/></mvc:View>'
  );
  assert.equal(context?.kind, "member");
  assert.equal(context?.control, "sap.m.Button");
  assert.equal(context?.prefix, "te");
});
