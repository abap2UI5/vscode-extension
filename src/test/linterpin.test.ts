import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/*
 * The bundled linter is the npm release `@abap2ui5/linter`, pinned EXACTLY,
 * and three places have to agree on which one: package.json (what a fresh
 * install reads), package-lock.json (what `npm ci` installs) and the
 * `linterRelease` record in package.json, which names the commit that
 * version was published from - the only handle on the render-gate bundle,
 * since the linter publishes those per commit and the npm tarball carries no
 * commit (esbuild.js, `linterPin()`).
 *
 * `bump-linter.yml` moves all three together. A hand-made bump moves the
 * first two and forgets the third, and nothing else would notice: esbuild.js
 * refuses to stamp a record that lags behind the lock, so the render gate
 * would silently fall back to the rolling tag - the very thing the per-commit
 * bundle exists to prevent. Hence this test, which is also where the stamps
 * themselves are checked: `process.env.LINTER_PIN` and `LINTER_COMMIT` below
 * are build-time defines, so this suite sees exactly what the extension
 * bundle sees.
 */

const ROOT = path.join(__dirname, "..");
const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const spec: string = pkg.devDependencies["@abap2ui5/linter"];
const locked = lock.packages["node_modules/@abap2ui5/linter"];
const release = pkg.linterRelease;

test("the linter is an exact npm version, not a git spec or a range", () => {
  assert.match(
    spec,
    /^\d+\.\d+\.\d+$/,
    `"@abap2ui5/linter": "${spec}" - the bundle ships this release, so the ` +
      "pin is exact; no ^, no ~, no github:"
  );
});

test("the lock installs that version from the npm registry", () => {
  assert.ok(locked, "package-lock.json has no entry for @abap2ui5/linter");
  assert.equal(locked.version, spec, "package.json and package-lock.json name different versions");
  assert.match(
    String(locked.resolved),
    /^https:\/\/registry\.npmjs\.org\/@abap2ui5\/linter\/-\/linter-\d+\.\d+\.\d+\.tgz$/,
    "the lock resolves the linter somewhere other than the npm registry"
  );
  assert.match(String(locked.integrity), /^sha512-/, "the lock carries no integrity hash");
});

test("linterRelease names the release commit of exactly that version", () => {
  assert.ok(release, "package.json has no linterRelease record");
  assert.equal(
    release.version,
    spec,
    `linterRelease.version is ${release?.version}, the devDependency is ${spec} - ` +
      "the record lags behind the bump; take the commit from " +
      `\`npm view @abap2ui5/linter@${spec} gitHead\``
  );
  assert.match(
    String(release.commit),
    /^[0-9a-f]{40}$/,
    "linterRelease.commit is not a full lowercase SHA"
  );
});

test("what is installed is what the manifests say", () => {
  const installed = readJson("node_modules/@abap2ui5/linter/package.json");
  assert.equal(installed.version, spec, "node_modules holds a different linter - run npm ci");
});

test("esbuild stamps the version and the commit into the bundle", () => {
  assert.equal(process.env.LINTER_PIN, spec, "LINTER_PIN is not the bundled version");
  assert.equal(
    process.env.LINTER_COMMIT,
    release.commit,
    "LINTER_COMMIT is not the recorded release commit - esbuild.js stamps it " +
      "only while linterRelease.version matches the lock"
  );
});
