import { test } from "node:test";
import assert from "node:assert/strict";
import { renderErrorNeedles, renderErrorOffset } from "../renderloc";

const SOURCE = [
  "    view->ele( n = `View` ns = `mvc`",
  "        )->ele( n = `Page`",
  "        )->tag( n = `Button`",
  "        )->a( n = `type` v = `Emphasised`",
  "        )->end( ).",
].join("\n");

test("quoted tokens come first - they are what the error is about", () => {
  const needles = renderErrorNeedles(
    "'Emphasised' is of type string, expected sap.m.ButtonType for property 'type'"
  );
  assert.equal(needles[0], "Emphasised");
  assert.ok(needles.includes("type"));
  // the dotted name contributes its local part - what the builder writes
  assert.ok(needles.includes("ButtonType"));
});

test("the error lands on the token it quotes", () => {
  const offset = renderErrorOffset(
    "'Emphasised' is of type string, expected sap.m.ButtonType",
    SOURCE
  );
  assert.equal(offset, SOURCE.indexOf("Emphasised"));
});

test("a control named in a dotted class resolves to its local name", () => {
  const offset = renderErrorOffset(
    "Cannot add direct child without default aggregation defined for control sap.m.Button",
    SOURCE
  );
  assert.equal(offset, SOURCE.indexOf("Button"));
});

test("an error whose tokens appear nowhere keeps the old fallback", () => {
  assert.equal(
    renderErrorOffset("something entirely unrelated happened", SOURCE),
    undefined
  );
});

test("one-character and duplicate tokens are not needles", () => {
  const needles = renderErrorNeedles("'x' and 'x' and 'ab'");
  assert.deepEqual(needles, []);
});
