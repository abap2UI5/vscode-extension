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
import type { LintConfig } from "@abap2ui5/linter/config";

/*
 * What an abap2ui5lint.jsonc means for a check - the half both builds share.
 * The desktop reads the file with `fs` and the web through workspace.fs; if
 * these decisions ever differed, the editor in a browser would check against
 * something CI does not, which is the defect the module exists to prevent.
 */

const SETTINGS = { minUi5: "1.71", distribution: "sapui5", allow: ["sap.m.X.y"] };

test("the repo config wins where it speaks, the settings fill in the rest", () => {
  // the parsed shape: the linter's validation has folded `ui5` into minUi5
  const options = optionsFromConfig(
    { minUi5: "1.120", rules: { "duplicate-id": false } },
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

test("a baseline that is not a path is a typo, not a crash", () => {
  // `"baseline": true` fed to the path work would throw out of every check
  // that resolves options - once per keystroke on the live path
  for (const typo of [true, 1, {}, ""]) {
    const options = optionsFromConfig(
      { baseline: typo } as unknown as LintConfig,
      "/repo/abap2ui5lint.jsonc",
      SETTINGS
    );
    assert.equal(options.baseline, undefined);
  }
  // and the parse itself refuses it, with the CLI's own words
  assert.throws(
    () => parseLintConfig('{ "baseline": true }', "/repo/abap2ui5lint.jsonc"),
    /\/repo\/abap2ui5lint\.jsonc: 'baseline' must be a file path/
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
  // normalised the way loadConfig normalises: `ui5` arrives as `minUi5`
  assert.equal(raw.minUi5, "1.120");
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

// ---------------------------------------------------------------------------
// Rules: the settings', and the repository's over them
// ---------------------------------------------------------------------------

test("a rule the repository says nothing about is the settings' to decide", () => {
  const options = optionsFromConfig({}, "/repo/abap2ui5lint.jsonc", {
    minUi5: "1.71",
    distribution: "sapui5",
    allow: [],
    rules: { "unknown-binding-path": false },
  });
  assert.deepEqual(options.rules, { "unknown-binding-path": false });
});

test("the repository wins for the rules it names", () => {
  // the editor and CI disagreeing about the same file is what this module
  // exists to prevent - a personal opinion cannot override a repo-wide one
  const options = optionsFromConfig(
    { rules: { "control-too-new": "error" } },
    "/repo/abap2ui5lint.jsonc",
    {
      minUi5: "1.71",
      distribution: "sapui5",
      allow: [],
      rules: { "control-too-new": false, "unknown-property": "hint" },
    }
  );
  assert.deepEqual(options.rules, {
    "control-too-new": "error", // the repository's
    "unknown-property": "hint", // untouched by it, so the setting's
  });
});

test("no opinion on either side leaves the gate its defaults", () => {
  const options = optionsFromConfig({}, "/repo/abap2ui5lint.jsonc", {
    minUi5: "1.71",
    distribution: "sapui5",
    allow: [],
  });
  assert.equal(options.rules, undefined);
});

/*
 * The web build used to read the config with a bare JSON.parse over the
 * stripped JSONC: no validation, no normalisation. So an unknown key the CLI
 * refuses was silently accepted, `"distribution": "OpenUI5"` reached the
 * property gate in a spelling it does not recognise - which turned
 * `sapui5-only-control` from the error CI reports into a hint - and a numeric
 * `ui5` stayed a number. `parseLintConfig` now IS the linter's parseConfig.
 */
test("the text is read the way the CLI reads it: validated and normalised", () => {
  const raw = parseLintConfig(
    '{ "ui5": 1.96, "distribution": "OpenUI5", "render": { "pages": 2 } }',
    "/repo/abap2ui5lint.jsonc"
  );
  assert.equal(raw.minUi5, "1.96", "a numeric ui5 becomes the string the gate compares");
  assert.equal(raw.distribution, "openui5", "the distribution is lower-cased");
  assert.equal(raw.render, true, "the object form of render is a boolean plus a pool size");
  assert.throws(
    () => parseLintConfig('{ "distrbution": "openui5" }', "/repo/abap2ui5lint.jsonc"),
    /\/repo\/abap2ui5lint\.jsonc: unknown key 'distrbution'/
  );
  assert.throws(
    () => parseLintConfig('{ "rules": { "no-such-rule": false } }', "/repo/abap2ui5lint.jsonc"),
    /no-such-rule/
  );
});

test("an extends is surfaced, not followed and not dropped", () => {
  // the web host has no second file to merge - the caller says so in the log
  const raw = parseLintConfig(
    '{ "extends": "../base.jsonc", "ui5": "1.120" }',
    "/repo/apps/abap2ui5lint.jsonc"
  );
  assert.equal(raw.extends, "../base.jsonc");
  assert.equal(raw.minUi5, "1.120");
});

test("render and ignore travel into the options - CI does not run what they switch off", () => {
  const options = optionsFromConfig(
    { render: false, ignore: ["^src/99/", "/generated/"] },
    "/repo/abap2ui5lint.jsonc",
    SETTINGS
  );
  assert.equal(options.render, false);
  assert.deepEqual(options.ignore, ["^src/99/", "/generated/"]);
  // and absent on both sides they stay absent - the gate keeps its defaults
  const plain = optionsFromConfig({}, "/repo/abap2ui5lint.jsonc", SETTINGS);
  assert.equal(plain.render, undefined);
  assert.equal(plain.ignore, undefined);
});

test("no distribution anywhere is null - the linter's own default, not sapui5", () => {
  const undecided = { ...SETTINGS, distribution: null };
  assert.equal(
    optionsFromConfig({}, "/repo/abap2ui5lint.jsonc", undecided).distribution,
    null
  );
  // the config's word still wins over an undecided setting
  assert.equal(
    optionsFromConfig({ distribution: "openui5" }, "/repo/abap2ui5lint.jsonc", undecided)
      .distribution,
    "openui5"
  );
});
