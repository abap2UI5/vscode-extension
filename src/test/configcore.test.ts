import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyBaselineMap,
  dirOf,
  joinPath,
  nearestConfig,
  optionsFromConfig,
  parseBaseline,
  parseLintConfig,
} from "../configcore";
import { findingKey } from "@abap2ui5/linter/baseline";

/*
 * What an abap2ui5lint.jsonc means for a check - the half both builds share.
 * The desktop reads the file with `fs` and the web through workspace.fs; if
 * these decisions ever differed, the editor in a browser would check against
 * something CI does not, which is the defect the module exists to prevent.
 */

const SETTINGS = { minUi5: "1.71", distribution: "sapui5", allow: ["sap.m.X.y"] };

test("the repo config wins where it speaks, the settings fill in the rest", () => {
  const options = optionsFromConfig(
    { ui5: "1.120", rules: { "duplicate-id": false } },
    "/repo/abap2ui5lint.jsonc",
    SETTINGS
  );
  assert.equal(options.minUi5, "1.120");
  assert.equal(options.distribution, "sapui5"); // untouched by the config
  assert.deepEqual(options.rules, { "duplicate-id": false });
  assert.equal(options.configFile, "/repo/abap2ui5lint.jsonc");
});

test("the two allow lists merge rather than one replacing the other", () => {
  const options = optionsFromConfig(
    { allow: ["sap.m.GenericTile.systemInfo", "sap.m.X.y"] },
    "/repo/abap2ui5lint.jsonc",
    SETTINGS
  );
  assert.deepEqual(options.allow.sort(), ["sap.m.GenericTile.systemInfo", "sap.m.X.y"]);
});

test("a baseline is resolved against the config file, not the workspace root", () => {
  const options = optionsFromConfig(
    { baseline: "baseline.json" },
    "/repo/apps/travel/abap2ui5lint.jsonc",
    SETTINGS
  );
  assert.equal(options.baseline, "/repo/apps/travel/baseline.json");
  assert.equal(
    optionsFromConfig({ baseline: "../shared/base.json" }, "/repo/apps/abap2ui5lint.json", SETTINGS)
      .baseline,
    "/repo/shared/base.json"
  );
});

test("JSONC comments parse, and a broken config names the file", () => {
  const raw = parseLintConfig(
    `{
  // the floor our system serves
  "ui5": "1.120",
}`,
    "/repo/abap2ui5lint.jsonc"
  );
  assert.equal(raw.ui5, "1.120");
  assert.throws(
    () => parseLintConfig("{ nope", "/repo/abap2ui5lint.jsonc"),
    /\/repo\/abap2ui5lint\.jsonc: not valid JSONC/
  );
});

test("a file is governed by the nearest config above it", () => {
  const configs = [
    "/repo/abap2ui5lint.jsonc",
    "/repo/apps/travel/abap2ui5lint.jsonc",
    "/other/abap2ui5lint.jsonc",
  ];
  assert.equal(
    nearestConfig("/repo/apps/travel/src/zcl_a.clas.abap", configs),
    "/repo/apps/travel/abap2ui5lint.jsonc"
  );
  assert.equal(
    nearestConfig("/repo/apps/other/src/zcl_b.clas.abap", configs),
    "/repo/abap2ui5lint.jsonc"
  );
  // a sibling repository's config governs nothing here
  assert.equal(nearestConfig("/elsewhere/zcl_c.clas.abap", configs), undefined);
});

test("in one directory the linter's preferred name wins", () => {
  assert.equal(
    nearestConfig("/repo/src/zcl_a.clas.abap", [
      "/repo/abap2ui5lint.json",
      "/repo/abap2ui5lint.jsonc",
    ]),
    "/repo/abap2ui5lint.jsonc"
  );
});

test("path helpers work on the '/'-separated paths a workspace URI carries", () => {
  assert.equal(dirOf("/repo/src/zcl_a.clas.abap"), "/repo/src");
  assert.equal(dirOf("file.abap"), "");
  assert.equal(joinPath("/repo", "./baseline.json"), "/repo/baseline.json");
  assert.equal(joinPath("", "baseline.json"), "baseline.json");
});

test("the baseline waives what it covers and leaves the rest", () => {
  const findings = [
    { type: "unknown-binding-path", control: "sap.m.Input", value: "{/OLD}" },
    { type: "duplicate-id", control: "sap.m.Button", value: "GO" },
  ] as never[];
  // keyed by the linter's own function, so the test cannot pass against a
  // key format only this file believes in
  const stored = parseBaseline(
    JSON.stringify({
      findings: { [findingKey("src/zcl_a.clas.abap", findings[0])]: 1 },
    })
  );
  assert.ok(stored);
  const suppressed = applyBaselineMap(
    findings,
    stored,
    "/repo/abap2ui5lint-baseline.json",
    "/repo/src/zcl_a.clas.abap"
  );
  assert.equal(suppressed, 1);
  assert.equal(findings.length, 1);
  assert.equal((findings[0] as { type: string }).type, "duplicate-id");
});

test("a baseline that does not parse waives nothing", () => {
  // the CLI fails on one; hiding findings behind a broken file is the opposite
  assert.equal(parseBaseline("{ not json"), null);
});
