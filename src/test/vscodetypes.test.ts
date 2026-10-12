import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/*
 * `@types/vscode` is pinned EXACTLY to the engine floor. `vsce package`
 * compares the two strings and refuses a typings version newer than
 * `engines.vscode`, so a drifted range does not produce a red test, it
 * produces an unpackageable extension (2026-09-01: ^1.134.0 against engines
 * ^1.101.0 broke `npm run vsix` on main). A caret range has the opposite
 * failure too: the lock resolved a newer .d.ts inside the range (1.134.0 for
 * a 1.101 floor), which lets the sources call an API the oldest supported
 * VS Code does not have - and only a user on that version would find out.
 * Hence the pin, and this test, which holds it to the floor so the two move
 * together, by hand, as one commit (see .github/dependabot.yml).
 */

const ROOT = path.join(__dirname, "..");
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const spec: string = pkg.devDependencies["@types/vscode"];
const engine: string = pkg.engines.vscode;
const locked = lock.packages["node_modules/@types/vscode"];

/** `^1.101.0` -> `1.101` - the oldest VS Code the extension declares it runs on. */
const floor = /^\^?(\d+\.\d+)\.\d+$/.exec(engine)?.[1];

test("@types/vscode is an exact version, not a range", () => {
  assert.match(
    spec,
    /^\d+\.\d+\.\d+$/,
    `"@types/vscode": "${spec}" - the typings are what the sources compile ` +
      "against, so the pin is exact; no ^, no ~"
  );
});

test("engines.vscode is a caret range over a full version", () => {
  assert.ok(floor, `engines.vscode is "${engine}" - expected ^<major>.<minor>.<patch>`);
});

test("the lock installs the typings of the engine floor", () => {
  assert.ok(locked, "package-lock.json has no entry for @types/vscode");
  assert.equal(locked.version, spec, "package.json and package-lock.json name different versions");
  assert.equal(
    String(locked.version).replace(/\.\d+$/, ""),
    floor,
    `@types/vscode ${locked.version} is not the engine floor (engines.vscode ${engine}) - ` +
      "the two move together, by hand, as one commit"
  );
});
