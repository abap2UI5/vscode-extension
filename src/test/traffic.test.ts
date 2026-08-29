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
