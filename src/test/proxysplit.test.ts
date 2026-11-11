import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as facade from "../proxy";
import * as adt from "../proxyadt";
import * as html from "../proxyhtml";
import * as body from "../proxybody";
import * as headers from "../proxyheaders";
import type { AdtClassRef, AdtClassState, ProxyResponse, TrafficEntry } from "../proxy";

/**
 * `proxy.ts` is the module everyone imports from; the free-standing helpers
 * around `SapProxy` live in the four `proxy*.ts` files next to it. These
 * tests pin that arrangement: the facade exports exactly what it did before
 * the split, hands out the very same objects, and no part reaches back into
 * the module that holds the listener and the credentials.
 */

const ROOT = path.resolve(__dirname, "..");
const PARTS = ["proxyadt.ts", "proxyhtml.ts", "proxybody.ts", "proxyheaders.ts"];

test("proxy.ts exports what it exported before the split, from the parts unchanged", () => {
  const names = Object.keys(facade).sort();
  assert.deepEqual(names, [
    "AdtStatusError",
    "RUNTIME_MESSAGE_MARKER",
    "SapProxy",
    "TOKEN_COOKIE",
    "allowFraming",
    "decodeBody",
    "describeRejection",
    "injectRuntimeHook",
    "isLoopbackHost",
    "parseAdtClassRefs",
    "rebasedReferer",
    "requestHostname",
    "rewriteSetCookie",
    "withUtf8Charset",
  ]);
  const parts: Record<string, unknown> = { ...adt, ...html, ...body, ...headers };
  for (const name of names.filter((n) => n !== "SapProxy")) {
    assert.equal((facade as Record<string, unknown>)[name], parts[name], name);
  }
  assert.equal(parts.SapProxy, undefined, "the class stays in proxy.ts");
});

test("the types proxy.ts exported are still importable from it", () => {
  // compile-time pin: this file does not build when one of them goes missing
  const ref: AdtClassRef = { name: "ZCL_X" };
  const state: AdtClassState = { version: "active" };
  const response: ProxyResponse = { status: 401, path: "/" };
  const entry: TrafficEntry = { method: "GET", path: "/", status: 200, durationMs: 1, bytes: 0 };
  assert.deepEqual(
    [ref.name, state.version, response.status, entry.method],
    ["ZCL_X", "active", 401, "GET"]
  );
});

test("each part owns its helpers, and what stays internal is not on the facade", () => {
  assert.deepEqual(Object.keys(adt).sort(), ["AdtStatusError", "parseAdtClassRefs"]);
  assert.deepEqual(Object.keys(html).sort(), [
    "INJECT_MAX_BYTES",
    "RUNTIME_MESSAGE_MARKER",
    "allowFraming",
    "injectRuntimeHook",
  ]);
  assert.deepEqual(Object.keys(body).sort(), [
    "REJECTION_SNIFF_BYTES",
    "decodeBody",
    "describeRejection",
    "withUtf8Charset",
  ]);
  assert.deepEqual(Object.keys(headers).sort(), [
    "HOP_BY_HOP_HEADERS",
    "TOKEN_COOKIE",
    "TOKEN_SEGMENT",
    "headerValue",
    "isLoopbackHost",
    "rebasedReferer",
    "requestHostname",
    "rewriteSetCookie",
    "tokensEqual",
  ]);
  // the token comparison and the path segment are the listener's business
  for (const internal of ["tokensEqual", "TOKEN_SEGMENT", "headerValue", "HOP_BY_HOP_HEADERS"]) {
    assert.ok(!(internal in facade), internal);
  }
});

test("no part imports proxy.ts, vscode or another part", () => {
  for (const file of PARTS) {
    const source = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
    const imported = [...source.matchAll(/\bfrom\s+"([^"]+)"|\brequire\(\s*"([^"]+)"\s*\)/g)].map(
      (m) => m[1] ?? m[2]
    );
    for (const spec of imported) {
      assert.notEqual(spec, "vscode", `${file} imports vscode`);
      assert.ok(!/^\.\/proxy/.test(spec), `${file} imports ${spec}`);
    }
  }
});

test("proxy.ts keeps the class whole: the parts declare no class but the ADT error", () => {
  for (const file of PARTS) {
    const source = fs.readFileSync(path.join(ROOT, "src", file), "utf8");
    const classes = [...source.matchAll(/^(?:export )?class (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(classes, file === "proxyadt.ts" ? ["AdtStatusError"] : [], file);
  }
});
