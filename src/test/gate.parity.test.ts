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

/* The ONE difference that is known and not yet closable here: `checkXmlSource`
 * runs `checkIcons` over the raw XML, and the linter does not export that
 * function through any subpath in `exports`, so the gate cannot call it. The
 * ABAP path is unaffected - `checkAbapRules` runs the icon scan itself. See
 * the test below, which fails the moment the export exists. */
const ICON_RULES = new Set(["unknown-icon", "icon-too-new", "icon-removed"]);
const withoutIcons = (findings: Reduced[]): Reduced[] =>
  findings.filter((f) => !ICON_RULES.has(f.type));

for (const [name, xml] of Object.entries(XML_FIXTURES)) {
  test(`the gate agrees with checkXmlSource - ${name}`, () => {
    const file = "src/view.view.xml";
    const mine = runGate(xml, file, true, OPTIONS);
    const theirs = checkXmlSource(xml, linterOptions(file));
    assert.deepEqual(
      withoutIcons(reduce(mine.findings)),
      withoutIcons(reduce(theirs.findings)),
      "gate.ts and checkXmlSource disagree"
    );
  });
}

test("KNOWN GAP: the XML path cannot run the icon rules yet", () => {
  /*
   * Delete this test - and the `withoutIcons` filter above - as soon as it
   * fails. It fails when `@abap2ui5/linter` starts exporting `checkIcons`
   * through its `exports` map (there is no other way to reach `lib/icons.mjs`
   * from here), at which point `gate.ts` should call it on the XML branch the
   * way `checkXmlSource` does, and the parity assertions above cover it with
   * no filter.
   *
   * Until then this is what the difference IS, written down: an unknown icon
   * in a `.view.xml` is reported by CI and not by the editor. In an ABAP
   * class - which is what the extension is mostly pointed at - it is reported
   * by both.
   */
  const xml =
    '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n' +
    '  <Button text="Go" icon="sap-icon://nosuchicon"/>\n' +
    "</mvc:View>";
  const file = "src/view.view.xml";
  const cli = checkXmlSource(xml, linterOptions(file));
  const gate = runGate(xml, file, true, OPTIONS);

  assert.ok(
    cli.findings.some((f) => f.type === "unknown-icon"),
    "the linter stopped reporting unknown-icon for XML - the gap may be gone"
  );
  assert.equal(
    gate.findings.some((f) => ICON_RULES.has(f.type)),
    false,
    "the gate now reports icon findings for XML - close the gap: drop the " +
      "withoutIcons filter above and delete this test"
  );

  // and the ABAP side really is covered, so the gap is XML-only
  const abap = runGate(
    ABAP_FIXTURES["an icon that is in no release"],
    "src/zcl_parity.clas.abap",
    false,
    OPTIONS
  );
  assert.ok(
    abap.findings.some((f) => f.type === "unknown-icon"),
    "the ABAP path lost the icon rules too - that one is fixable here"
  );
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
});
