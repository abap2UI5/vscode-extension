import { test } from "node:test";
import assert from "node:assert/strict";
import { findControlUses, rankExamples } from "../examples";

/*
 * The sample-catalogue search: what counts as a use of a control, how much of
 * it a hit demonstrates, and the ordering that decides which of four hundred
 * Buttons anyone actually sees.
 */

const WHERE = { file: "/repos/samples/src/zcl_demo.clas.abap", catalogue: "samples" };

const SOURCE = `CLASS zcl_demo IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`Page\` )->a( n = \`title\` v = \`Demo\`
        )->ele( n = \`Table\` )->a( n = \`items\` v = client->_bind( mt_tab )
        )->a( n = \`mode\` v = \`SingleSelect\`
        )->a( n = \`growing\` b = abap_true
        )->tag( n = \`Text\` )->a( n = \`text\` v = \`plain\` ).
  ENDMETHOD.
ENDCLASS.`;

test("both builder verbs count, and the namespace prefix does not hide a control", () => {
  assert.equal(findControlUses(SOURCE, "Table", WHERE).length, 1);
  assert.equal(findControlUses(SOURCE, "Text", WHERE).length, 1);
  const prefixed = "view->ele( n = `f:Card` )->a( n = \`width\` v = \`20rem\` )";
  assert.equal(findControlUses(prefixed, "Card", WHERE).length, 1);
});

test("a library-qualified name searches for the control it names", () => {
  assert.equal(findControlUses(SOURCE, "sap.m.Table", WHERE).length, 1);
});

test("the hit knows where it is and how much it shows", () => {
  const [hit] = findControlUses(SOURCE, "Table", WHERE);
  assert.equal(hit.line, 5);
  assert.ok(hit.text.includes("Table"));
  // items, mode, growing - and not the Text's own attribute
  assert.equal(hit.attributes, 3);
  assert.equal(hit.catalogue, "samples");
});

test("a name that merely CONTAINS the search is not a hit", () => {
  // sap.m.Table vs sap.ui.table.Table is a real distinction, and `Tabler`
  // would otherwise answer a search for `Table`
  const other = "view->ele( n = `TableSelectDialog` )";
  assert.equal(findControlUses(other, "Table", WHERE).length, 0);
});

test("the richest example comes first", () => {
  const hits = [
    { ...WHERE, line: 1, text: "a", attributes: 0 },
    { ...WHERE, file: "/x/b.clas.abap", line: 2, text: "b", attributes: 5 },
    { ...WHERE, file: "/x/c.clas.abap", line: 3, text: "c", attributes: 2 },
  ];
  assert.deepEqual(
    rankExamples(hits).map((h) => h.text),
    ["b", "c", "a"]
  );
});

test("one file cannot fill the whole list", () => {
  // a sample app using Text forty times would otherwise BE the answer
  const many = Array.from({ length: 8 }, (_, i) => ({
    ...WHERE,
    line: i + 1,
    text: `line ${i}`,
    attributes: 9 - i,
  }));
  const ranked = rankExamples([
    ...many,
    { ...WHERE, file: "/x/other.clas.abap", line: 1, text: "other", attributes: 1 },
  ]);
  assert.equal(ranked.filter((h) => h.file === WHERE.file).length, 2);
  assert.ok(ranked.some((h) => h.text === "other"));
});

test("the positional call form counts as a use - it is most of the corpus", () => {
  /*
   * `tag( `Button` )` without the `n =` is what the XML converter emits and
   * what the sample catalogues are mostly written in (a lone `n =` trips
   * abaplint's omit_parameter_name). Matching only the named form reported a
   * fraction of the hits, and none at all for the common sap.m controls.
   */
  const source = [
    "    view->ele( `Page`",
    "        )->tag( `Button`",
    "            )->a( n = `text` v = `Go`",
    "            )->a( n = `press` v = `X` ).",
  ].join("\n");
  const hits = findControlUses(source, "sap.m.Button", {
    file: "z.clas.abap",
    catalogue: "samples",
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].attributes, 2);
  assert.equal(findControlUses(source, "Page", { file: "z", catalogue: "s" }).length, 1);
});

test("both call forms are found in one source, and neither twice", () => {
  const source = [
    "view->tag( `Button` )->a( n = `text` v = `a` ).",
    "view->tag( n = `Button` )->a( n = `text` v = `b` ).",
  ].join("\n");
  const hits = findControlUses(source, "Button", {
    file: "z.clas.abap",
    catalogue: "samples",
  });
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.line),
    [1, 2]
  );
});

test("a positional literal of another control is not a hit", () => {
  const source = "view->tag( `Text` )->a( n = `text` v = `Button` ).";
  assert.deepEqual(
    findControlUses(source, "Button", { file: "z", catalogue: "s" }),
    []
  );
});
