import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/*
 * The command reference in README.md is generated from `contributes.commands`
 * (scripts/generate-commands.mjs), and gated here for the same reason the
 * settings reference is: both sides live in this repository, so a command
 * renamed, retitled or added fails in `npm test` until `npm run commands` has
 * moved the README with it.
 *
 * Why the README carries one at all: abap2UI5/docs sends the reader here for
 * it — "the full settings and command tables are in the repository README" —
 * and before this the command half of that sentence pointed at nothing. 43
 * commands, one of them named anywhere in the file.
 */

const ROOT = path.join(__dirname, "..");

test("the README's command reference matches contributes.commands", () => {
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts", "generate-commands.mjs"), "--check"],
      { cwd: ROOT, stdio: "pipe" }
    );
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    assert.fail(stderr.trim() || "generate-commands --check failed");
  }
});

test("every contributed command appears in the README table", () => {
  // the generator could pass --check against a table that lists nothing -
  // this holds the rendered README to the manifest's command ids directly
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  ) as { contributes: { commands: { command: string }[] } };
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const ids = manifest.contributes.commands.map((c) => c.command);
  assert.ok(ids.length >= 20, "the commands section went missing");
  for (const id of ids) {
    assert.ok(
      readme.includes(`\`${id}\``),
      `${id} is missing from the README command table - run npm run commands`
    );
  }
});

test("a command whose key the manifest binds shows that key", () => {
  // the two chords the manual leads with, F9 and Ctrl+F3, are the reason the
  // table has a Key column at all - an empty one would be a table of names
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /\| `abap2ui5\.run` \| `f9` \|/);
  assert.match(readme, /\| `abap2ui5\.activate` \| `ctrl\+f3` \/ `cmd\+f3` \|/);
});
