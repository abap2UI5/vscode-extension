import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AUTH_KINDS,
  isListedSystem,
  profileFieldsOf,
  profileNotes,
  roleLine,
  statusText,
  tightenRoles,
  withDetectedUi5,
} from "../systemprofile";
import { settingsForSystem } from "../configcore";
import { clearConfigCache, resolveOptions } from "../lintconfig";
import { runGate } from "../gate";

/*
 * What a `systems` entry may say beyond name and url, and what it means:
 * tolerant parsing, the role that only tightens, the detected UI5 version
 * written back, and - end to end through the real gate - the active system
 * deciding which "too new for the floor" findings a view gets.
 */

const ROOT = path.resolve(__dirname, "..");
const URL = "https://dev.example:44300/sap/bc/z2ui5?app_start={class}&sap-client=100";

test("an entry of name and url carries no profile fields", () => {
  assert.deepEqual(profileFieldsOf({ name: "DEV", url: URL }), {});
  assert.deepEqual(profileFieldsOf(null), {});
  assert.deepEqual(profileFieldsOf("https://x/{class}"), {});
  assert.deepEqual(profileFieldsOf([]), {});
});

test("the four fields are read, trimmed and case-folded where a word is expected", () => {
  assert.deepEqual(
    profileFieldsOf({
      name: "PRD",
      url: URL,
      role: " Production ",
      minUi5: " 1.120 ",
      distribution: "OpenUI5",
      auth: "basic",
    }),
    { role: "production", minUi5: "1.120", distribution: "openui5", auth: "basic" }
  );
  assert.deepEqual(profileFieldsOf({ role: "development", minUi5: "1.71.60" }), {
    role: "development",
    minUi5: "1.71.60",
  });
});

test("a field of the wrong type or with an unknown value is ignored - the rest survives", () => {
  assert.deepEqual(
    profileFieldsOf({
      role: true,
      minUi5: 1.12,
      distribution: "sapui6",
      auth: "basic",
    }),
    { auth: "basic" }
  );
  assert.deepEqual(profileFieldsOf({ role: "prod", minUi5: "latest", distribution: {} }), {});
  // every ignored field is named, with the system it belongs to
  const notes = profileNotes([
    { name: "DEV", url: URL },
    { name: "PRD", url: URL, role: "prod", minUi5: 1.12, distribution: "sapui6" },
    { url: URL, minUi5: "latest" },
    "not an entry",
  ]);
  assert.equal(notes.length, 4);
  assert.match(notes[0], /^system 'PRD': "role": "prod" is not "development" or "production" - ignored$/);
  assert.match(notes[1], /^system 'PRD': "minUi5": 1\.12 is not a string - ignored$/);
  assert.match(notes[2], /^system 'PRD': "distribution": "sapui6" is not "sapui5" or "openui5" - ignored$/);
  assert.match(notes[3], /^system #3: "minUi5": "latest" is not a UI5 version/);
  assert.deepEqual(profileNotes(undefined), []);
  assert.deepEqual(profileNotes({ role: 1 }), []);
});

test("`auth` accepts the implemented mechanisms; anything else is ignored with a note", () => {
  assert.deepEqual(profileFieldsOf({ auth: "basic" }), { auth: "basic" });
  assert.deepEqual(profileFieldsOf({ auth: "certificate" }), { auth: "certificate" });
  assert.deepEqual(profileFieldsOf({ auth: "OAuth" }), { auth: "oauth" });
  assert.deepEqual(profileFieldsOf({ auth: "Browser" }), { auth: "browser" });
  for (const value of ["sso", "x509", "none", 1, true]) {
    assert.deepEqual(profileFieldsOf({ auth: value }), {}, String(value));
    assert.equal(profileNotes([{ name: "S", url: URL, auth: value }]).length, 1, String(value));
  }
  assert.match(
    profileNotes([{ name: "S", url: URL, auth: "sso" }])[0],
    /"auth": "sso" is ignored - the values accepted so far are "basic", "certificate", "oauth" and "browser"/
  );
});

test("the schema knows exactly these fields - and none that could switch a check off", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const items = pkg.contributes.configuration.properties["abap2ui5.systems"].items;
  assert.equal(items.additionalProperties, false);
  assert.deepEqual(Object.keys(items.properties).sort(), [
    "auth",
    "distribution",
    "minUi5",
    "name",
    "role",
    "url",
  ]);
  // existing values stay valid: the new fields are optional
  assert.deepEqual(items.required, ["name", "url"]);
  assert.deepEqual(items.properties.role.enum, ["development", "production"]);
  assert.deepEqual(items.properties.distribution.enum, ["sapui5", "openui5"]);
  assert.deepEqual(items.properties.auth.enum, ["basic", "certificate", "oauth", "browser"]);
  // the schema's words are the parser's
  assert.deepEqual(items.properties.auth.enum, [...AUTH_KINDS]);
  // the schema's version pattern is the parser's
  const pattern = new RegExp(items.properties.minUi5.pattern);
  for (const [value, ok] of [["1.120", true], ["1.71.60", true], ["latest", false], ["1", false]] as const) {
    assert.equal(pattern.test(value), ok, value);
    assert.equal(profileFieldsOf({ minUi5: value }).minUi5 !== undefined, ok, value);
  }
});

test("production survives a workspace list that restates the system without the mark", () => {
  type Profile = { name: string; template: string; role?: "development" | "production" };
  const user: Profile[] = [
    { name: "PRD", template: "https://prd.example/sap/bc/z2ui5?app_start={class}&sap-client=100", role: "production" as const },
    { name: "DEV", template: URL },
  ];
  // the workspace's list is the effective one - same host, another client,
  // no role; and a host the user never marked
  const workspace: Profile[] = [
    { name: "harmless", template: "https://prd.example/sap/bc/z2ui5?app_start={class}&sap-client=200" },
    { name: "DEV", template: URL, role: "development" as const },
  ];
  const tightened = tightenRoles(workspace, user);
  assert.equal(tightened[0].role, "production");
  assert.equal(tightened[0].name, "harmless");
  assert.equal(tightened[1].role, "development", "an unmarked host is not touched");
  // the other direction never loosens: a shadowed "development" changes nothing
  assert.equal(
    tightenRoles(
      [{ template: "https://prd.example/x?app_start={class}", role: "production" as const }],
      [{ template: "https://prd.example/x?app_start={class}", role: "development" as const }]
    )[0].role,
    "production"
  );
  // nothing shadowed: the list as it is
  assert.deepEqual(tightenRoles(workspace, []), workspace);
});

test("the status bar names the role next to the class", () => {
  assert.equal(statusText("ZCL_APP", undefined), "$(play-circle) ZCL_APP");
  assert.equal(statusText("ZCL_APP", "production"), "$(play-circle) ZCL_APP · production");
  assert.equal(statusText("ZCL_APP", "development"), "$(play-circle) ZCL_APP · development");
  assert.equal(roleLine(undefined), "");
  assert.match(roleLine("production"), /\*\*production\*\*.*"role": "production"/);
  assert.equal(roleLine("development"), "Role: development");
});

test("the detected UI5 version is written into the entry with that url - and only there", () => {
  const list = [
    { name: "DEV", url: ` ${URL} `, role: "development", custom: 1 },
    { name: "QAS", url: "https://qas.example/x?app_start={class}", minUi5: "1.96" },
  ];
  assert.equal(isListedSystem(list, URL), true);
  assert.equal(isListedSystem(list, "https://other/x?app_start={class}"), false);
  assert.equal(isListedSystem(undefined, URL), false);
  const next = withDetectedUi5(list, URL, { minUi5: "1.120", distribution: "sapui5" });
  assert.deepEqual(next, [
    { name: "DEV", url: ` ${URL} `, role: "development", custom: 1, minUi5: "1.120", distribution: "sapui5" },
    list[1],
  ]);
  assert.equal(list[0].hasOwnProperty("minUi5"), false, "the configured value is not mutated");
  // no libraries list, no claim about the distribution: what is there stays
  assert.deepEqual(
    withDetectedUi5([{ name: "A", url: URL, distribution: "openui5" }], URL, { minUi5: "1.120" }),
    [{ name: "A", url: URL, distribution: "openui5", minUi5: "1.120" }]
  );
  // the single launchUrlTemplate has no entry - the caller keeps the global settings
  assert.equal(withDetectedUi5(list, "https://other/x?app_start={class}", { minUi5: "1.120" }), undefined);
  assert.equal(withDetectedUi5("nope", URL, { minUi5: "1.120" }), undefined);
  // nothing to change is nothing to write
  assert.equal(
    withDetectedUi5([{ name: "A", url: URL, minUi5: "1.120" }], URL, { minUi5: "1.120" }),
    undefined
  );
});

// ------------------------------------------------ through the real gate ----

const VIEW =
  '<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc"><Page><ExpandableText text="x" /></Page></mvc:View>';

const SETTINGS = { minUi5: "1.71", distribution: null, allow: [] };

function tooNew(dir: string, system: { name: string; minUi5?: string } | undefined): string[] {
  const options = resolveOptions(dir, settingsForSystem(SETTINGS, system));
  return runGate(VIEW, path.join(dir, "v.view.xml"), true, options)
    .findings.filter((f) => /too-new|since/i.test(f.type))
    .map((f) => f.type);
}

test("switching the active system changes which too-new findings a view gets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abap2ui5-profile-"));
  clearConfigCache();
  // sap.m.ExpandableText arrived with 1.87: too new for the setting's 1.71
  // and for an old system, fine on a system that serves 1.120
  assert.notDeepEqual(tooNew(dir, undefined), []);
  assert.notDeepEqual(tooNew(dir, { name: "OLD", minUi5: "1.71" }), []);
  assert.deepEqual(tooNew(dir, { name: "NEW", minUi5: "1.120" }), []);
  // and a profile BELOW the setting brings the finding back
  const high = { ...SETTINGS, minUi5: "1.120" };
  const under = (system: { name: string; minUi5?: string } | undefined) =>
    runGate(VIEW, path.join(dir, "v.view.xml"), true, resolveOptions(dir, settingsForSystem(high, system)))
      .findings.filter((f) => /too-new|since/i.test(f.type)).length;
  assert.equal(under(undefined), 0);
  assert.ok(under({ name: "OLD", minUi5: "1.71" }) > 0);
  // the repository's config still wins over the active system
  fs.writeFileSync(path.join(dir, "abap2ui5lint.jsonc"), '{ "minUi5": "1.71" }');
  clearConfigCache();
  assert.notDeepEqual(tooNew(dir, { name: "NEW", minUi5: "1.120" }), []);
});
