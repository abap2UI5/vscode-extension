import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { checkAbapSource, checkXmlSource } from "@abap2ui5/linter";
import { runGate } from "../gate";
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
 *  linter's to word; type, place and subject are the verdict. */
interface Reduced {
  type: string;
  offset?: number;
  control?: string;
  member?: string;
  value?: string;
  severity?: string;
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

const XML_FIXTURES: Record<string, string> = {
  clean: '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n  <Button text="Go"/>\n</mvc:View>',
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
