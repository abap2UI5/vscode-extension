import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { checkAbapRules } from "@abap2ui5/linter/abap-rules";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { annotate, severityOf } from "@abap2ui5/linter/findings";
import { runGate } from "../gate";
import { snapshot } from "../snapshot";
import { usesBuilder } from "../abap";
import { APP_TEMPLATE, APP_TEMPLATES, templateSource } from "../template";
import { clientMethod } from "../clientapi";

/*
 * Every piece of ABAP the extension SHIPS - the snippets and the app
 * template - must pass the extension's own linter. This is the gate that
 * was missing when a snippet shipped `_bind_edit`: the method exists and
 * its parameters were right, but the linter's `obsolete-binder` rule (the
 * ecosystem convention) said otherwise, and nothing automated asked it.
 * Hand-written ABAP that goes out to users is corpus too.
 */

const SNIPPETS_FILE = path.join(
  __dirname,
  "..",
  "snippets",
  "abap2ui5.code-snippets"
);

interface Snippet {
  prefix: string;
  body: string[];
}

function loadSnippets(): Snippet[] {
  const raw = JSON.parse(fs.readFileSync(SNIPPETS_FILE, "utf8")) as Record<
    string,
    Snippet
  >;
  return Object.values(raw);
}

/** A snippet body as the editor would insert it: first choice for choices,
 *  the default text for placeholders, nothing for bare tab stops. */
function expand(body: string[]): string {
  return body
    .join("\n")
    .replace(/\$\{\d+\|([^|]*)\|\}/g, (_, choices: string) => choices.split(",")[0])
    .replace(/\$\{\d+:([^}]*)\}/g, "$1")
    .replace(/\$\{\d+\}/g, "")
    .replace(/\$\d+/g, "")
    // the snippet grammar's escapes: `\$`, `\}` and `\\` stand for the
    // character itself (a `\${KEY}` body inserts the literal `${KEY}` an
    // expression-binding argument is written as)
    .replace(/\\([$}\\])/g, "$1")
    // A tab stop alone on its line (`    $0` - where the editor puts the
    // cursor) leaves its indentation behind. That is a caret position, not
    // shipped text, so it is not the snippet's trailing whitespace; trailing
    // whitespace AFTER content still is, and still fails.
    .replace(/^[ \t]+$/gm, "");
}

/** The attributes the snippet defaults reference, so the binding rules can
 *  resolve them instead of reporting the scaffold. */
const SCAFFOLD_HEAD = `CLASS zcl_snippet DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES z2ui5_if_app.
    TYPES: BEGIN OF ty_s_row,
             field TYPE string,
           END OF ty_s_row.
    DATA mt_data TYPE STANDARD TABLE OF ty_s_row WITH EMPTY KEY.
    DATA mv_value TYPE string.
    DATA mv_flag TYPE abap_bool.
ENDCLASS.
CLASS zcl_snippet IMPLEMENTATION.`;

const SCAFFOLD_FOOT = `ENDCLASS.`;

/** A source as a FILE on disk would hold it - the linter's abapGit
 *  round-trip rules judge a file, and a wrapper without a final newline would
 *  report the harness rather than the snippet. */
const file = (source: string): string => `${source}\n`;

/** The body of a snippet, indented into the scaffold's method - an empty line
 *  stays empty, because indenting it would be trailing whitespace the linter's
 *  abapGit round-trip rules (rightly) report on the wrapper, not the snippet. */
const indent = (expanded: string, pad = "    "): string =>
  expanded
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : `${pad}${line}`))
    .join("\n");

/** A snippet meant for the `*.clas.testclasses.abap` include: local test
 *  classes that make up a whole file by themselves, not a piece of an app
 *  class. Recognised by the `FOR TESTING` no other snippet writes - such a
 *  snippet is checked as the file it is, never wrapped into a class. */
const isTestClasses = (expanded: string): boolean =>
  /\bFOR TESTING\b/i.test(expanded);

/** Wraps one expanded snippet into a complete class file, by its shape - a
 *  FILE, ending in a newline: the linter judges what it is handed, and a
 *  wrapper missing one would report the harness rather than the snippet. */
function wrap(expanded: string): string {
  if (isTestClasses(expanded)) {
    return file(expanded); // a whole testclasses include (z2ui5test)
  }
  if (/^CLASS\b/i.test(expanded)) {
    return file(expanded); // already a whole class (z2ui5app)
  }
  if (/^METHOD\b/i.test(expanded)) {
    // a whole method (z2ui5main)
    return file(`${SCAFFOLD_HEAD}\n${expanded}\n${SCAFFOLD_FOOT}`);
  }
  if (/^(ele|tag|a)\(/i.test(expanded)) {
    // a chain fragment - inserted where the corpus inserts it: after `)->`
    // inside a view being built, one level below the Page it lands in. The
    // editor prepends the cursor line's indentation to every continuation
    // line, so the fragment is indented the same way here - and the wrapper
    // itself is in the house layout, so `chain-house-layout` judges the
    // snippet, not the harness. The fragment's last line is the `)` the
    // user continues from; the wrapper ends the statement there.
    return file(`${SCAFFOLD_HEAD}
  METHOD z2ui5_if_app~main.

    DATA(view) = z2ui5_cl_ui5_view_builder=>factory( ).
    view->ele( n = \`View\` ns = \`mvc\`
        )->a( n = \`xmlns\`     v = \`sap.m\`
        )->a( n = \`xmlns:mvc\` v = \`sap.ui.core.mvc\`
        )->ele( n = \`Page\`
            )->${indent(expanded, "            ")}.

    client->view_display( view->stringify( ) ).

  ENDMETHOD.
${SCAFFOLD_FOOT}`);
  }
  // whole statements (toast, popup, nav, the CASE dispatcher, the waiver) -
  // inserted where such a statement is written, INSIDE the event branch. The
  // top level of `main( )` would be a placement the snippet does not choose
  // and the linter rightly reports (a popup built there is rebuilt on every
  // roundtrip: `unconditional-popup-display`), so wrapping them there would
  // fail the harness's own choice rather than the shipped text.
  return file(`${SCAFFOLD_HEAD}
  METHOD z2ui5_if_app~main.
    IF client->check_on_event( ).
      ${indent(expanded, "      ")}
    ENDIF.
  ENDMETHOD.
${SCAFFOLD_FOOT}`);
}

/** The house layout is opt-in in the linter (it encodes one house style),
 *  so it is switched on here the way `chainformat.ts` switches it on for
 *  Format Document: a snippet whose chain Format Document would rewrite has
 *  drifted from what the editor itself teaches. */
const LAYOUT_RULES = { "chain-house-layout": "warning" };

/** error/warning findings of a wrapped source - hints (advisories like
 *  missing-accessibility) do not fail a snippet, exactly as they do not
 *  fail CI. */
function gatingFindings(source: string): string[] {
  const data = snapshot();
  const findings: PropertyFinding[] = usesBuilder(source)
    ? runGate(source, "zcl_snippet.clas.abap", false, {
        minUi5: "1.71",
        distribution: "sapui5",
        allow: [],
        rules: LAYOUT_RULES,
      }).findings
    : annotate(checkAbapRules(source, { data, rules: LAYOUT_RULES }), source);
  return findings
    .filter((f) => (f.severity ?? severityOf(f)) !== "hint")
    .map((f) => `${f.type} (${f.member ?? f.value ?? f.control ?? ""})`);
}

test("every shipped snippet passes the bundled linter", () => {
  for (const snippet of loadSnippets()) {
    const findings = gatingFindings(wrap(expand(snippet.body)));
    assert.deepEqual(
      findings,
      [],
      `snippet ${snippet.prefix} does not pass the linter it ships with`
    );
  }
});

test("the test-class snippet is a complete testclasses include", () => {
  // abaplint is not part of this suite, so the contract is held here: the
  // pieces a *.clas.testclasses.abap needs, consistent with the app
  // template's lifecycle (main dispatches on the client's check_on_* reads).
  const snippet = loadSnippets().find((s) => s.prefix === "z2ui5test");
  assert.ok(snippet, "the z2ui5test snippet went missing");
  const expanded = expand(snippet.body);
  assert.ok(isTestClasses(expanded));
  assert.ok(
    loadSnippets().filter((s) => isTestClasses(expand(s.body))).length === 1,
    "only the test-class snippet is checked as a whole file"
  );
  // the double: the client interface, partially, answering the lifecycle
  // reads from attributes and recording what the app displays
  assert.match(expanded, /^CLASS ltd_client DEFINITION FINAL FOR TESTING\.$/m);
  assert.match(expanded, /INTERFACES z2ui5_if_client PARTIALLY IMPLEMENTED\./);
  for (const method of [
    "check_on_init",
    "check_on_navigated",
    "check_on_event",
    "get_event",
    "view_display",
    "message_toast_display",
  ]) {
    assert.match(
      expanded,
      new RegExp(`METHOD z2ui5_if_client~${method}\\.`),
      `the double does not implement ${method}`
    );
    assert.ok(
      clientMethod(method) && !clientMethod(method)?.obsolete,
      `${method} is not a current z2ui5_if_client method`
    );
  }
  // the parameter names the double reads are the interface's own
  assert.match(clientMethod("check_on_event")?.signature ?? "", /\bval\b/);
  assert.match(clientMethod("view_display")?.signature ?? "", /\bval\b/);
  assert.match(clientMethod("message_toast_display")?.signature ?? "", /\btext\b/);
  // the test class and its one test
  assert.match(
    expanded,
    /^CLASS ltcl_app DEFINITION FINAL FOR TESTING RISK LEVEL HARMLESS DURATION SHORT\.$/m
  );
  assert.match(expanded, /METHODS \w+ FOR TESTING RAISING cx_static_check\./);
  assert.match(expanded, /client->mv_event = `BUTTON_CLICK`\./);
  assert.match(expanded, /app->z2ui5_if_app~main\( client \)\./);
  assert.match(expanded, /cl_abap_unit_assert=>assert_equals\(/);
  // every class opened is closed, every method too
  const count = (re: RegExp) => (expanded.match(re) ?? []).length;
  assert.equal(count(/^CLASS\b/gm), count(/^ENDCLASS\./gm));
  assert.equal(count(/^\s*METHOD\b/gm), count(/^\s*ENDMETHOD\./gm));
  // and the linter's ABAP rules see a clean file
  assert.deepEqual(gatingFindings(wrap(expanded)), []);
});

test("the app template passes the bundled linter", () => {
  const findings = gatingFindings(APP_TEMPLATE);
  assert.deepEqual(findings, []);
});

test("every gallery template passes the bundled linter", () => {
  for (const template of APP_TEMPLATES) {
    const findings = gatingFindings(templateSource(template, "zcl_wizard"));
    assert.deepEqual(
      findings,
      [],
      `template "${template.label}" does not pass the linter it ships with`
    );
  }
});

test("the wizard renames the class everywhere", () => {
  for (const template of APP_TEMPLATES) {
    const renamed = templateSource(template, "ZCL_RENAMED");
    assert.ok(!/zcl_my_app/i.test(renamed));
    assert.match(renamed, /CLASS zcl_renamed DEFINITION PUBLIC/);
  }
});

/** Paren balance with ABAP literals (`…`, '…'), templates (|…|) and
 *  line comments (") blanked - chain style demands a net of zero. */
function parenBalance(source: string): number {
  let depth = 0;
  for (const line of source.split("\n")) {
    let i = 0;
    while (i < line.length) {
      const c = line[i];
      if (c === "`" || c === "'" || c === "|") {
        const close = line.indexOf(c, i + 1);
        i = close < 0 ? line.length : close + 1;
        continue;
      }
      if (c === '"') {
        break; // comment to end of line
      }
      if (c === "(") {
        depth++;
      } else if (c === ")") {
        depth--;
      }
      i++;
    }
  }
  return depth;
}

test("every shipped chain balances its parentheses", () => {
  // The linter's reconstruction scan tolerates an unbalanced chain - real
  // ABAP does not. z2ui5table shipped one for a while; this pins it down.
  for (const snippet of loadSnippets()) {
    assert.equal(
      parenBalance(wrap(expand(snippet.body))),
      0,
      `snippet ${snippet.prefix} has unbalanced parentheses`
    );
  }
  for (const template of APP_TEMPLATES) {
    assert.equal(
      parenBalance(template.source),
      0,
      `template "${template.label}" has unbalanced parentheses`
    );
  }
});

test("no shipped ABAP calls a method the interface marks obsolete", () => {
  // the linter catches _bind_edit specifically; this catches the whole
  // class of mistake - any client-> call whose abapdoc says obsolete
  const sources = [
    APP_TEMPLATE,
    ...APP_TEMPLATES.map((t) => t.source),
    ...loadSnippets().map((s) => expand(s.body)),
  ];
  for (const source of sources) {
    for (const m of source.matchAll(/client->(\w+)\s*\(/gi)) {
      const method = clientMethod(m[1]);
      assert.ok(
        !method?.obsolete,
        `shipped ABAP calls client->${m[1]}, which the interface marks obsolete`
      );
    }
  }
});
