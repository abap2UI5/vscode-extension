import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlsIn,
  deprecationText,
  describeControl,
  describeMember,
  enumValues,
  librariesIn,
  memberInfo,
  membersOf,
  valuesFor,
} from "../metadata";
import type { Snapshot } from "../metadata";
import { snapshot, snapshotError } from "../snapshot";

/*
 * These run against the real bundled snapshot, on purpose: what they actually
 * guard is that the shipped metadata still has the shape the completion and
 * hover code reads. A snapshot regenerated from a newer OpenUI5 that renamed
 * a section would pass a mocked test and break the feature.
 */

const data = snapshot();

test("the bundled snapshot is readable and not empty", () => {
  assert.equal(snapshotError(), undefined);
  assert.ok(Object.keys(data).length > 500, "expected the full control set");
});

test("a library offers its own controls, not its sub-namespaces", () => {
  const controls = controlsIn(data, "sap.m");
  assert.ok(controls.includes("Button"));
  assert.ok(controls.includes("Page"));
  assert.equal(
    controls.some((c) => c.includes(".")),
    false,
    "sap.m.semantic.* belongs to its own namespace"
  );
  // Sorted, so the completion list does not reorder between snapshots.
  assert.deepEqual(controls, [...controls].sort());
});

test("the snapshot's libraries are listed once each, sorted", () => {
  const libraries = librariesIn(data);
  assert.ok(libraries.includes("sap.m"));
  assert.ok(libraries.includes("sap.f"));
  assert.ok(libraries.includes("sap.ui.layout"));
  assert.deepEqual(libraries, [...libraries].sort());
  assert.equal(new Set(libraries).size, libraries.length);
  // memoised per snapshot - the same array comes back
  assert.equal(librariesIn(data), libraries);
});

test("members are collected across the parent chain", () => {
  const own = memberInfo(data, "sap.m.Button", "text");
  assert.equal(own?.section, "properties");
  assert.equal(own?.declaredOn, "sap.m.Button");

  // `visible` is declared on sap.ui.core.Control, three levels up.
  const inherited = memberInfo(data, "sap.m.Button", "visible");
  assert.equal(inherited?.section, "properties");
  assert.notEqual(inherited?.declaredOn, "sap.m.Button");

  const event = memberInfo(data, "sap.m.Button", "press");
  assert.equal(event?.section, "events");

  assert.equal(memberInfo(data, "sap.m.Button", "typ"), undefined);
});

test("a control not in the snapshot yields nothing rather than throwing", () => {
  assert.deepEqual(membersOf(data, "com.acme.Widget"), []);
  assert.equal(memberInfo(data, "com.acme.Widget", "text"), undefined);
});

test("the accepted values of a member are the enum's, or the two booleans", () => {
  const types = valuesFor(data, "sap.m.Button", "type");
  assert.ok(types?.includes("Emphasized"));
  assert.deepEqual(valuesFor(data, "sap.m.Button", "enabled"), ["true", "false"]);
  assert.equal(valuesFor(data, "sap.m.Button", "text"), undefined);
});

test("the three deprecation shapes all produce one line", () => {
  assert.equal(deprecationText(undefined), undefined);
  assert.equal(deprecationText(true), "deprecated");
  assert.equal(
    deprecationText({ since: "1.20", text: "replaced by <code>press</code>" }),
    "Deprecated since 1.20 — replaced by `press`"
  );
  assert.equal(deprecationText({ text: "no replacement" }), "Deprecated — no replacement");
});

test("the hover text names the member, its type and where it comes from", () => {
  const text = describeMember(data, "sap.m.Button", "type");
  assert.match(text, /\*\*type\*\*/);
  assert.match(text, /sap\.m\.ButtonType/);
  assert.match(text, /ui5\.sap\.com/);
  assert.equal(describeMember(data, "sap.m.Button", "nonsense"), "");
});

/*
 * A hand-built snapshot for the wording: the real one changes with every
 * regeneration, and the lines below are about the text each field becomes.
 */
const TINY = {
  "x.Base": {
    properties: {
      text: { type: "string", since: "1.20", deprecated: "use label" },
      width: { type: "sap.ui.core.CSSSize" },
    },
  },
  "x.Card": {
    parent: "x.Base",
    since: "1.64",
    defaultAggregation: "content",
    deprecated: { since: "1.120", text: "use <code>x.Tile</code>" },
    members: { text: "1.70" },
    // redeclared here: this one wins over the base's
    properties: { text: { type: "string" } },
    aggregations: { content: { type: "sap.ui.core.Control", multiple: true } },
  },
  "x.Plain": {},
} as unknown as Snapshot;

test("a member redeclared down the chain is the one described", () => {
  const text = memberInfo(TINY, "x.Card", "text")!;
  assert.equal(text.declaredOn, "x.Card");
  // its @since comes from the flattened index, the base's deprecation stays behind
  assert.equal(text.since, "1.70");
  assert.equal(text.deprecated, undefined);
  assert.deepEqual(
    membersOf(TINY, "x.Card").map((m) => `${m.name}@${m.declaredOn}`),
    ["content@x.Card", "text@x.Card", "width@x.Base"]
  );
});

test("the control hover names its since, parent, default aggregation and deprecation", () => {
  assert.equal(
    describeControl(TINY, "x.Card"),
    [
      "**x.Card**",
      "since UI5 1.64 · extends `x.Base` · default aggregation `content`",
      "⚠️ Deprecated since 1.120 — use `x.Tile`",
      "[UI5 API reference](https://ui5.sap.com/#/api/x.Card)",
    ].join("\n\n")
  );
  // a control with nothing to say gets the name and the link only
  assert.equal(
    describeControl(TINY, "x.Plain"),
    "**x.Plain**\n\n[UI5 API reference](https://ui5.sap.com/#/api/x.Plain)"
  );
  assert.equal(describeControl(TINY, "x.Nothing"), "");
});

test("the member hover carries its since and a deprecation written as text", () => {
  assert.equal(
    describeMember(TINY, "x.Base", "text"),
    [
      "**text** — property of `x.Base`",
      "type `string` · since UI5 1.20",
      "⚠️ use label",
      "[UI5 API reference](https://ui5.sap.com/#/api/x.Base)",
    ].join("\n\n")
  );
  assert.match(
    describeMember(TINY, "x.Card", "content"),
    /aggregation of `x\.Card`\n\ntype `sap\.ui\.core\.Control` · 0\.\.n · default aggregation/
  );
});

test("an enum lookup without a type answers nothing", () => {
  assert.equal(enumValues(data, undefined), undefined);
  assert.equal(enumValues(data, ""), undefined);
  assert.equal(deprecationText("a plain sentence"), "a plain sentence");
});
