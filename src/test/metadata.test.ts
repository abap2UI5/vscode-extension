import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlsIn,
  deprecationText,
  describeMember,
  librariesIn,
  memberInfo,
  membersOf,
  valuesFor,
} from "../metadata";
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
