import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBytes, formatTrafficLine, isRoundtrip } from "../traffic";

test("formatBytes picks a sensible unit", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(340), "340 B");
  assert.equal(formatBytes(1229), "1.2 kB");
  assert.equal(formatBytes(4 * 1024 * 1024), "4.0 MB");
});

test("formatTrafficLine aligns its columns", () => {
  const line = formatTrafficLine({
    method: "POST",
    path: "/sap/bc/z2ui5",
    status: 200,
    durationMs: 342,
    bytes: 1229,
  });
  assert.equal(line, "POST   200     342 ms    1.2 kB  /sap/bc/z2ui5");
});

test("isRoundtrip counts successful POSTs only", () => {
  const base = { path: "/x", durationMs: 1, bytes: 0 };
  assert.ok(isRoundtrip({ ...base, method: "POST", status: 200 }));
  assert.ok(!isRoundtrip({ ...base, method: "GET", status: 200 }));
  assert.ok(!isRoundtrip({ ...base, method: "POST", status: 401 }));
  // a redirected POST is a logon dance, not an app roundtrip
  assert.ok(!isRoundtrip({ ...base, method: "POST", status: 302 }));
});

/*
 * The traffic line is the one formatter behind BOTH the "abap2UI5 Traffic"
 * channel and the ring the MCP `get_traffic` tool hands an agent - so a
 * launch URL carrying credentials must not survive it. See the repository's
 * "never log credentials" convention.
 */
test("a password in the launch URL never reaches the traffic line", () => {
  const line = formatTrafficLine({
    method: "GET",
    path: "/sap/bc/z2ui5?sap-user=DEVELOPER&sap-password=hunter2&sap-client=100",
    status: 200,
    durationMs: 12,
    bytes: 0,
  });
  assert.ok(!line.includes("hunter2"), "the password reached the traffic log");
  assert.ok(!line.includes("DEVELOPER"), "the user reached the traffic log");
  assert.ok(line.includes("sap-password=<redacted>"));
  assert.ok(line.includes("sap-user=<redacted>"));
  // the diagnostic part survives - which client, which path
  assert.ok(line.includes("/sap/bc/z2ui5"));
  assert.ok(line.includes("sap-client=100"));
});

test("a pathless launch URL's credentials are redacted too", () => {
  // the proxy forwards `?a=b` behind the prefix as `/?a=b`
  const line = formatTrafficLine({
    method: "GET",
    path: "/?sap-password=hunter2",
    status: 200,
    durationMs: 1,
    bytes: 0,
  });
  assert.ok(!line.includes("hunter2"));
});

test("a request that got no answer renders a dash, not a zero", () => {
  const line = formatTrafficLine({
    method: "GET",
    path: "/sap/bc/z2ui5",
    status: 0,
    durationMs: 12,
    bytes: 0,
  });
  assert.equal(line, "GET    -        12 ms       0 B  /sap/bc/z2ui5");
});
