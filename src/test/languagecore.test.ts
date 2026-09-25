import { test } from "node:test";
import assert from "node:assert/strict";
import { completionAt, hoverAt, isColorMember, isXmlView } from "../languagecore";
import { snapshot } from "../snapshot";

/*
 * The completion/hover core, against the real bundled snapshot - like
 * `metadata.test.ts`, on purpose: what the entries say comes straight from
 * the shipped metadata, and a regenerated snapshot that broke the shape
 * must fail here, not in a mocked mirror of it.
 */

const data = snapshot();

/** The cursor is marked with `‸` in the fixtures - easier to read than an
 *  offset, and it keeps the fixture and the position from drifting apart. */
function at(marked: string) {
  const offset = marked.indexOf("‸");
  assert.notEqual(offset, -1, "the fixture needs a ‸ for the cursor");
  return { source: marked.replace("‸", ""), offset };
}

const HEAD =
  "DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).\n" +
  "view->ele( n = `View` ns = `mvc`\n" +
  "    )->a( n = `xmlns` v = `sap.m`\n" +
  "    )->a( n = `xmlns:f` v = `sap.f`\n";

/** A derived model shape the way `prepareAbap( )` builds one. */
const SHAPE = {
  NAME: "",
  TRAVELS: [{ STATUS: "", STOPS: [{ AIRPORT: "" }] }],
};

const noShape = () => undefined;

/** `shape: null` stands for "no derived shape" - `undefined` would fall
 *  back to the default parameter. */
function completeAbap(marked: string, shape: unknown = SHAPE) {
  const { source, offset } = at(marked);
  return completionAt(source, "zcl_app.clas.abap", offset, data, () => shape);
}

function hoverAbap(marked: string, shape: unknown = SHAPE) {
  const { source, offset } = at(marked);
  return hoverAt(source, "zcl_app.clas.abap", offset, data, () => shape);
}

// ---------------------------------------------------------------------------
// Document classification
// ---------------------------------------------------------------------------

test("a *.view.xml is XML whatever it contains, ABAP is not", () => {
  assert.equal(isXmlView("main.view.xml", "anything"), true);
  assert.equal(isXmlView("frag.fragment.xml", ""), true);
  assert.equal(isXmlView("zcl_app.clas.abap", "CLASS zcl_app..."), false);
  // content wins for unnamed buffers that clearly hold markup
  assert.equal(isXmlView("untitled-1", "  <mvc:View>"), true);
});

// ---------------------------------------------------------------------------
// Completion: controls, members, values, namespaces
// ---------------------------------------------------------------------------

test("a control prefix offers the library's controls with docs", () => {
  const offer = completeAbap(HEAD + "    )->tag( n = `Butt‸` )");
  assert.ok(offer);
  const button = offer.entries.find((e) => e.label === "Button");
  assert.ok(button, "sap.m.Button is offered");
  assert.equal(button.kind, "control");
  assert.equal(button.detail, "sap.m");
  assert.ok(button.documentation?.includes("sap.m.Button"));
  // the span replaces exactly what was typed
  const { source } = at(HEAD + "    )->tag( n = `Butt‸` )");
  assert.equal(source.slice(offer.start, offer.end), "Butt");
});

test("a deprecated control is marked, a current one is not", () => {
  const offer = completeAbap(HEAD + "    )->tag( n = `‸` )");
  assert.ok(offer);
  const deprecated = offer.entries.filter((e) => e.deprecated);
  assert.ok(deprecated.length > 0, "sap.m ships deprecated controls");
  const button = offer.entries.find((e) => e.label === "Button");
  assert.equal(button?.deprecated, false);
  // struck through AND sorted behind the living API
  for (const entry of deprecated) {
    assert.ok(
      entry.sortText! > button!.sortText!,
      `${entry.label} should sort after Button`
    );
  }
});

test("a deprecated member is marked and sorts after its current siblings", () => {
  const offer = completeAbap(HEAD + "    )->tag( n = `Button` )->a( n = `‸` )");
  assert.ok(offer);
  // sap.m.Button's own events: `tap` is deprecated, `press` is not
  const tap = offer.entries.find((e) => e.label === "tap");
  const press = offer.entries.find((e) => e.label === "press");
  assert.equal(tap?.deprecated, true);
  assert.equal(press?.deprecated, false);
  assert.ok(
    press!.sortText! < tap!.sortText!,
    "the deprecated event sorts after the current one"
  );
});

test("members come with section kinds and properties-first sort", () => {
  const offer = completeAbap(HEAD + "    )->tag( n = `Button` )->a( n = `‸` )");
  assert.ok(offer);
  const text = offer.entries.find((e) => e.label === "text");
  const press = offer.entries.find((e) => e.label === "press");
  assert.equal(text?.kind, "properties");
  assert.equal(press?.kind, "events");
  assert.ok(text!.sortText! < press!.sortText!, "properties sort before events");
  // own members before inherited ones (busy comes from the Control base)
  const busy = offer.entries.find((e) => e.label === "busy");
  assert.ok(busy, "inherited members are offered too");
  assert.ok(text!.sortText! < busy!.sortText!);
  assert.ok(text!.documentation?.includes("string"));
});

test("an enum member offers its values", () => {
  const offer = completeAbap(
    HEAD + "    )->tag( n = `Button` )->a( n = `type` v = `Emph‸` )"
  );
  assert.ok(offer);
  const labels = offer.entries.map((e) => e.label);
  assert.ok(labels.includes("Emphasized"));
  assert.ok(offer.entries.every((e) => e.kind === "value"));
  // each value says which enum it belongs to
  assert.ok(offer.entries.every((e) => e.detail === "sap.m.ButtonType"));
  // and the sort keeps the declaration order - `Default` first, not an
  // alphabetical shuffle that would bury it under `Accept`
  assert.equal(offer.entries[0]?.label, "Default");
  const sorted = [...offer.entries].sort((a, b) =>
    a.sortText! < b.sortText! ? -1 : 1
  );
  assert.deepEqual(sorted.map((e) => e.label), labels);
});

test("the ns argument completes to the declared prefixes", () => {
  const offer = completeAbap(HEAD + "    )->tag( n = `Card` ns = `‸` )");
  assert.ok(offer);
  const f = offer.entries.find((e) => e.label === "f");
  assert.ok(f, "the declared f prefix is offered");
  assert.equal(f.detail, "sap.f");
  assert.equal(f.kind, "namespace");
  // the empty prefix (xmlns=) is not a prefix to type
  assert.ok(!offer.entries.some((e) => e.label === ""));
});

test("outside anything completable there is no offer", () => {
  assert.equal(completeAbap(HEAD + "    )->tag( n = `Button` )‸ "), undefined);
});

test("inside a WHEN literal the raised events are offered, with counts", () => {
  const offer = completeAbap(
    HEAD +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_event( `GO` ) ).\n" +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_event( `GO` ) ).\n" +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_event( val = `STOP` ) ).\n" +
      "CASE client->get( )-event.\n" +
      "  WHEN `‸`.\n" +
      "ENDCASE.\n"
  );
  assert.ok(offer, "the WHEN literal is a completable position");
  assert.deepEqual(
    offer.entries.map((e) => e.label),
    ["GO", "STOP"]
  );
  assert.ok(offer.entries.every((e) => e.kind === "events"));
  // the detail carries how often the view raises each - the same number the
  // CodeLens shows on the branch
  assert.deepEqual(
    offer.entries.map((e) => e.detail),
    ["raised 2× in the view", "raised 1× in the view"]
  );
});

test("the xmlns value completes to the snapshot's libraries", () => {
  const head =
    "DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).\n" +
    "view->ele( n = `View` ns = `mvc`\n" +
    "    )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc`\n";
  const offer = completeAbap(head + "    )->a( n = `xmlns` v = `‸`\n");
  assert.ok(offer);
  const labels = offer.entries.map((e) => e.label);
  assert.ok(labels.includes("sap.m"));
  assert.ok(labels.includes("sap.f"));
  assert.ok(labels.includes("sap.ui.layout"));
  assert.ok(offer.entries.every((e) => e.kind === "namespace"));
  // the prefixed declaration completes the same way
  const prefixed = completeAbap(head + "    )->a( n = `xmlns:f` v = `sap.‸`\n");
  assert.ok(prefixed?.entries.some((e) => e.label === "sap.f"));
});

test("the default aggregation is marked in the member list", () => {
  const offer = completeAbap(HEAD + "    )->ele( n = `Page` )->a( n = `‸` )");
  assert.ok(offer);
  const content = offer.entries.find((e) => e.label === "content");
  assert.ok(content, "sap.m.Page offers its content aggregation");
  assert.match(content!.detail ?? "", /default aggregation/);
  const title = offer.entries.find((e) => e.label === "title");
  assert.ok(!/default aggregation/.test(title?.detail ?? ""));
});

// ---------------------------------------------------------------------------
// Completion: binding paths from the derived model
// ---------------------------------------------------------------------------

test("a { in a value literal offers the model's absolute paths", () => {
  const offer = completeAbap(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NA‸` )"
  );
  assert.ok(offer);
  const byLabel = new Map(offer.entries.map((e) => [e.label, e]));
  assert.ok(byLabel.has("/NAME"));
  assert.equal(byLabel.get("/TRAVELS")?.kind, "binding-table");
  assert.equal(byLabel.get("/NAME")?.kind, "binding-path");
});

test("inside an aggregation template the row's fields come first", () => {
  const offer = completeAbap(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = `{/TRAVELS}`\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{‸` )"
  );
  assert.ok(offer);
  const status = offer.entries.find((e) => e.label === "STATUS");
  const absolute = offer.entries.find((e) => e.label === "/NAME");
  assert.ok(status, "the row field is offered relatively");
  assert.ok(absolute, "absolute paths stay available");
  assert.ok(status!.sortText! < absolute!.sortText!, "row fields sort first");
});

test("without a derived shape the binding offers nothing", () => {
  const offer = completeAbap(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NA‸` )",
    null
  );
  assert.ok(offer, "the binding context itself is still recognised");
  assert.deepEqual(offer.entries, []);
});

// ---------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------

test("hovering a control shows its description", () => {
  const info = hoverAbap(HEAD + "    )->tag( n = `But‸ton` )");
  assert.ok(info);
  assert.ok(info.text.includes("sap.m.Button"));
});

test("hovering a member shows its type", () => {
  const info = hoverAbap(HEAD + "    )->tag( n = `Button` )->a( n = `te‸xt` )");
  assert.ok(info);
  assert.ok(info.text.includes("string"));
});

test("hovering the default aggregation says so, like the completion does", () => {
  const info = hoverAbap(HEAD + "    )->ele( n = `Page` )->a( n = `cont‸ent` )");
  assert.ok(info);
  assert.ok(info.text.includes("default aggregation"));
  // a member that is not one stays unmarked
  const title = hoverAbap(HEAD + "    )->ele( n = `Page` )->a( n = `tit‸le` )");
  assert.ok(title);
  assert.ok(!title.text.includes("default aggregation"));
});

test("hovering an enum value explains the member it belongs to", () => {
  const info = hoverAbap(
    HEAD + "    )->tag( n = `Button` )->a( n = `type` v = `Emphas‸ized` )"
  );
  assert.ok(info);
  assert.ok(info.text.includes("Emphasized"), "lists the allowed values");
});

test("hovering a resolving absolute path says the binding resolves", () => {
  const info = hoverAbap(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NA‸ME}` )"
  );
  assert.ok(info);
  assert.ok(info.text.includes("{/NAME}"));
  assert.ok(info.text.includes("the binding resolves"));
});

test("hovering a missing path predicts the squiggle", () => {
  const info = hoverAbap(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NO‸PE}` )"
  );
  assert.ok(info);
  assert.ok(info.text.includes("unknown-binding-path"));
});

test("hovering a table path says what an aggregation binds", () => {
  const info = hoverAbap(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/TRAV‸ELS}` )"
  );
  assert.ok(info);
  assert.ok(info.text.includes("**table**"));
});

test("a relative path inside a template resolves against the row", () => {
  const info = hoverAbap(
    HEAD +
      "    )->ele( n = `List` )->a( n = `items` v = `{/TRAVELS}`\n" +
      "    )->tag( n = `Text` )->a( n = `text` v = `{STAT‸US}` )"
  );
  assert.ok(info);
  assert.ok(info.text.includes("the binding resolves"));
  assert.ok(info.text.includes("Relative to the row of `{/TRAVELS}`"));
});

test("a relative path without an enclosing aggregation says so", () => {
  const info = hoverAbap(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{STAT‸US}` )"
  );
  assert.ok(info);
  assert.ok(info.text.includes("none is in effect here"));
});

test("without a shape the binding hover falls back to the member", () => {
  // no derived model to explain the path with - the value hover still
  // says what the member is, instead of staying silent
  const info = hoverAbap(
    HEAD + "    )->tag( n = `Text` )->a( n = `text` v = `{/NA‸ME}` )",
    null
  );
  assert.ok(info);
  assert.ok(info.text.includes("property of `sap.m.Text`"));
});

test("hover in dead space stays quiet", () => {
  const { source, offset } = at("DATA(x) = ‸1.");
  assert.equal(
    hoverAt(source, "zcl_app.clas.abap", offset, data, noShape),
    undefined
  );
});

// ---------------------------------------------------------------------------
// Colour-typed members
// ---------------------------------------------------------------------------

test("CSSColor-typed members count as colours, others do not", () => {
  // sap.ui.core.Icon's color property is CSSColor-typed in the snapshot
  assert.equal(isColorMember(data, "sap.ui.core.Icon", "color"), true);
  assert.equal(isColorMember(data, "sap.m.Button", "text"), false);
  assert.equal(isColorMember(data, "sap.m.Button", "nonsense"), false);
});

/* completionAt/hoverAt run on every keystroke, so a throw at an unusual
 * cursor position is a broken editor feature rather than a wrong answer.
 * Neither is allowed to throw ANYWHERE in a source - including mid-token,
 * inside a literal, and one past the end. Verified at scale before being
 * pinned here: 13,398 calls at every 89th offset over 70 corpus files
 * (classes, views and fragments) threw nothing; the corpus sweep cannot run
 * in this repo's CI, so a representative fixture carries the guard. */
test("completionAt and hoverAt never throw, at any offset", () => {
  const source =
    HEAD +
    "    )->tag( `Button` )->a( n = `text` v = `{NAME}`\n" +
    "    )->a( n = `press` v = client->_event( `GO` ) ).\n" +
    "CASE client->get( )-event.\n" +
    "  WHEN `GO`.\n" +
    "ENDCASE.\n";
  for (const file of ["z.clas.abap", "z.view.xml"]) {
    for (let offset = 0; offset <= source.length; offset++) {
      assert.doesNotThrow(
        () => completionAt(source, file, offset, data, () => SHAPE),
        `completionAt threw at offset ${offset} of ${file}`
      );
      assert.doesNotThrow(
        () => hoverAt(source, file, offset, data, () => SHAPE),
        `hoverAt threw at offset ${offset} of ${file}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Completion: the handle idiom of the scaffolded class
// ---------------------------------------------------------------------------

/** The starter class's view method: the root in `view`, the Page in `page`,
 *  the rest written on the handle. */
const STARTER =
  "DATA(view) = z2ui5_cl_ui5_view_builder=>factory(\n" +
  "    )->ele( n  = `View`\n" +
  "            ns = `mvc`\n" +
  "        )->a( n = `xmlns`     v = `sap.m`\n" +
  "        )->a( n = `xmlns:mvc` v = `sap.ui.core.mvc` ).\n" +
  "DATA(page) = view->ele( `Shell`\n" +
  "    )->ele( `Page`\n" +
  "        )->a( n = `title` v = `My abap2UI5 App` ).\n" +
  "page->ele( `List`\n" +
  "    )->a( n = `items` v = client->_bind( t_items )\n" +
  "    )->ele( `items`\n" +
  "        )->tag( `StandardListItem`\n" +
  "            )->a( n = `title` v = `{PRODUCT}` ).\n";

const STARTER_SHAPE = {
  NAME: "",
  T_ITEMS: [{ PRODUCT: "", QUANTITY: 0 }],
};

test("a binding written on the page handle offers no row fields", () => {
  const offer = completeAbap(
    STARTER + "page->tag( `Button` )->a( n = `text` v = `{‸` ).\n",
    STARTER_SHAPE
  );
  assert.ok(offer);
  const labels = offer.entries.map((e) => e.label);
  assert.ok(labels.includes("/NAME"), "absolute paths are offered");
  assert.ok(labels.includes("/T_ITEMS/PRODUCT"));
  // the row fields the List hands down belong to its template only - offered
  // here they were exactly what the gate then reported as unknown-binding-path
  assert.ok(!labels.includes("PRODUCT"), labels.join(","));
  assert.ok(!labels.includes("QUANTITY"));
  // inside the template they are still first
  const row = completeAbap(STARTER.replace("`{PRODUCT}`", "`{‸`"), STARTER_SHAPE);
  assert.ok(row?.entries.some((e) => e.label === "PRODUCT"));
});

test("a member written on the page handle is Page's, not the list item's", () => {
  const head = STARTER.slice(0, STARTER.indexOf("page->ele( `List`"));
  const offer = completeAbap(head + "page->a( n = `‸` ).\n", STARTER_SHAPE);
  assert.ok(offer);
  const labels = offer.entries.map((e) => e.label);
  assert.ok(labels.includes("title"));
  assert.ok(labels.includes("showNavButton"));
  assert.ok(!labels.includes("description"), "a StandardListItem member");
  // a Button added on the handle owns what follows it
  const button = completeAbap(
    STARTER + "page->tag( `Button` )->a( n = `‸` ).\n",
    STARTER_SHAPE
  );
  assert.ok(button?.entries.some((e) => e.label === "press"));
  assert.ok(!button?.entries.some((e) => e.label === "showNavButton"));
});

// ---------------------------------------------------------------------------
// Completion: the wire's other end
// ---------------------------------------------------------------------------

const DISPATCH =
  "METHOD on_event.\n" +
  "  IF client->check_on_event( `REFRESH` ).\n" +
  "    view_display( ).\n" +
  "  ENDIF.\n" +
  "  CASE client->get_event( ).\n" +
  "    WHEN `SAVE`.\n" +
  "    WHEN `CANCEL` OR `BACK`.\n" +
  "  ENDCASE.\n" +
  "ENDMETHOD.\n";

test("inside an _event literal the handled events are offered first", () => {
  const offer = completeAbap(
    HEAD +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_event( `‸` )\n" +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_event( `save` )\n" +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_event( val = `DELETE` )\n" +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_event( `DELETE` ) ).\n" +
      DISPATCH
  );
  assert.ok(offer, "the event literal is a completable position");
  assert.deepEqual(
    offer.entries.map((e) => e.label),
    ["BACK", "CANCEL", "REFRESH", "SAVE", "DELETE", "save"]
  );
  assert.ok(offer.entries.every((e) => e.kind === "events"));
  const byLabel = new Map(offer.entries.map((e) => [e.label, e.detail]));
  assert.equal(byLabel.get("SAVE"), "handled by a WHEN branch");
  assert.equal(byLabel.get("REFRESH"), "handled by a check_on_event( ) test");
  assert.equal(byLabel.get("DELETE"), "raised 2× elsewhere in the view - no handler yet");
  // the mismatch event-without-handler would report afterwards, named here
  assert.equal(
    byLabel.get("save"),
    "raised 1× elsewhere in the view - its handler is spelled `SAVE`"
  );
});

test("the _event literal completes in the val = form and in any spelling", () => {
  const offer = completeAbap(
    HEAD +
      "    )->tag( n = `Button` )->a( n = `press` v = client->_EVENT( VAL = `S‸` ) ).\n" +
      DISPATCH
  );
  assert.ok(offer);
  assert.ok(offer.entries.some((e) => e.label === "SAVE"));
  // the literal being written is not counted as a second wire
  assert.ok(!offer.entries.some((e) => e.label === "S"));
  // the span is the literal's content, so the pick replaces what was typed
  assert.equal(offer.end - offer.start, 1);
});

const CLASS_HEAD =
  "CLASS zcl_app DEFINITION PUBLIC.\n" +
  "  PUBLIC SECTION.\n" +
  "    INTERFACES z2ui5_if_app.\n" +
  "    CONSTANTS c_title TYPE string VALUE `x`.\n" +
  "    CLASS-DATA gv_count TYPE i.\n" +
  "    DATA t_items TYPE STANDARD TABLE OF string WITH EMPTY KEY.\n" +
  "    DATA name TYPE string.\n" +
  "  PROTECTED SECTION.\n" +
  "    DATA client TYPE REF TO z2ui5_if_client.\n" +
  "    DATA mv_hidden TYPE string.\n" +
  "ENDCLASS.\n" +
  "CLASS zcl_app IMPLEMENTATION.\n" +
  "  METHOD view_display.\n";

test("after _bind( the PUBLIC instance attributes are offered", () => {
  const offer = completeAbap(
    CLASS_HEAD + HEAD + "    )->tag( n = `Input` )->a( n = `value` v = client->_bind( ‸"
  );
  assert.ok(offer, "the _bind argument is a completable position");
  assert.deepEqual(
    offer.entries.map((e) => [e.label, e.kind]),
    [
      ["t_items", "binding-table"],
      ["name", "binding-path"],
    ],
    "no CONSTANTS, no CLASS-DATA, nothing from the other sections"
  );
});

test("the _bind argument completes in the val = form and in any spelling", () => {
  const named = completeAbap(
    CLASS_HEAD +
      HEAD +
      "    )->tag( n = `Input` )->a( n = `value` v = client->_BIND( VAL = na‸ ) )"
  );
  assert.ok(named);
  assert.ok(named.entries.some((e) => e.label === "name"));
  assert.equal(named.end - named.start, 2, "the typed prefix is what a pick replaces");
  const edit = completeAbap(
    CLASS_HEAD +
      HEAD +
      "    )->tag( n = `Input` )->a( n = `value` v = client->_bind_edit( ‸ ) )"
  );
  assert.ok(edit?.entries.some((e) => e.label === "name"));
  // once the argument is written, the next space must not reopen the list
  const done = completeAbap(
    CLASS_HEAD + HEAD + "    )->tag( n = `Input` )->a( n = `value` v = client->_bind( name ‸"
  );
  assert.equal(done, undefined);
});
