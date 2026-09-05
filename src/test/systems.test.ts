import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * The credential-carrying decisions of `systems.ts`: the secret KEY shape, the
 * pre-0.14 unscoped-key migration, and the name dedup that decides which
 * profile "the active system" resolves to.
 *
 * `systems.ts` is VS Code plumbing (settings, SecretStorage, QuickPick) and
 * cannot be made `vscode`-free without a module of its own, which is a bigger
 * refactor than these three helpers are worth. So the module is loaded with
 * `vscode` stubbed - the ONE place in this suite that does so, and only
 * because what is under test here is the handling of stored credentials, which
 * had no test at all. Nothing below touches the stub: every function called is
 * pure. A new test that needs more of `vscode` than an empty configuration is
 * the signal to extract a core module instead of growing the stub.
 */
const Module = require("module");
const loadModule = Module._load;
Module._load = function (request: string, ...rest: unknown[]) {
  if (request === "vscode") {
    return {
      workspace: { getConfiguration: () => ({ get: (_k: string, d: unknown) => d }) },
    };
  }
  return loadModule.call(this, request, ...rest);
};

const {
  enteredUser,
  keysFor,
  legacyAdoption,
  uniqueName,
  withUniqueNames,
} = require("../systems") as typeof import("../systems");

test("secrets are keyed by origin, under the documented names", () => {
  // AGENTS.md: keyed by origin (`abap2ui5.user:<origin>`), and the pre-0.14
  // unscoped names must not be reused for anything else. A silent change here
  // asks every installed copy for its password again.
  assert.deepEqual(keysFor("https://sap.example.com:44300"), {
    user: "abap2ui5.user:https://sap.example.com:44300",
    pass: "abap2ui5.pass:https://sap.example.com:44300",
  });
  // two clients on ONE host share a logon, two hosts do not
  assert.equal(
    keysFor("https://sap.example.com:44300").user,
    keysFor("https://sap.example.com:44300").user
  );
  assert.notEqual(
    keysFor("https://a.example.com").user,
    keysFor("https://b.example.com").user
  );
  // and neither key is the unscoped one an old install still carries
  assert.notEqual(keysFor("").user, "abap2ui5.user");
  assert.notEqual(keysFor("").pass, "abap2ui5.pass");
});

test("the pre-0.14 keys are adopted only by an origin that has none", () => {
  const legacy = { user: "DEVELOPER", pass: "secret" };
  assert.deepEqual(legacyAdoption({}, legacy), legacy);
  // an origin that already has either half keeps what it has - the legacy
  // pair belongs to whichever origin asked first, and overwriting a stored
  // logon with it would log the user on as somebody else
  assert.equal(legacyAdoption({ user: "OTHER", pass: "x" }, legacy), undefined);
  assert.equal(legacyAdoption({ user: "OTHER" }, legacy), undefined);
  assert.equal(legacyAdoption({ pass: "x" }, legacy), undefined);
  // a half-written legacy pair is not a logon
  assert.equal(legacyAdoption({}, { user: "DEVELOPER" }), undefined);
  assert.equal(legacyAdoption({}, { pass: "secret" }), undefined);
  assert.equal(legacyAdoption({}, {}), undefined);
  // an empty string is not a credential either
  assert.equal(legacyAdoption({}, { user: "", pass: "secret" }), undefined);
});

test("two profiles configured with one name are numbered, not merged", () => {
  // the name is how a system is addressed: the picker shows it, the active
  // one is remembered by it. Twins used to both resolve to the first.
  const numbered = withUniqueNames([
    { name: "DEV", template: "https://a/{class}" },
    { name: "DEV", template: "https://b/{class}" },
    { name: "DEV", template: "https://c/{class}" },
    { name: "QAS", template: "https://d/{class}" },
  ]);
  assert.deepEqual(
    numbered.map((s) => s.name),
    ["DEV", "DEV (2)", "DEV (3)", "QAS"]
  );
  // the templates travel untouched - only the presented name changes
  assert.deepEqual(
    numbered.map((s) => s.template),
    ["https://a/{class}", "https://b/{class}", "https://c/{class}", "https://d/{class}"]
  );
  assert.deepEqual(withUniqueNames([]), []);
});

test("a newly added system is numbered past the names already taken", () => {
  assert.equal(uniqueName("DEV", []), "DEV");
  assert.equal(uniqueName("DEV", ["QAS"]), "DEV");
  assert.equal(uniqueName("DEV", ["DEV"]), "DEV (2)");
  assert.equal(uniqueName("DEV", ["DEV", "DEV (2)"]), "DEV (3)");
  // the same shape withUniqueNames presents, so the two cannot disagree
  assert.equal(
    uniqueName("DEV", ["DEV"]),
    withUniqueNames([
      { name: "DEV", template: "https://a/{class}" },
      { name: "DEV", template: "https://b/{class}" },
    ])[1].name
  );
});

test("the SAP user is stored trimmed, and a blank answer is a cancel", () => {
  // a user pasted with a trailing space is a different user to the system -
  // every logon with it failed until the credentials were reset
  assert.equal(enteredUser(" DEVELOPER "), "DEVELOPER");
  assert.equal(enteredUser("developer"), "developer");
  assert.equal(enteredUser("   "), undefined);
  assert.equal(enteredUser(""), undefined);
  assert.equal(enteredUser(undefined), undefined);
});
