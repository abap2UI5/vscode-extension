import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/*
 * The engine floor (`engines.vscode`) decides which hosts can install the
 * extension at all - Open VSX serves SAP Business Application Studio, Theia
 * and VSCodium, whose API level trails VS Code (ROADMAP T15). A contribution
 * point newer than the floor is ignored by an older host, and its runtime
 * API is missing there: such a point may only be added together with a
 * runtime guard, and with the floor in mind.
 *
 * So every key of `contributes` is classified here with the VS Code release
 * that made it stable. A new key fails until somebody classifies it; a key
 * above the floor fails until the floor moves; and a key whose API needs a
 * guard names the file and the guard that keeps an older host from throwing.
 */

const ROOT = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  engines: { vscode: string };
  contributes: Record<string, unknown>;
};

/** Contribution point -> the VS Code release it is stable in. The old ones
 *  are all far below any floor this extension will have; the two AI points
 *  are the reason this table exists. */
const STABLE_SINCE: Record<string, string> = {
  commands: "1.0.0",
  menus: "1.0.0",
  keybindings: "1.0.0",
  configuration: "1.0.0",
  snippets: "1.0.0",
  jsonValidation: "1.0.0",
  viewsContainers: "1.24.0",
  views: "1.24.0",
  submenus: "1.54.0",
  viewsWelcome: "1.44.0",
  walkthroughs: "1.60.0",
  // https://code.visualstudio.com/updates/v1_95 - "finalized our LanguageModelTool API"
  languageModelTools: "1.95.0",
  // https://code.visualstudio.com/updates/v1_101 - MCP server definition providers
  mcpServerDefinitionProviders: "1.101.0",
};

/** A point whose runtime API is newer than what every supported host has:
 *  the module that calls it, and the feature test it must contain. */
const GUARDED: Record<string, { file: string; guard: RegExp }> = {
  languageModelTools: { file: "src/chattoolsview.ts", guard: /typeof lm\?\.registerTool === "function"/ },
  mcpServerDefinitionProviders: {
    file: "src/mcp.ts",
    guard: /typeof vscode\.lm\?\.registerMcpServerDefinitionProvider !== "function"/,
  },
};

function parse(version: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  assert.ok(m, `not a version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atMost(a: string, b: string): boolean {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return x[i] < y[i];
    }
  }
  return true;
}

const FLOOR = pkg.engines.vscode.replace(/^[\^~>=\s]+/, "");

test("every contribution point is classified with the release it is stable in", () => {
  const unclassified = Object.keys(pkg.contributes).filter((key) => !(key in STABLE_SINCE));
  assert.deepEqual(
    unclassified,
    [],
    "classify the new contribution point in STABLE_SINCE - and check that the hosts on Open VSX have it"
  );
});

test("no contribution point is newer than the engine floor", () => {
  for (const key of Object.keys(pkg.contributes)) {
    assert.ok(
      atMost(STABLE_SINCE[key], FLOOR),
      `${key} is stable since ${STABLE_SINCE[key]}, above engines.vscode ${pkg.engines.vscode}`
    );
  }
});

test("a point whose API trails the hosts is called behind a runtime guard", () => {
  for (const [key, { file, guard }] of Object.entries(GUARDED)) {
    if (!(key in pkg.contributes)) {
      continue;
    }
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(text, guard, `${file} must feature-test the API behind ${key}`);
  }
  // the newest points are the ones that need one
  for (const [key, since] of Object.entries(STABLE_SINCE)) {
    if (key in pkg.contributes && !atMost(since, "1.90.0")) {
      assert.ok(key in GUARDED, `${key} (since ${since}) needs a GUARDED entry`);
    }
  }
});
