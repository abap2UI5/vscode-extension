import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { abapSpans, abapStatements, blankNonCode, declaredNames } from "../abapscan";
import { appClassInfoOf, isAppClass, superclassOf } from "../abap";
import { parseXml, xmlToAbap } from "../xmltoabap";
import { expandAbbreviation, parseAbbreviation } from "../abbreviation";
import { attributeSpans, declaredIds, idLiterals, idSpans } from "../renamewires";
import { navCallsOf, navGraph, navTargetsOf } from "../navmap";
import { chainFormatEdits } from "../chainformat";
import { abapNsMap, viewOutline } from "../context";
import { APP_TEMPLATES, templateSource } from "../template";
import { TEMPLATE_FILES } from "../scaffold";

/*
 * The readers run on every pause in typing, so a half-written class is not an
 * edge case - it is the normal input. A throw in one of them is a feature that
 * stops working with a stack trace in the log and no diagnostic on screen,
 * which is strictly worse than an empty answer. The linter's suite fuzzes its
 * own readers the same way; this is the editor-side half.
 */

/** Deterministic, so a failure is reproducible from the seed alone. */
let rnd = 20260904;
const next = (): number => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function mutants(src: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 12; i++) {
    out.push(src.slice(0, Math.floor((src.length * i) / 13)));
  }
  for (let i = 0; i < 6; i++) {
    const at = Math.floor(next() * src.length);
    out.push(src.slice(0, at) + src.slice(at + 1));
    out.push(src.slice(0, at) + src[at] + src.slice(at));
  }
  for (const ch of ["(", ")", "`", "|", "'", ".", "<", ">", '"']) {
    out.push(src.slice(0, Math.floor(next() * src.length)) + ch
      + src.slice(Math.floor(next() * src.length)));
  }
  return out;
}

/** Every piece of ABAP the extension itself ships: the gallery templates, the
 *  app-template's own classes, and each snippet expanded the way the editor
 *  inserts it. Shipped ABAP is the right seed - it is the shape a user's file
 *  has a second after they take one of these. */
function abapSeeds(): { name: string; text: string }[] {
  const seeds = APP_TEMPLATES.map((t) => ({
    name: `template:${t.label}`,
    text: templateSource(t, "zcl_seed"),
  }));
  for (const [name, text] of Object.entries(TEMPLATE_FILES)) {
    if (name.endsWith(".abap")) {
      seeds.push({ name, text });
    }
  }
  const snippets = path.join(__dirname, "..", "snippets", "abap2ui5.code-snippets");
  if (fs.existsSync(snippets)) {
    const all = JSON.parse(fs.readFileSync(snippets, "utf8")) as Record<
      string,
      { prefix: string; body: string[] }
    >;
    for (const [title, snippet] of Object.entries(all)) {
      seeds.push({
        name: `snippet:${snippet.prefix}`,
        // as the editor leaves it: first choice, placeholder default, tab stops gone
        text: snippet.body
          .join("\n")
          .replace(/\$\{\d+\|([^|]*)\|\}/g, (_, choices: string) => choices.split(",")[0])
          .replace(/\$\{\d+:([^}]*)\}/g, "$1")
          .replace(/\$\{\d+\}/g, "")
          .replace(/\$\d+/g, "")
          + `   " ${title}`,
      });
    }
  }
  return seeds;
}

test("every ABAP reader answers a half-written class instead of throwing", () => {
  let checked = 0;
  for (const seed of abapSeeds()) {
    for (const m of mutants(seed.text)) {
      checked++;
      const readers: [string, () => unknown][] = [
        ["abapSpans", () => abapSpans(m)],
        ["blankNonCode", () => blankNonCode(m)],
        ["abapStatements", () => abapStatements(m)],
        ["declaredNames", () => declaredNames(m)],
        ["isAppClass", () => isAppClass(m)],
        ["superclassOf", () => superclassOf(m)],
        ["appClassInfoOf", () => appClassInfoOf(m)],
        ["abapNsMap", () => abapNsMap(m)],
        ["viewOutline", () => viewOutline(m)],
        ["idLiterals", () => idLiterals(m)],
        ["declaredIds", () => declaredIds(m)],
        ["idSpans", () => idSpans(m, "page")],
        ["attributeSpans", () => attributeSpans(m, "text")],
        ["navCallsOf", () => navCallsOf(m)],
        ["navTargetsOf", () => navTargetsOf(m)],
        ["navGraph", () => navGraph([{ fileName: "zcl_a.clas.abap", source: m }])],
        ["chainFormatEdits", () => chainFormatEdits(m)],
      ];
      for (const [name, run] of readers) {
        try {
          run();
        } catch (e) {
          assert.fail(
            `${name} on ${seed.name} mutant (${m.length} chars) threw: `
            + `${(e as Error).message.slice(0, 140)}`
          );
        }
      }
    }
  }
  assert.ok(checked > 400, `enough mutants to mean something (${checked})`);
});

test("the XML converter answers malformed markup instead of throwing", () => {
  const seed = `<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc">
  <Page title="Hi" showNavButton="true">
    <content>
      <Text text="{/NAME}"/>
      <Button text="Go" press=".onGo"/>
      <List items="{/ROWS}"><StandardListItem title="{TITLE}"/></List>
    </content>
  </Page>
</mvc:View>`;
  let checked = 0;
  for (const m of mutants(seed)) {
    checked++;
    try {
      parseXml(m);
      xmlToAbap(m);
    } catch (e) {
      assert.fail(`XML mutant (${m.length} chars) threw: ${(e as Error).message.slice(0, 140)}`);
    }
  }
  assert.ok(checked > 20, `enough mutants to mean something (${checked})`);
});

test("the abbreviation parser answers nonsense instead of throwing", () => {
  const seeds = [
    "Page>VBox>Text*3",
    "Table[items={/ROWS}]>columns>Column>Text{Header}",
    "VBox>(Label+Input)*2",
    "Button[text=Go press=ON_GO]",
  ];
  let checked = 0;
  for (const seed of seeds) {
    for (const m of mutants(seed)) {
      checked++;
      try {
        parseAbbreviation(m);
        expandAbbreviation(m, "    ", true);
        expandAbbreviation(m, "  ", false);
      } catch (e) {
        assert.fail(`abbreviation "${m}" threw: ${(e as Error).message.slice(0, 140)}`);
      }
    }
  }
  assert.ok(checked > 60, `enough mutants to mean something (${checked})`);
});
