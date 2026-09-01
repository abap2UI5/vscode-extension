import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/*
 * The settings reference in README.md is generated from
 * `contributes.configuration` (scripts/generate-settings.mjs). Unlike the
 * three snapshots in src/data/, BOTH sides live in this repository, so the
 * drift gate can run in `npm test` itself: a new, renamed or reworded
 * setting fails here until `npm run settings` has moved the README with it.
 */

const ROOT = path.join(__dirname, "..");

test("the README's settings reference matches contributes.configuration", () => {
  try {
    execFileSync(
      process.execPath,
      [path.join(ROOT, "scripts", "generate-settings.mjs"), "--check"],
      { cwd: ROOT, stdio: "pipe" }
    );
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? String(err);
    assert.fail(stderr.trim() || "generate-settings --check failed");
  }
});

test("every contributed setting appears in the README table", () => {
  // the generator could pass --check against a table that lists nothing -
  // this holds the rendered README to the manifest's setting ids directly
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8")
  ) as {
    contributes: { configuration: { properties: Record<string, unknown> } };
  };
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const ids = Object.keys(manifest.contributes.configuration.properties);
  assert.ok(ids.length >= 10, "the configuration section went missing");
  for (const id of ids) {
    assert.ok(
      readme.includes(`| \`${id}\` |`),
      `${id} is missing from the README settings table - run npm run settings`
    );
  }
});
