import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { inspect } from "util";
import { buildReport, redact, ReportInput } from "../report";
import { RoundtripBuffer } from "../roundtrips";

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

test("a quoted auth header loses its credential, not its scheme", () => {
  assert.equal(
    redact("request had Authorization: Basic ZGV2ZWxvcGVyOmh1bnRlcjI="),
    "request had Authorization: Basic <redacted>"
  );
  assert.equal(
    redact("authorization: bearer eyJhbGciOiJIUzI1NiJ9.e30.x"),
    "authorization: bearer <redacted>"
  );
});

test("prose about basic authentication is not a header", () => {
  // a bare "Basic <word>" rule would redact this sentence - the rule is
  // anchored on the header name so ordinary log prose survives
  const line = "view-check: Basic authentication failed for the system";
  assert.equal(redact(line), line);
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
  renderGate: { installed: true, pin: "0.8.5" },
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

/** Split a markdown table row the way a renderer does: a backslash escapes
 *  the character after it, so only an UNESCAPED pipe ends a cell. */
function cellsOf(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      cur += line[++i] ?? "";
      continue;
    }
    if (c === "|") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.slice(1, -1).map((c) => c.trim());
}

test("a backslash in a cell cannot open a column of its own", () => {
  // A workspace folder is whatever the user named a directory, and it ends up
  // in a table cell. Escaping only the pipe turns \| into \\| - an escaped
  // backslash followed by a LIVE column separator - so the row the escaping
  // exists to keep intact is the one it breaks.
  const report = buildReport({ ...INPUT, workspaceFolders: ["weird\\|name"] });
  const line = report
    .split("\n")
    .find((l) => l.startsWith("| workspace folders"));
  assert.ok(line, report);
  assert.deepEqual(cellsOf(line), ["workspace folders", "weird\\|name"]);
});

// ---------------------------------------------------------------------------
// Roundtrip bodies never reach the report
// ---------------------------------------------------------------------------

/*
 * "Show Roundtrip" keeps the last request and response bodies of the running
 * app in memory - the app's DATA. The report is pasted into a public issue.
 * No redaction rule could tell a customer name from a class name, so the
 * guarantee is structural, in three layers.
 */

/** Every field a report is built from. A field added to `ReportInput` fails
 *  the compile here, and whoever adds it reads the tests below first. */
const REPORT_FIELDS: Record<keyof ReportInput, "fixed" | "free-form"> = {
  extensionVersion: "fixed",
  vscodeVersion: "fixed",
  platform: "fixed",
  host: "fixed",
  workspaceFolders: "fixed",
  documents: "fixed",
  renderGate: "fixed",
  systems: "fixed",
  relatedExtensions: "fixed",
  // the two a value of any shape could arrive through
  settings: "free-form",
  recentLog: "free-form",
};

function ringWithSecrets(): RoundtripBuffer {
  const ring = new RoundtripBuffer();
  ring.add({
    at: 0,
    path: "/sap/bc/z2ui5?sap-client=100",
    status: 200,
    durationMs: 5,
    requestHeaders: { cookie: "SESSION-COOKIE-VALUE", "content-type": "application/json" },
    requestBody: Buffer.from(
      JSON.stringify({
        value: {
          S_FRONT: { ID: "D1", EVENT: "SAVE", T_EVENT_ARG: ["ARGUMENT-VALUE"] },
          MODEL: { MV_CUSTOMER: "REQUEST-BODY-VALUE" },
        },
      })
    ),
    requestBytes: 100,
    responseBody: Buffer.from(
      JSON.stringify({ S_FRONT: { ID: "D2", APP: "Z_APP" }, MODEL: { MV_CUSTOMER: "RESPONSE-BODY-VALUE" } })
    ),
    responseBytes: 100,
    responseEncoding: "",
  });
  return ring;
}

test("the report's input has no field a roundtrip body is collected into", () => {
  // layer 1: the collector and the formatter do not know the ring exists
  const src = path.join(__dirname, "..", "src");
  for (const file of ["report.ts", "diagnosticsreport.ts"]) {
    const text = fs.readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(text, /roundtrips?\b|requestText|responseText/i, file);
  }
  assert.deepEqual(
    Object.entries(REPORT_FIELDS)
      .filter(([, kind]) => kind === "free-form")
      .map(([name]) => name),
    ["settings", "recentLog"]
  );
});

test("the roundtrip modules write no body into a log, a channel or a file", () => {
  // layer 2: `recentLog` is the session log - and nothing of a body goes in
  const src = path.join(__dirname, "..", "src");
  for (const file of ["roundtrips.ts", "roundtripview.ts"]) {
    const text = fs.readFileSync(path.join(src, file), "utf8");
    assert.doesNotMatch(text, /appendLine|createOutputChannel|from "fs"|workspace\.fs|writeFile|globalState|workspaceState\.update/, file);
    const logged = [...text.matchAll(/session\.log\(([\s\S]*?)\);/g)].map((m) => m[1]);
    for (const call of logged) {
      assert.doesNotMatch(call, /Text\(|\.body|args|summary|models|header|detail/i, `${file}: ${call}`);
    }
    if (file === "roundtripview.ts") {
      assert.ok(logged.length > 0, "the scan found the log calls it judges");
    }
  }
});

test("a roundtrip that strays into the report's free-form fields carries no body", () => {
  // layer 3: even handed over whole, a roundtrip prints its number and sizes
  const ring = ringWithSecrets();
  const [entry] = ring.list();
  const report = buildReport({
    ...INPUT,
    settings: { stray: entry, ring, list: ring.list() },
    recentLog: [
      String(entry),
      `${entry}`,
      JSON.stringify(entry),
      JSON.stringify(ring),
      inspect(entry, { depth: 10, showHidden: true }),
      inspect(ring, { depth: 10, showHidden: true }),
    ],
  });
  assert.doesNotMatch(report, /-VALUE/);
  assert.doesNotMatch(report, /MV_CUSTOMER|T_EVENT_ARG|S_FRONT/);
  assert.match(entry.requestText() ?? "", /REQUEST-BODY-VALUE/, "the fixture really holds one");
});
