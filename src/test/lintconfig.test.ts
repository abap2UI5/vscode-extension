import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyBaselineTo,
  clearConfigCache,
  describeOptions,
  resolveOptions,
} from "../lintconfig";
import type { PropertyFinding } from "@abap2ui5/linter/properties";

const SETTINGS = { minUi5: "1.71", distribution: "sapui5", allow: ["sap.m.X.y"] };

/** A throwaway workspace with one config file in it. */
function workspace(config?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap2ui5-lintconfig-"));
  if (config !== undefined) {
    fs.writeFileSync(path.join(dir, "abap2ui5lint.jsonc"), config);
  }
  clearConfigCache();
  return dir;
}

test("without a config file the VS Code settings are used as they are", () => {
  const options = resolveOptions(workspace(), SETTINGS);
  assert.equal(options.minUi5, "1.71");
  assert.equal(options.configFile, undefined);
  assert.match(describeOptions(options), /VS Code settings/);
});

test("the repo config wins - that is what CI checks against", () => {
  const dir = workspace(`{
    // the floor this repository pins
    "ui5": "1.120",
    "distribution": "openui5",
  }`);
  const options = resolveOptions(dir, SETTINGS);
  assert.equal(options.minUi5, "1.120");
  assert.equal(options.distribution, "openui5");
  assert.match(describeOptions(options), /OpenUI5 1\.120/);
});

test("the allow lists merge, because both allowances are meant", () => {
  const dir = workspace('{ "allow": ["sap.m.GenericTile.systemInfo"] }');
  const options = resolveOptions(dir, SETTINGS);
  assert.deepEqual(options.allow.sort(), [
    "sap.m.GenericTile.systemInfo",
    "sap.m.X.y",
  ]);
});

test("a rules block is handed through for the severity overrides", () => {
  const dir = workspace('{ "rules": { "missing-accessibility": false } }');
  const options = resolveOptions(dir, SETTINGS);
  assert.deepEqual(options.rules, { "missing-accessibility": false });
});

test("the config is discovered from a subdirectory upward", () => {
  const dir = workspace('{ "ui5": "1.108" }');
  const nested = path.join(dir, "src", "z2ui5");
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(resolveOptions(nested, SETTINGS).minUi5, "1.108");
});

test("a baseline path resolves against the config file, like the CLI", () => {
  const dir = workspace('{ "baseline": "lint/baseline.json" }');
  const options = resolveOptions(dir, SETTINGS);
  assert.equal(options.baseline, path.join(dir, "lint", "baseline.json"));
});

test("a baseline that is not a path is a typo, not a crash", () => {
  // `"baseline": true` fed to path.resolve would throw out of resolveOptions,
  // which the live check calls on every keystroke with nothing to catch it
  const dir = workspace('{ "baseline": true }');
  const options = resolveOptions(dir, SETTINGS);
  assert.equal(options.baseline, undefined);
});

test("an unrecognised distribution is echoed as written", () => {
  // this line exists for diagnosing editor/CI disagreement - a typo mapped
  // to "SAPUI5" hides exactly the mistake being looked for
  assert.match(
    describeOptions({ minUi5: "1.71", distribution: "openui", allow: [] }),
    /target openui 1\.71/
  );
});

test("baselined findings are dropped, new ones stay", () => {
  const dir = workspace();
  const source = path.join(dir, "zcl_app.clas.abap");
  fs.writeFileSync(
    path.join(dir, "baseline.json"),
    JSON.stringify({
      findings: { "zcl_app.clas.abap|unknown-control|sap.m.Buton||": 1 },
    })
  );
  const findings: PropertyFinding[] = [
    { type: "unknown-control", control: "sap.m.Buton" },
    { type: "unknown-control", control: "sap.m.Inptu" },
  ];
  const suppressed = applyBaselineTo(
    findings,
    path.join(dir, "baseline.json"),
    source
  );
  assert.equal(suppressed, 1);
  assert.deepEqual(
    findings.map((f) => f.control),
    ["sap.m.Inptu"]
  );
});

test("one check must not eat the baseline budget of the next", () => {
  const dir = workspace();
  const source = path.join(dir, "zcl_app.clas.abap");
  const baseline = path.join(dir, "baseline.json");
  fs.writeFileSync(
    baseline,
    JSON.stringify({
      findings: { "zcl_app.clas.abap|unknown-control|sap.m.Buton||": 1 },
    })
  );
  const finding = (): PropertyFinding[] => [
    { type: "unknown-control", control: "sap.m.Buton" },
  ];
  // the same keystroke-check runs over and over - the cached map is copied,
  // so the count covers the finding on EVERY run, not only the first
  assert.equal(applyBaselineTo(finding(), baseline, source), 1);
  assert.equal(applyBaselineTo(finding(), baseline, source), 1);
});

test("an unreadable baseline suppresses nothing", () => {
  const dir = workspace();
  const source = path.join(dir, "zcl_app.clas.abap");
  const baseline = path.join(dir, "baseline.json");
  fs.writeFileSync(baseline, "not json");
  const findings: PropertyFinding[] = [
    { type: "unknown-control", control: "sap.m.Buton" },
  ];
  assert.equal(applyBaselineTo(findings, baseline, source), 0);
  assert.equal(findings.length, 1);
});

test("a broken config is reported, not silently ignored", () => {
  const dir = workspace('{ "ui5": "not-a-version" }');
  const options = resolveOptions(dir, SETTINGS);
  assert.ok(options.error, "expected the parse error to be carried");
  assert.equal(options.minUi5, "1.71", "falls back to the settings");
  assert.match(describeOptions(options), /unreadable/);
});

test("a change in an extended base config is noticed without touching the extending file", () => {
  /* The memo used to be keyed on the DISCOVERED file's mtime alone. A repo
   * whose abap2ui5lint.jsonc extends a shared base took the base's floor, and
   * an edit to that base - the file CI reads through the same chain - changed
   * nothing in the editor until the extending file was touched or the window
   * reloaded. The chain's mtimes are part of the key now. */
  const dir = workspace('{ "extends": "./shared/base.jsonc" }');
  fs.mkdirSync(path.join(dir, "shared"));
  const base = path.join(dir, "shared", "base.jsonc");
  fs.writeFileSync(base, '{ "ui5": "1.108" }');
  assert.equal(resolveOptions(dir, SETTINGS).minUi5, "1.108");
  fs.writeFileSync(base, '{ "ui5": "1.120" }');
  // an explicit mtime: a filesystem with one-second stamps would otherwise
  // report the same one for a write this close to the read
  const later = new Date(Date.now() + 5_000);
  fs.utimesSync(base, later, later);
  assert.equal(resolveOptions(dir, SETTINGS).minUi5, "1.120");
});

test("an unset distribution is described as undecided, not as a distribution", () => {
  assert.match(
    describeOptions({ minUi5: "1.71", distribution: null, allow: [] }),
    /target UI5 \(distribution not set\) 1\.71/
  );
});
