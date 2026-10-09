import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { checkAbapSource, checkXmlSource } from "@abap2ui5/linter";
import { prepareAbap } from "@abap2ui5/linter/reconstruct";
import {
  LINTER_MATCH_EOL,
  LINTER_PUBLIC_READ_FROM_OUTSIDE,
  matchLineEndings,
  matchLineEndingsPort,
  runGate,
} from "../gate";
import { LINTER_CLASS_INDEX_OF } from "../classindex";
import type { CheckOptions } from "../lintconfig";

/*
 * The gate against the linter's own pipeline.
 *
 * `gate.ts` re-implements `checkAbapSource` because the two hosts feed the
 * metadata snapshot in differently: desktop reads a file next to the bundle,
 * the browser gets the text through `vscode.workspace.fs`, and the linter's
 * entry point only takes a PATH. That is a good reason to have a second
 * caller - and no reason at all to have a second pipeline, which is what it
 * silently became.
 *
 * Five inputs had gone missing from the copy, each one switching off whole
 * rules with no symptom: `models` (unknown-model), `jsonPaths`
 * (json-bind-on-scalar-property), `fromAbap` (both
 * raw-javascript-to-frontend forms), `prep.structure` (excess-shut,
 * duplicate-property, attribute-without-element - the ones that ASSERT at
 * runtime) and `minUi5` on the ABAP rules (icons judged against 1.71 instead
 * of the repo's floor). Every one of them was a finding CI reported and the
 * editor did not: exactly the divergence `gate.ts` exists to close.
 *
 * So the two are pinned to each other here. A fixture whose findings differ
 * fails - which is what should happen when the linter's pipeline grows a
 * sixth input and this copy does not.
 *
 * Three more went the same way later and are pinned below: `boolFields`
 * (absent-boolean-overrides-default), the full `attachSourceFixes` /
 * `attachSuggestionFixes` (the did-you-mean and json-bind FIXES existed for
 * `--fix` and not for the lightbulb - `reduce` carries `fixes` now so that
 * cannot regress), and an early "nothing to check" exit for a class whose
 * view reconstructs to nothing, which skipped `view-never-displayed` and the
 * flow rules the CLI reports for exactly such a class.
 */

/** The snapshot the gate itself uses - `snapshot.ts` resolves it next to the
 *  bundle, so the linter has to be pointed at the same file to be comparable. */
const SNAPSHOT = path.join(__dirname, "properties.json");

const MIN_UI5 = "1.71";
const DISTRIBUTION = "sapui5" as const;

/** What the gate is given. */
const OPTIONS: CheckOptions = {
  minUi5: MIN_UI5,
  distribution: DISTRIBUTION,
  allow: [],
  rules: {},
};

/** The same thing, as the linter's entry points take it - plus the file name
 *  (`rules.*.exclude` matches it) and the snapshot path the gate resolves by
 *  itself. Both sides have to be told exactly the same, or the comparison
 *  measures the options rather than the pipelines. */
const linterOptions = (file: string) => ({
  minUi5: MIN_UI5,
  distribution: DISTRIBUTION,
  allow: [] as string[],
  rules: {},
  file,
  snapshot: SNAPSHOT,
});

/** A finding, reduced to what both sides must agree on. Messages are the
 *  linter's to word; type, place, subject and the mechanical correction are
 *  the verdict - a fix the CLI applies and the lightbulb does not offer is a
 *  divergence like any other. */
interface Reduced {
  type: string;
  offset?: number;
  control?: string;
  member?: string;
  value?: string;
  severity?: string;
  fixes?: Array<{ start: number; end: number; text: string }>;
}

const reduce = (findings: unknown[]): Reduced[] =>
  findings
    .map((raw) => {
      const f = raw as Reduced;
      return {
        type: f.type,
        offset: f.offset,
        control: f.control,
        member: f.member,
        value: f.value,
        severity: f.severity,
        fixes: f.fixes,
      };
    })
    .sort((a, b) =>
      a.type === b.type
        ? (a.offset ?? 0) - (b.offset ?? 0)
        : a.type.localeCompare(b.type)
    );

/** A class whose `main` builds one view - the shape the app template emits,
 *  because a chain that does not start at an `mvc:View` root reconstructs to
 *  nothing and would make every assertion here vacuously true. `inner` is
 *  the chain below `Page`, ending WITHOUT its closing paren. */
const clazz = (inner: string): string => `CLASS zcl_parity DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_parity IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`

        )->ele( n = \`Page\`
${inner} ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
`;

/** Sources chosen for the rules the copy used to switch off, plus a clean
 *  one - a gate that finds nothing must agree about that too. */
const ABAP_FIXTURES: Record<string, string> = {
  clean: clazz(`            )->tag( n = \`Text\`
                )->a( n = \`text\` v = \`My first app\``),

  // unknown-property: the plain property gate, as a control case
  "an unknown property": clazz(`            )->tag( n = \`Button\`
                )->a( n = \`text\` v = \`Go\`
                )->a( n = \`nosuchprop\` v = \`x\``),

  // unknown-icon: needs data/icons.json next to the bundle AND minUi5
  // reaching checkAbapRules
  "an icon that is in no release": clazz(`            )->tag( n = \`Button\`
                )->a( n = \`icon\` v = \`sap-icon://nosuchicon\``),

  // unknown-model: needs `models` (namedModels of the class)
  "a binding through a model the class never registers": clazz(`            )->tag( n = \`Text\`
                )->a( n = \`text\` v = \`{other>/field}\``),

  // excess-shut: needs prep.structure - one ascend more than the tree is
  // deep, which asserts at runtime
  "one end( ) too many": clazz(`            )->tag( n = \`Text\`
                )->a( n = \`text\` v = \`x\`
        )->end( )->end( )->end(`),

  // duplicate-property: prep.structure again
  "the same attribute written twice": clazz(`            )->tag( n = \`Button\`
                )->a( n = \`text\` v = \`Go\`
                )->a( n = \`text\` v = \`Stop\``),

  // raw-javascript-to-frontend: needs fromAbap
  "a handler that is raw javascript": clazz(`            )->tag( n = \`Button\`
                )->a( n = \`press\` v = \`alert('hi')\``),
};

/** attribute-without-element - the third `prep.structure` finding; it needs
 *  an attribute on the bare factory root, so it cannot use `clazz`. */
const ATTRIBUTE_ON_ROOT = `CLASS zcl_parity DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_parity IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->a( n = \`stray\` v = \`x\`
        )->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
`;
ABAP_FIXTURES["an attribute on the bare factory root"] = ATTRIBUTE_ON_ROOT;

/** A class that element-binds the slot its view is displayed into, and then
 *  writes a RELATIVE binding path under it.
 *
 *  `checkAbapSource` works `boundElement` out per document (elementBoundSlots)
 *  and passes it; it SUPPRESSES the "this path has no context" findings,
 *  because at runtime the wire supplies one that no static walk can see. A
 *  gate that does not pass it is stricter than CI - noise in the editor rather
 *  than silence, but a divergence either way. */
const ELEMENT_BOUND = `CLASS zcl_parity DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    DATA mt_rows TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.
ENDCLASS.

CLASS zcl_parity IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    client->follow_up_action( client->_event_client(
        action = z2ui5_if_client=>cs_event-bind_element
        t_arg  = VALUE #( ( \`/MT_ROWS/1\` ) ) ) ).

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`

        )->ele( n = \`Page\`
            )->tag( n = \`Text\`
                )->a( n = \`text\` v = \`{NAME}\` ) ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
`;
ABAP_FIXTURES["a relative path under an element-bound slot"] = ELEMENT_BOUND;

/** A class on the FROZEN builder. `checkAbapSource` answers with the one
 *  `frozen-view-builder` finding and nothing else; the gate used to answer
 *  "nothing to check" - an editor/CI divergence. `frozenBuilderOf` has no
 *  subpath in the linter's `exports` map, so `gate.ts` mirrors the two class
 *  names, and this fixture is what pins the mirror to the linter's answer. */
const FROZEN_CLASS = `CLASS zcl_parity DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_parity IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_xml_view=>factory( ).
    view->page( title = \`old\` )->stringify( ).

  ENDMETHOD.
ENDCLASS.
`;
ABAP_FIXTURES["a class on the frozen builder"] = FROZEN_CLASS;
ABAP_FIXTURES["a class on the frozen cc builder"] = FROZEN_CLASS.replace(
  "z2ui5_cl_xml_view=>factory",
  "z2ui5_cl_xml_view_cc=>factory"
);
/** The one rule that still reads a frozen-builder class: the old builder's
 *  obsolete companion helpers (`_z2ui5( )->timer( )` & co.) are method names,
 *  so `checkAbapSource` reports `obsolete-custom-control` beside
 *  `frozen-view-builder` (linter 0.8.2), and the gate has to as well. */
ABAP_FIXTURES["a class on the frozen builder with an obsolete helper"] =
  FROZEN_CLASS.replace(
    "    view->page( title = `old` )->stringify( ).",
    "    view->_z2ui5( )->timer( finished = client->_event( `TICK` ) ).\n" +
      "    view->page( title = `old` )->stringify( )."
  );

/** The classes below carry a FIX on the linter's side - the did-you-mean
 *  rewrite of a misspelt control and the deletion of a `json = abap_true` on
 *  a scalar property. The gate attached only the namespace fix, so `--fix`
 *  corrected what the lightbulb, "fix all" and the workspace fix could not. */
const clazzWithField = (inner: string): string =>
  clazz(inner).replace(
    "    INTERFACES z2ui5_if_app.\n",
    "    INTERFACES z2ui5_if_app.\n    DATA mv_text TYPE string.\n"
  );
ABAP_FIXTURES["a control written in the wrong case (did-you-mean fix)"] =
  clazz(`            )->tag( \`button\`
                )->a( n = \`text\` v = \`Go\``);
ABAP_FIXTURES["a json bind on a scalar property (fix deletes the argument)"] =
  clazzWithField(`            )->tag( n = \`Text\`
                )->a( n = \`text\` v = client->_bind( val = mv_text json = abap_true )`);

/** Fixtures copied verbatim from the linter's own test/fixtures, read from
 *  disk so they stay byte-identical to upstream. `nodisplay` builds a view
 *  it never displays and `flow` builds its views in helper methods - both
 *  reconstruct to NO document, which is where the gate used to leave with
 *  "nothing to check" while CI reported view-never-displayed and the flow
 *  rules. `rowdefaults` is the boolFields case, at the floor its controls
 *  need. */
const LINTER_FIXTURES = path.join(__dirname, "..", "src", "test", "fixtures", "linter");
/* Line endings are normalised because the fixtures are checked out with
 * core.autocrlf=true on the windows-latest runner (the same way the README
 * arrives there, see generate-settings.mjs): the linter then correctly
 * reports `crlf-line-ending` on both sides, and the deepEqual against `[]`
 * fails for a reason that has nothing to do with the gate's parity. */
const linterFixture = (name: string): string =>
  fs.readFileSync(path.join(LINTER_FIXTURES, name), "utf8").replace(/\r\n/g, "\n");
ABAP_FIXTURES["a view that is built and never displayed (linter fixture nodisplay)"] =
  linterFixture("nodisplay.clas.abap");
ABAP_FIXTURES["views built in helper methods, with flow defects (linter fixture flow)"] =
  linterFixture("flow.clas.abap");

/** A bare factory that builds no element at all: the reconstruction still
 *  yields an (empty) root, and neither side has anything to say - a gate
 *  that finds nothing must agree about that too. */
const EMPTY_BUILDER = `CLASS zcl_parity DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_parity IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    client->view_display( view->stringify( ) ).

  ENDMETHOD.
ENDCLASS.
`;
ABAP_FIXTURES["a bare factory that builds no element"] = EMPTY_BUILDER;

/* The linter's stand-down of unused-namespace-declaration: a class that
 * writes the prefix in more builder literals (`form:SimpleForm`) than its
 * reconstructed view carries uses it in a part of the view nobody here saw,
 * so the rule stays silent - and its deleting --fix with it. The gate
 * reported it, and the lightbulb offered to delete a declaration the view
 * needs. */
const helperBuilt = (directive: string): string => `CLASS zcl_parity DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    "! the edit form - added by the subclass that edits
    METHODS add_form IMPORTING parent TYPE REF TO z2ui5_cl_ui5_view_builder.
ENDCLASS.

CLASS zcl_parity IMPLEMENTATION.
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
${directive}    DATA(page) = view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`      v = \`sap.m\`
        )->a( n = \`xmlns:mvc\`  v = \`sap.ui.core.mvc\`
        )->a( n = \`xmlns:form\` v = \`sap.ui.layout.form\`
        )->ele( n = \`Page\` ).
    page->ele( n = \`Text\` )->a( n = \`text\` v = \`x\` ).

    client->view_display( view->stringify( ) ).

  ENDMETHOD.

  METHOD add_form.
    parent->ele( n = \`form:SimpleForm\` )->tag( n = \`Text\` )->a( n = \`text\` v = \`y\` ).
  ENDMETHOD.
ENDCLASS.
`;
ABAP_FIXTURES["a prefix the class writes outside its reconstructed view (the rule stands down)"] =
  helperBuilt("");
ABAP_FIXTURES["a waiver of a rule that stood down is not unused"] = helperBuilt(
  '    " abap2ui5lint-disable-next-line unused-namespace-declaration\n'
);

/** Fixtures that need a floor of their own - the same comparison, with both
 *  sides told the same `minUi5`. */
const ABAP_FIXTURES_AT: Record<string, { source: string; minUi5: string }> = {
  "a row that omits a default-true boolean (linter fixture rowdefaults)": {
    source: linterFixture("rowdefaults.clas.abap"),
    minUi5: "1.150",
  },
};

const XML_FIXTURES: Record<string, string> = {
  clean: '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n  <Button text="Go"/>\n</mvc:View>',
  // a lower-case control reads as an aggregation to UI5; the linter carries
  // the did-you-mean fix, and the gate's XML branch attached no fixes at all
  "a control written in the wrong case (did-you-mean fix)":
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n  <button text="Go"/>\n</mvc:View>',
  "unknown property":
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n  <Button text="Go" nosuchprop="x"/>\n</mvc:View>',
  "child in the wrong aggregation":
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n  <Button><content><Text text="x"/></content></Button>\n</mvc:View>',
};

for (const [name, source] of Object.entries(ABAP_FIXTURES)) {
  test(`the gate agrees with checkAbapSource - ${name}`, () => {
    const file = "src/zcl_parity.clas.abap";
    const mine = runGate(source, file, false, OPTIONS);
    const theirs = checkAbapSource(source, linterOptions(file));
    assert.deepEqual(
      reduce(mine.findings),
      reduce(theirs.findings),
      "gate.ts and checkAbapSource disagree - an input of the linter's " +
        "pipeline is missing from the gate (see the header of this file)"
    );
  });
}

for (const [name, fixture] of Object.entries(ABAP_FIXTURES_AT)) {
  test(`the gate agrees with checkAbapSource - ${name}`, () => {
    const file = "src/zcl_parity.clas.abap";
    const mine = runGate(fixture.source, file, false, { ...OPTIONS, minUi5: fixture.minUi5 });
    const theirs = checkAbapSource(fixture.source, {
      ...linterOptions(file),
      minUi5: fixture.minUi5,
    });
    assert.deepEqual(
      reduce(mine.findings),
      reduce(theirs.findings),
      "gate.ts and checkAbapSource disagree - an input of the linter's " +
        "pipeline is missing from the gate (see the header of this file)"
    );
  });
}

for (const [name, xml] of Object.entries(XML_FIXTURES)) {
  test(`the gate agrees with checkXmlSource - ${name}`, () => {
    const file = "src/view.view.xml";
    const mine = runGate(xml, file, true, OPTIONS);
    const theirs = checkXmlSource(xml, linterOptions(file));
    assert.deepEqual(
      reduce(mine.findings),
      reduce(theirs.findings),
      "gate.ts and checkXmlSource disagree"
    );
  });
}


/* --- CRLF ------------------------------------------------------------------
 *
 * Every fixture above is LF, and so was every fixture here until a CRLF file
 * was found to be judged by a different path: `crlf-line-ending` fires (its
 * fix rewrites every line break), the line-keyed rules count `\r` as
 * neither content nor blank, and the fixes that insert lines have to write
 * the file's own line ending - the linter's `settle` ends with
 * `matchLineEndings` from the release after 0.8.5 on, and the gate runs the
 * same pass (`matchLineEndings` in gate.ts: the linter's when exported, its
 * port until then). The CLI side is passed through the same function, which
 * is a no-op on a linter that already ran it - so this compares the
 * pipelines, and the line-ending pass is pinned on its own below. */

const crlf = (text: string): string => text.replace(/\r?\n/g, "\r\n");

/** A class whose fix INSERTS a line - the case the line-ending pass is for. */
const CTOR_IN_PRIVATE = `CLASS zcl_parity DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
  PRIVATE SECTION.
    CLASS-METHODS class_constructor.
ENDCLASS.

CLASS zcl_parity IMPLEMENTATION.
  METHOD class_constructor.
  ENDMETHOD.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->ele( n = \`Page\`
            )->tag( n = \`Text\`
                )->a( n = \`text\` v = \`x\` ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.
`;

const CRLF_ABAP: Record<string, string> = {
  "a class whose fix inserts a line": CTOR_IN_PRIVATE,
  ...ABAP_FIXTURES,
};

for (const rules of [{}, { "crlf-line-ending": false }]) {
  const label = Object.keys(rules).length ? "crlf-line-ending off" : "every rule on";
  for (const [name, lf] of Object.entries(CRLF_ABAP)) {
    test(`the gate agrees with checkAbapSource on a CRLF file (${label}) - ${name}`, () => {
      const file = "src/zcl_parity.clas.abap";
      const source = crlf(lf);
      const mine = runGate(source, file, false, { ...OPTIONS, rules });
      const theirs = checkAbapSource(source, { ...linterOptions(file), rules });
      assert.deepEqual(
        reduce(mine.findings),
        reduce(matchLineEndings(theirs.findings as Parameters<typeof matchLineEndings>[0], source)),
        "gate.ts and checkAbapSource disagree on a CRLF source"
      );
    });
  }
  for (const [name, lf] of Object.entries(XML_FIXTURES)) {
    test(`the gate agrees with checkXmlSource on a CRLF file (${label}) - ${name}`, () => {
      const file = "src/view.view.xml";
      const source = crlf(lf);
      const mine = runGate(source, file, true, { ...OPTIONS, rules });
      const theirs = checkXmlSource(source, { ...linterOptions(file), rules });
      assert.deepEqual(
        reduce(mine.findings),
        reduce(matchLineEndings(theirs.findings as Parameters<typeof matchLineEndings>[0], source)),
        "gate.ts and checkXmlSource disagree on a CRLF source"
      );
    });
  }
}

test("a CRLF file's fixes write CRLF, and LF while crlf-line-ending converts it", () => {
  const file = "src/zcl_parity.clas.abap";
  const source = crlf(CTOR_IN_PRIVATE);
  const kept = runGate(source, file, false, { ...OPTIONS, rules: { "crlf-line-ending": false } });
  const inserted = kept.findings.find((f) => f.type === "class-constructor-visibility");
  const texts = (inserted?.fixes ?? []).map((e) => e.text).filter((t) => t.includes("\n"));
  assert.ok(texts.length, "the fixture stopped producing a multi-line fix - the test measures nothing");
  for (const t of texts) {
    assert.ok(!/(^|[^\r])\n/.test(t.replace(/^\n/, "")), `a bare LF in a CRLF file's fix: ${JSON.stringify(t)}`);
  }
  // crlf-line-ending's own fix makes the file LF - every other text follows
  const converted = runGate(source, file, false, OPTIONS);
  assert.ok(converted.findings.some((f) => f.type === "crlf-line-ending"));
  for (const f of converted.findings) {
    for (const e of f.fixes ?? []) {
      assert.ok(!e.text.includes("\r\n"), `${f.type} writes CRLF into a file being made LF`);
    }
  }
  // and an LF file is left exactly as the rules wrote it
  const lf = runGate(CTOR_IN_PRIVATE, file, false, OPTIONS);
  for (const f of lf.findings) {
    for (const e of f.fixes ?? []) {
      assert.ok(!e.text.includes("\r"), `${f.type} writes a CR into an LF file`);
    }
  }
});

test("the line-ending port behaves as the linter's matchLineEndings", () => {
  const fx = (type: string, start: number, text: string) => ({ type, fixes: [{ start, end: start, text }] });
  // mostly CRLF: every LF of a fix text becomes CRLF
  const crlfSource = "a\r\nb\r\nc\r\n";
  assert.equal(matchLineEndingsPort([fx("r", 3, "x\ny\n")], crlfSource)[0].fixes[0].text, "x\r\ny\r\n");
  // a text starting with LF right behind a CR completes that line break
  assert.equal(matchLineEndingsPort([fx("r", 2, "\nz")], crlfSource)[0].fixes[0].text, "\nz");
  // already CRLF stays CRLF
  assert.equal(matchLineEndingsPort([fx("r", 3, "x\r\ny")], crlfSource)[0].fixes[0].text, "x\r\ny");
  // mostly LF (one CRLF among four breaks): untouched
  assert.equal(matchLineEndingsPort([fx("r", 0, "x\ny")], "a\nb\nc\r\nd\n")[0].fixes[0].text, "x\ny");
  // half and half is not "mostly CRLF"
  assert.equal(matchLineEndingsPort([fx("r", 0, "x\ny")], "a\r\nb\n")[0].fixes[0].text, "x\ny");
  // with crlf-line-ending among them every text is LF, its own fix untouched
  const conv = matchLineEndingsPort(
    [fx("r", 0, "x\r\ny"), { type: "crlf-line-ending", fixes: [{ start: 1, end: 2, text: "" }] }],
    "a\nb"
  );
  assert.equal(conv[0].fixes[0].text, "x\ny");
  assert.equal(conv[1].fixes[0].text, "");
  // when the pinned linter exports its own, the two agree on all of the above
  if (LINTER_MATCH_EOL) {
    for (const [findings, source] of [
      [[fx("r", 3, "x\ny\n")], crlfSource],
      [[fx("r", 2, "\nz")], crlfSource],
      [[fx("r", 0, "x\ny")], "a\nb\nc\r\nd\n"],
    ] as const) {
      const copy = () => JSON.parse(JSON.stringify(findings));
      assert.deepEqual(LINTER_MATCH_EOL(copy(), source), matchLineEndingsPort(copy(), source));
    }
  }
});

test("the fixtures actually produce findings - a vacuous parity proves nothing", () => {
  const types = new Set<string>();
  for (const source of Object.values(ABAP_FIXTURES)) {
    for (const f of runGate(source, "src/zcl_parity.clas.abap", false, OPTIONS)
      .findings) {
      types.add(f.type);
    }
  }
  for (const xml of Object.values(XML_FIXTURES)) {
    for (const f of runGate(xml, "src/view.view.xml", true, OPTIONS).findings) {
      types.add(f.type);
    }
  }
  assert.ok(
    types.size >= 4,
    `the fixtures only produced ${types.size} finding type(s): ${[...types].join(", ")}`
  );
});

test("the rules the missing inputs used to silence are reachable through the gate", () => {
  // Named to the rule, not to the fixture: if one of these stops being
  // produced the parity assertions above still pass (both sides go quiet
  // together only when the LINTER changes - but a regression in gate.ts's
  // wiring shows up here first, and with the rule's own name).
  const typesOf = (source: string, isXml = false): Set<string> =>
    new Set(
      runGate(
        source,
        isXml ? "src/view.view.xml" : "src/zcl_parity.clas.abap",
        isXml,
        OPTIONS
      ).findings.map((f) => f.type)
    );

  assert.ok(
    typesOf(ABAP_FIXTURES["one end( ) too many"]).has("excess-shut"),
    "excess-shut is missing - prep.structure is not being appended"
  );
  assert.ok(
    typesOf(ABAP_FIXTURES["the same attribute written twice"]).has(
      "duplicate-property"
    ),
    "duplicate-property is missing - prep.structure is not being appended"
  );
  assert.ok(
    typesOf(ABAP_FIXTURES["an attribute on the bare factory root"]).has(
      "attribute-without-element"
    ),
    "attribute-without-element is missing - prep.structure is not being appended"
  );
  assert.ok(
    typesOf(ABAP_FIXTURES["an icon that is in no release"]).has("unknown-icon"),
    "unknown-icon is missing - the linter's data/icons.json is not where the " +
      "bundled linter looks for it (esbuild.js copySnapshot), or minUi5 is " +
      "not reaching checkAbapRules"
  );
  assert.ok(
    typesOf(
      ABAP_FIXTURES["a binding through a model the class never registers"]
    ).has("unknown-model"),
    "unknown-model is missing - namedModels is not reaching checkNodes"
  );
  assert.ok(
    typesOf(ABAP_FIXTURES["a handler that is raw javascript"]).has(
      "raw-javascript-to-frontend"
    ),
    "raw-javascript-to-frontend is missing - fromAbap is not reaching checkNodes"
  );
  assert.ok(
    typesOf(ABAP_FIXTURES["a class on the frozen builder"]).has(
      "frozen-view-builder"
    ),
    "frozen-view-builder is missing - the gate answered 'nothing to check' " +
      "for a class on the frozen builder, which CI reports"
  );
  assert.ok(
    typesOf(
      ABAP_FIXTURES["a class on the frozen builder with an obsolete helper"]
    ).has("obsolete-custom-control"),
    "obsolete-custom-control is missing - obsoleteCcHelperFindings is not " +
      "reaching the gate's frozen-builder branch"
  );
  assert.ok(
    new Set(
      runGate(
        ABAP_FIXTURES_AT["a row that omits a default-true boolean (linter fixture rowdefaults)"].source,
        "src/zcl_parity.clas.abap",
        false,
        { ...OPTIONS, minUi5: "1.150" }
      ).findings.map((f) => f.type)
    ).has("absent-boolean-overrides-default"),
    "absent-boolean-overrides-default is missing - boolFields is not reaching checkAbapRules"
  );
  assert.ok(
    typesOf(
      ABAP_FIXTURES["a view that is built and never displayed (linter fixture nodisplay)"]
    ).has("view-never-displayed"),
    "view-never-displayed is missing - the gate left with 'nothing to check' " +
      "for a class whose view reconstructs to nothing"
  );
  const flow = typesOf(
    ABAP_FIXTURES["views built in helper methods, with flow defects (linter fixture flow)"]
  );
  for (const rule of ["unconditional-popup-display", "display-after-nav-app-call"]) {
    assert.ok(
      flow.has(rule),
      `${rule} is missing - the ABAP-side rules did not run over a class that reconstructs no view`
    );
  }
});

test("the fixes the CLI applies are on the findings the lightbulb sees", () => {
  const fixOf = (source: string, type: string, isXml = false) => {
    const f = runGate(
      source,
      isXml ? "src/view.view.xml" : "src/zcl_parity.clas.abap",
      isXml,
      OPTIONS
    ).findings.find((finding) => finding.type === type);
    assert.ok(f, `${type} was not produced - the fixture measures nothing`);
    return f.fixes;
  };
  const rename = fixOf(
    ABAP_FIXTURES["a control written in the wrong case (did-you-mean fix)"],
    "unknown-aggregation"
  );
  assert.equal(rename?.[0]?.text, "Button", "the did-you-mean fix is missing on the ABAP side");
  const json = fixOf(
    ABAP_FIXTURES["a json bind on a scalar property (fix deletes the argument)"],
    "json-bind-on-scalar-property"
  );
  assert.equal(json?.[0]?.text, "", "the json = abap_true deletion is missing");
  const xml = fixOf(
    XML_FIXTURES["a control written in the wrong case (did-you-mean fix)"],
    "unknown-aggregation",
    true
  );
  assert.equal(xml?.[0]?.text, "Button", "the did-you-mean fix is missing on the XML side");
});

test("a class that reconstructs no view is judged by the ABAP rules, and 'nothing checked' only without a finding", () => {
  const file = "src/zcl_parity.clas.abap";
  const judged = runGate(
    ABAP_FIXTURES["a view that is built and never displayed (linter fixture nodisplay)"],
    file,
    false,
    OPTIONS
  );
  assert.equal(judged.nothingChecked, undefined, "a finding was produced, so something WAS checked");
  assert.equal(judged.renderable, false, "nothing to hand the render gate");
  assert.match(judged.helperNote, /no view could be reconstructed/);
  /* The same class with the one rule it trips switched off by the repo: no
   * view to judge, no finding left - "passed" would claim a validation that
   * never happened, so this is the case that still says "nothing checked". */
  const silent = runGate(
    ABAP_FIXTURES["a view that is built and never displayed (linter fixture nodisplay)"],
    file,
    false,
    { ...OPTIONS, rules: { "view-never-displayed": false } }
  );
  assert.deepEqual(silent.findings, []);
  assert.match(String(silent.nothingChecked), /no view could be reconstructed/);
  assert.equal(silent.renderable, false);
});

test("a rules exclude anchored the way CI writes it matches in the editor too", () => {
  /* The linter matches `exclude` against the path as given, its absolute
   * form and its cwd-relative form - and a CLI run's cwd is the repo root,
   * so `^src/02/` matches there. The editor names the file absolutely and
   * its host's cwd is arbitrary, so the gate derives the CONFIG-relative
   * spelling too; without it the editor squiggled what CI had waived. */
  const source = ABAP_FIXTURES["an unknown property"];
  const rules = { "unknown-property": { exclude: ["^src/02/"] } };
  const abs = "/repo/src/02/zcl_parity.clas.abap";
  const config = "/repo/abap2ui5lint.jsonc";
  const control = runGate(source, abs, false, { ...OPTIONS, configFile: config });
  assert.ok(
    control.findings.some((f) => f.type === "unknown-property"),
    "the fixture stopped producing the finding - the test measures nothing"
  );
  const mine = runGate(source, abs, false, { ...OPTIONS, rules, configFile: config });
  assert.ok(
    !mine.findings.some((f) => f.type === "unknown-property"),
    "the exclude did not match the config-relative spelling of the file"
  );
  // CI's own answer for the spelling the pattern was written against
  const theirs = checkAbapSource(source, {
    ...linterOptions("src/02/zcl_parity.clas.abap"),
    rules,
  });
  assert.ok(!theirs.findings.some((f) => f.type === "unknown-property"));
});

test("a precomputed prep produces exactly the findings the gate derives itself", () => {
  /* `GateOptions.prep` lets the vscode layer hand in its memoised
   * `prepareAbap` instead of the gate parsing the identical text a second
   * time on every keystroke and CodeLens pass. The whole point of the
   * handover is that it changes NOTHING about the verdict - so every ABAP
   * fixture is run both ways and the findings are pinned to each other,
   * `annotate`'s in-place line/column enrichment included. */
  const file = "src/zcl_parity.clas.abap";
  let compared = 0;
  for (const [name, source] of Object.entries(ABAP_FIXTURES)) {
    const derived = runGate(source, file, false, OPTIONS);
    const handed = runGate(source, file, false, {
      ...OPTIONS,
      prep: prepareAbap(source),
    });
    assert.deepEqual(
      reduce(handed.findings),
      reduce(derived.findings),
      `passing prep changed the findings for "${name}"`
    );
    assert.equal(handed.renderable, derived.renderable, name);
    assert.equal(handed.nothingChecked, derived.nothingChecked, name);
    compared++;
  }
  assert.ok(compared >= 5, "the fixture table went missing");
});

test("the directives hear the rules block, as the linter's settle tells them", () => {
  /* A directive's own findings (unused-directive, unknown-directive-rule)
   * pass through the `rules` block like every other finding - in the
   * linter's settle, which hands applyDirectives the rules and the file. The
   * gate called it with neither, so a repository that switched
   * `unused-directive` off, re-graded `unknown-directive-rule` or excluded a
   * folder still saw them in the editor. */
  const source = clazz(`            )->tag( n = \`Text\`
                " abap2ui5lint-disable-next-line unknown-property
                )->a( n = \`text\` v = \`fine\`
                " abap2ui5lint-disable-next-line no-such-rule
                )->a( n = \`wrapping\` v = \`true\``);
  const file = "src/zcl_parity.clas.abap";
  const variants: Array<Record<string, unknown>> = [
    {},
    { "unused-directive": "off" },
    { "unknown-directive-rule": "error" },
    { "unused-directive": { exclude: ["^src/"] }, "unknown-directive-rule": false },
  ];
  const control = runGate(source, file, false, OPTIONS).findings.map((f) => f.type);
  assert.ok(
    control.includes("unused-directive") && control.includes("unknown-directive-rule"),
    `the fixture stopped producing both directive findings - the test measures nothing (${control.join(", ")})`
  );
  for (const rules of variants) {
    const mine = runGate(source, file, false, { ...OPTIONS, rules });
    const theirs = checkAbapSource(source, { ...linterOptions(file), rules });
    assert.deepEqual(reduce(mine.findings), reduce(theirs.findings), JSON.stringify(rules));
  }
});

test("a stood-down rule's waiver is unjudged, not unused - and the stand-down is the linter's", () => {
  const source = ABAP_FIXTURES["a waiver of a rule that stood down is not unused"];
  const mine = runGate(source, "src/zcl_parity.clas.abap", false, OPTIONS).findings;
  assert.ok(!mine.some((f) => f.type === "unused-namespace-declaration"), "the rule stood down");
  assert.ok(!mine.some((f) => f.type === "unused-directive"), "its waiver is not unused");
  // and the same class with the literal the view does not carry taken out:
  // the rule judges it again, and the declaration is reported
  const judged = runGate(
    ABAP_FIXTURES["a prefix the class writes outside its reconstructed view (the rule stands down)"]
      .replace("`form:SimpleForm`", "`SimpleForm`"),
    "src/zcl_parity.clas.abap",
    false,
    OPTIONS
  ).findings;
  assert.ok(
    judged.some((f) => f.type === "unused-namespace-declaration"),
    "the fixture stopped producing the finding - the test measures nothing"
  );
});

test("a public attribute another class reads: the rules stand down, and their waiver is unjudged", (t) => {
  /* From the release after 0.8.5 on, checkAbapSource stands the two
   * public-attribute rules down for a class whose public attributes another
   * class of the run reads (`publicReadFromOutside` over the class index) -
   * and tells applyDirectives so, or the waiver that used to be needed would
   * turn into an unused-directive the moment the index arrived. */
  if (!LINTER_PUBLIC_READ_FROM_OUTSIDE || !LINTER_CLASS_INDEX_OF) {
    t.skip("the pinned linter has no publicReadFromOutside / classIndexOf");
    return;
  }
  const popup = `CLASS zcl_px_popup DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    " abap2ui5lint-disable-next-line unused-public-attribute
    DATA ms_result TYPE string.
    DATA mv_title TYPE string.
ENDCLASS.

CLASS zcl_px_popup IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\` v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->ele( \`Page\`
            )->a( n = \`title\` v = client->_bind( mv_title )
        )->end( ).
    client->view_display( view->stringify( ) ).
  ENDMETHOD.
ENDCLASS.
`;
  const caller = `CLASS zcl_px_caller DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
ENDCLASS.

CLASS zcl_px_caller IMPLEMENTATION.
  METHOD z2ui5_if_app~main.
    DATA lo_popup TYPE REF TO zcl_px_popup.
    lo_popup ?= client->get_app( client->get( )-s_draft-id_prev_app ).
    DATA(lv_result) = lo_popup->ms_result.
  ENDMETHOD.
ENDCLASS.
`;
  const classIndex = LINTER_CLASS_INDEX_OF([popup, caller]);
  const file = "src/zcl_px_popup.clas.abap";
  const mine = runGate(popup, file, false, { ...OPTIONS, classIndex });
  const theirs = checkAbapSource(popup, { ...linterOptions(file), classIndex } as Parameters<
    typeof checkAbapSource
  >[1]);
  assert.deepEqual(reduce(mine.findings), reduce(theirs.findings));
  assert.ok(!mine.findings.some((f) => f.type === "unused-directive"), "the waiver is unjudged, not unused");
});
