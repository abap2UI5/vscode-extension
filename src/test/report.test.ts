import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, redact, ReportInput } from "../report";

/*
 * A report is pasted into a public issue. Everything below is a thing that
 * must not travel with it, or a thing whose absence would make the paste
 * useless.
 */

test("the proxy's own token never travels", () => {
  // it authorizes a session against the system for as long as the proxy runs
  const line = "proxy: 200 for /__abap2ui5/Xy9-abc_DEF/sap/bc/z2ui5";
  assert.equal(
    redact(line),
    "proxy: 200 for /__abap2ui5/<token>/sap/bc/z2ui5"
  );
});

test("credentials written into a url are removed", () => {
  assert.equal(
    redact("https://developer:hunter2@sap.example.com:44300/sap/bc"),
    "https://<user>:<password>@<host>:44300/sap/bc"
  );
});

test("an internal hostname names the company as clearly as a logo", () => {
  assert.equal(
    // the port stays: it is not a secret, and "which port did it even try"
    // is a question this report should not need a second round for
    redact("launching against https://s4hana.internal.acme.corp:44300/sap"),
    "launching against https://<host>:44300/sap"
  );
});

test("loopback survives, because that one is never a secret", () => {
  // and it is the difference between "the proxy answered" and "the system did"
  assert.ok(redact("proxy on http://127.0.0.1:51234").includes("127.0.0.1"));
});

test("credentials in query parameters go too", () => {
  assert.equal(
    redact("/sap/bc/z2ui5?sap-user=DEVELOPER&sap-client=100"),
    "/sap/bc/z2ui5?sap-user=<redacted>&sap-client=100"
  );
});

// ---------------------------------------------------------------------------
// The report itself
// ---------------------------------------------------------------------------

const INPUT: ReportInput = {
  extensionVersion: "0.24.0",
  vscodeVersion: "1.101.0",
  platform: "darwin arm64",
  host: "desktop",
  workspaceFolders: ["my-repo"],
  documents: [
    {
      label: "zcl_file_app.clas.abap",
      scheme: "file",
      languageId: "abap",
      checkable: true,
      usesBuilder: true,
      configFile: "/repo/abap2ui5lint.jsonc",
      findings: 2,
    },
    {
      label: "ZCL_ADT_APP",
      scheme: "adt",
      languageId: "abap",
      checkable: true,
      usesBuilder: true,
      findings: 0,
    },
  ],
  settings: { "viewCheck.minUi5": "1.71" },
  renderGate: { installed: true, pin: "3b98c3095674" },
  systems: { configured: 2, active: "DEV", proxyRunning: true },
  relatedExtensions: ["murbani.vscode-abap-remote-fs 1.2.3"],
  recentLog: ["2026-08-18 06:00:00  view-check: zcl_x - 0 finding(s)"],
};

test("both kinds of document are listed with the scheme that tells them apart", () => {
  const report = buildReport(INPUT);
  assert.match(report, /zcl_file_app\.clas\.abap.*\|\s*file\s*\|/);
  assert.match(report, /ZCL_ADT_APP.*\|\s*adt\s*\|/);
  // and the one governed by no config file says so rather than looking empty
  assert.match(report, /\(settings\)/);
});

test("the report carries the versions and the log", () => {
  const report = buildReport(INPUT);
  assert.match(report, /extension \| 0\.24\.0/);
  assert.match(report, /1\.101\.0/);
  assert.match(report, /vscode-abap-remote-fs/);
  assert.match(report, /view-check: zcl_x/);
});

test("nothing open is said out loud, not left blank", () => {
  const report = buildReport({ ...INPUT, documents: [], recentLog: [] });
  assert.match(report, /No ABAP or view document is open/);
  assert.match(report, /nothing logged yet/);
});

test("the whole report goes through the redaction, not just the log", () => {
  const report = buildReport({
    ...INPUT,
    settings: { "launchUrlTemplate": "https://sap.internal.acme.corp:44300?app={class}" },
    recentLog: ["proxy: forwarding to https://sap.internal.acme.corp:44300"],
  });
  assert.ok(!report.includes("acme.corp"), "no hostname anywhere in the report");
});
