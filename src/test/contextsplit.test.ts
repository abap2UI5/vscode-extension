import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as context from "../context";
import * as names from "../contextnames";
import * as chain from "../contextchain";
import * as events from "../contextevents";
import * as xml from "../contextxml";

/*
 * `context.ts` is the module everybody imports from; its code lives in
 * `contextnames.ts`, `contextscan.ts`, `contextchain.ts`, `contextevents.ts`
 * and `contextxml.ts`. What the functions DO is `context.test.ts`'s subject -
 * this pins the split itself: the public face is unchanged, every name is the
 * part's own function, and no part reaches back into the facade.
 */

const ROOT = path.join(__dirname, "..");
const PARTS = [
  "contextnames",
  "contextscan",
  "contextchain",
  "contextevents",
  "contextxml",
];

/** The runtime exports `context.ts` had before it was split. */
const PUBLIC = [
  "ContainerStack",
  "DEFAULT_LIBRARY",
  "abapBindingContextAt",
  "abapContextAt",
  "abapNsMap",
  "bindArgumentAt",
  "bindableAttributes",
  "checkedEvents",
  "controlCallAt",
  "eventCaseRegion",
  "eventCaseRegions",
  "eventLiteralAt",
  "eventNameAt",
  "eventNameSpans",
  "eventRaises",
  "eventUsagesOf",
  "ownLevel",
  "splitName",
  "viewOutline",
  "whenBranchOf",
  "whenBranches",
  "whenLiteralAt",
  "whenNameAt",
  "xmlContextAt",
  "xmlNsMap",
  "xmlNsMapAt",
  "xmlScopedTags",
];

test("context.ts exports what it exported before the split, no more", () => {
  assert.deepEqual(Object.keys(context).sort(), PUBLIC);
});

test("every export of context.ts is the part's own", () => {
  const parts: Array<Record<string, unknown>> = [names, chain, events, xml];
  for (const name of PUBLIC) {
    const owners = parts.filter((part) => name in part);
    assert.equal(owners.length, 1, `${name} lives in exactly one part`);
    assert.equal(
      (context as Record<string, unknown>)[name],
      owners[0][name],
      name
    );
  }
});

test("the parts import neither the facade nor vscode", () => {
  for (const part of PARTS) {
    const text = fs.readFileSync(path.join(ROOT, "src", `${part}.ts`), "utf8");
    const imports = [...text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)].map(
      (m) => m[1]
    );
    assert.ok(!imports.includes("./context"), `${part}.ts imports context.ts`);
    assert.ok(!imports.includes("vscode"), `${part}.ts imports vscode`);
    for (const from of imports) {
      assert.ok(
        from === "./abapscan" || PARTS.includes(from.slice(2)),
        `${part}.ts imports ${from}`
      );
    }
  }
});

test("the parts are layered: names and scan at the bottom, no cycle", () => {
  const allowed: Record<string, string[]> = {
    contextnames: [],
    contextscan: ["./abapscan"],
    contextchain: ["./abapscan", "./contextnames", "./contextscan"],
    contextevents: ["./abapscan", "./contextscan"],
    contextxml: ["./contextnames"],
  };
  for (const part of PARTS) {
    const text = fs.readFileSync(path.join(ROOT, "src", `${part}.ts`), "utf8");
    const imports = [...text.matchAll(/^import\b[^;]*?from\s+"([^"]+)"/gm)]
      .map((m) => m[1])
      .sort();
    assert.deepEqual(imports, allowed[part], part);
  }
});
