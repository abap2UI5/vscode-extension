import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CheckStep,
  checkTemplate,
  classifyBody,
  classifyClientProbe,
  classifyStatus,
  describeConnectFailure,
  firstFailure,
  pathAndQueryOf,
  reachedStep,
  renderReport,
} from "../connectcheck";

/*
 * The connection check's decisions. Every branch here is one thing a beginner
 * cannot tell apart through a white iframe - the tests pin down that each
 * observable failure names ITS fix, not a generic one.
 */

const TEMPLATE = "https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100";

// ---------------------------------------------------------------------------
// Step 1 - the launch URL itself
// ---------------------------------------------------------------------------

test("a good template passes with the short form in the detail", () => {
  const step = checkTemplate(TEMPLATE);
  assert.equal(step.ok, true);
  assert.ok(step.detail.includes("host:44300/sap/bc/z2ui5"));
});

test("an empty template points at Set Launch URL", () => {
  const step = checkTemplate("   ");
  assert.equal(step.ok, false);
  assert.ok(step.fix?.includes("Set Launch URL"));
});

test("a template without {class} names the placeholder", () => {
  const step = checkTemplate("https://host:44300/sap/bc/z2ui5?app_start=ZCL_A");
  assert.equal(step.ok, false);
  assert.ok(step.detail.includes("{class}"));
  assert.ok(step.fix?.includes("app_start={class}"));
});

test("a template that is not a URL says so", () => {
  const step = checkTemplate("host:44300/sap/bc/z2ui5?app_start={class}");
  // `host:44300/...` parses as a URL with scheme `host:` - the scheme check
  // is what catches the missing https:// here.
  assert.equal(step.ok, false);
  const noUrl = checkTemplate("just some words {class}");
  assert.equal(noUrl.ok, false);
  assert.ok(noUrl.fix?.includes("https://"));
});

// ---------------------------------------------------------------------------
// Step 2 - DNS / TCP / TLS, from the Node error code
// ---------------------------------------------------------------------------

test("ENOTFOUND is diagnosed as DNS, with the VPN hint", () => {
  const step = describeConnectFailure({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND host" });
  assert.equal(step.ok, false);
  assert.ok(step.detail.includes("DNS"));
  assert.ok(step.fix?.includes("VPN"));
});

test("ECONNREFUSED points at the port", () => {
  const step = describeConnectFailure({ code: "ECONNREFUSED" });
  assert.ok(step.detail.includes("port"));
  assert.ok(step.fix?.includes("44300"));
});

test("a timeout names the firewall/VPN, whether by code or by message", () => {
  assert.ok(describeConnectFailure({ code: "ETIMEDOUT" }).fix?.includes("VPN"));
  // the proxy's own 8s guard rejects with a plain message, no code
  const byMessage = describeConnectFailure({
    message: "request to the system timed out",
  });
  assert.ok(byMessage.detail.includes("timed out"));
});

test("certificate rejections point at allowUnauthorizedCerts", () => {
  for (const code of [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    // what a private CA the machine does not trust actually produces
    "UNABLE_TO_GET_ISSUER_CERT",
    "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "CERT_HAS_EXPIRED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ]) {
    const step = describeConnectFailure({ code });
    assert.ok(step.fix?.includes("allowUnauthorizedCerts"), code);
    assert.ok(step.detail.includes(code));
  }
});

test("EPROTO is the scheme/port mismatch", () => {
  const step = describeConnectFailure({ code: "EPROTO" });
  assert.ok(step.fix?.includes("https://"));
});

test("an unknown failure still carries the message and a fix", () => {
  const step = describeConnectFailure({ message: "socket hang up" });
  assert.equal(step.detail, "socket hang up");
  assert.ok(step.fix);
});

// ---------------------------------------------------------------------------
// Step 3 - what the status means
// ---------------------------------------------------------------------------

test("2xx passes", () => {
  const step = classifyStatus({ status: 200, path: "/sap/bc/z2ui5" });
  assert.equal(step.ok, true);
});

test("401 with WWW-Authenticate means the credentials, and quotes the system", () => {
  const step = classifyStatus({
    status: 401,
    path: "/sap/bc/z2ui5",
    authenticate: 'Basic realm="SAP NetWeaver"',
    reason: "User is locked",
  });
  assert.equal(step.ok, false);
  assert.ok(step.detail.includes("User is locked"));
  assert.ok(step.fix?.includes("Clear Stored SAP Credentials"));
  assert.ok(step.fix?.includes("sap-client"));
});

test("401 WITHOUT WWW-Authenticate means no basic auth, not a wrong password", () => {
  const step = classifyStatus({ status: 401, path: "/sap/bc/z2ui5" });
  assert.equal(step.ok, false);
  assert.ok(step.detail.includes("not"));
  assert.ok(step.fix?.includes("external"));
  // retyping a password cannot help here, so the fix must not suggest it
  assert.ok(!step.fix?.includes("Clear Stored SAP Credentials"));
});

test("403 points at authorizations", () => {
  const step = classifyStatus({ status: 403, path: "/sap/bc/z2ui5" });
  assert.ok(step.fix?.includes("SU53"));
});

test("404 is the ICF hint, quoting the path that failed", () => {
  const step = classifyStatus({ status: 404, path: "/sap/bc/z2ui5_typo" });
  assert.equal(step.ok, false);
  assert.ok(step.detail.includes("/sap/bc/z2ui5_typo"));
  assert.ok(step.fix?.includes("SICF"));
  assert.ok(step.fix?.includes("/sap/bc/z2ui5"));
});

test("a redirect is read as the logon-page pattern", () => {
  const step = classifyStatus({ status: 302, path: "/sap/bc/z2ui5" });
  assert.equal(step.ok, false);
  assert.ok(step.fix?.includes("external"));
});

test("5xx says the request arrived and where to look", () => {
  const step = classifyStatus({ status: 500, path: "/sap/bc/z2ui5" });
  assert.equal(step.ok, false);
  assert.ok(step.fix?.includes("ST22"));
});

// ---------------------------------------------------------------------------
// Step 3b - does the sap-client change the answer
// ---------------------------------------------------------------------------

test("credentials valid only in the URL's client pass with a caveat", () => {
  const step = classifyClientProbe({
    sapClient: "100",
    withClient: 200,
    withoutClient: 401,
  });
  assert.equal(step?.ok, true);
  assert.ok(step?.detail.includes("sap-client=100"));
  assert.ok(step?.detail.includes("401"));
});

test("credentials rejected only in the URL's client fail the check", () => {
  const step = classifyClientProbe({
    sapClient: "999",
    withClient: 401,
    withoutClient: 200,
  });
  assert.equal(step?.ok, false);
  assert.ok(step?.detail.includes("client 999"));
  assert.ok(step?.fix?.includes("sap-client"));
});

test("agreeing answers add no client step at all", () => {
  assert.equal(
    classifyClientProbe({ sapClient: "100", withClient: 200, withoutClient: 200 }),
    undefined
  );
  assert.equal(
    classifyClientProbe({ sapClient: "100", withClient: 401, withoutClient: 401 }),
    undefined
  );
  // a 404 without the client is an ICF quirk, not a credentials story
  assert.equal(
    classifyClientProbe({ sapClient: "100", withClient: 200, withoutClient: 404 }),
    undefined
  );
});

// ---------------------------------------------------------------------------
// Step 4 - is the 200 the right page
// ---------------------------------------------------------------------------

test("the abap2UI5 bootstrap page is recognised", () => {
  const step = classifyBody(
    '<html><head><script id="sap-ui-bootstrap" src="resources/sap-ui-core.js"></script>' +
      '<script>z2ui5.app_start = "ZCL_A";</script></head></html>'
  );
  assert.equal(step.ok, true);
  assert.ok(step.detail.includes("abap2UI5"));
});

test("the SAP logon page is named as such", () => {
  const step = classifyBody(
    '<html><body><form name="logonForm" action="/sap/bc/z2ui5">' +
      '<input name="sap-system-login" value="onLogin"></form></body></html>'
  );
  assert.equal(step.ok, false);
  assert.ok(step.detail.includes("logon page"));
  assert.ok(step.fix?.includes("sap-client"));
});

test("a UI5 page without an abap2UI5 marker passes with a caveat", () => {
  const step = classifyBody(
    '<script src="/resources/sap-ui-core.js"></script>'
  );
  assert.equal(step.ok, true);
  assert.ok(step.detail.includes("no abap2UI5 marker"));
});

test("an empty 200 points at the ICF node without a handler", () => {
  const step = classifyBody("   ");
  assert.equal(step.ok, false);
  assert.ok(step.fix?.includes("/sap/bc/z2ui5"));
});

test("some other page points the URL at the z2ui5 service", () => {
  const step = classifyBody("<html><body>Welcome to the intranet</body></html>");
  assert.equal(step.ok, false);
  assert.ok(step.fix?.includes("app_start={class}"));
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test("pathAndQueryOf hands fetchFromSystem what the launch would ask for", () => {
  assert.equal(
    pathAndQueryOf("https://host:44300/sap/bc/z2ui5?app_start=ZCL_A"),
    "/sap/bc/z2ui5?app_start=ZCL_A"
  );
  // a pathless launch URL still yields a request line a server accepts
  assert.equal(pathAndQueryOf("https://host?app_start=ZCL_A"), "/?app_start=ZCL_A");
  assert.equal(pathAndQueryOf("nonsense"), undefined);
});

test("the report renders pass/FAIL per step with the fix indented", () => {
  const steps: CheckStep[] = [
    checkTemplate(TEMPLATE),
    reachedStep("https://host:44300"),
    classifyStatus({ status: 404, path: "/sap/bc/z2ui5" }),
  ];
  const lines = renderReport(steps);
  assert.ok(lines[0].startsWith("pass  Launch URL:"));
  assert.ok(lines[1].startsWith("pass  Host reachable:"));
  assert.ok(lines[2].startsWith("FAIL  HTTP status:"));
  assert.ok(lines[3].includes("fix:"));
  assert.equal(firstFailure(steps)?.label, "HTTP status");
  assert.equal(firstFailure(steps.slice(0, 2)), undefined);
});
