import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNewer,
  loadMessage,
  modelRootsOfSource,
  nextRecentApps,
  resolveReloadTrigger,
  staleMessage,
} from "../previewcore";
import { APP_TEMPLATES } from "../template";

// ---------------------------------------------------------------------------
// resolveReloadTrigger - the reloadOn/reloadOnSave merge
// ---------------------------------------------------------------------------

test("an explicit reloadOn wins over everything", () => {
  assert.equal(resolveReloadTrigger("never", true), "never");
  assert.equal(resolveReloadTrigger("save", false), "save");
  assert.equal(resolveReloadTrigger("activation", false), "activation");
});

test("without reloadOn the legacy reloadOnSave keeps its meaning", () => {
  assert.equal(resolveReloadTrigger(undefined, false), "never");
  assert.equal(resolveReloadTrigger(undefined, true), "save");
});

test("nothing set defaults to activation", () => {
  assert.equal(resolveReloadTrigger(undefined, undefined), "activation");
});

test("an unknown reloadOn value falls back like an unset one", () => {
  assert.equal(resolveReloadTrigger("sometimes", undefined), "activation");
  assert.equal(resolveReloadTrigger("sometimes", false), "never");
});

// ---------------------------------------------------------------------------
// The recent-apps list
// ---------------------------------------------------------------------------

test("a launch moves the class to the front without duplicating it", () => {
  assert.deepEqual(nextRecentApps(["A", "B", "C"], "B", 10), ["B", "A", "C"]);
  assert.deepEqual(nextRecentApps([], "A", 10), ["A"]);
});

test("the recent list is capped", () => {
  const recent = ["A", "B", "C"];
  assert.deepEqual(nextRecentApps(recent, "D", 3), ["D", "A", "B"]);
});

// ---------------------------------------------------------------------------
// isNewer - the activation watch's timestamp comparison
// ---------------------------------------------------------------------------

test("parseable timestamps compare by time", () => {
  assert.equal(isNewer("2026-07-29T23:28:38Z", "2026-07-29T23:28:37Z"), true);
  assert.equal(isNewer("2026-07-29T23:28:37Z", "2026-07-29T23:28:37Z"), false);
  assert.equal(isNewer("2026-07-29T23:28:36Z", "2026-07-29T23:28:37Z"), false);
});

test("unparseable timestamps fall back to differs", () => {
  assert.equal(isNewer("version-2", "version-1"), true);
  assert.equal(isNewer("version-1", "version-1"), false);
});

// ---------------------------------------------------------------------------
// The webview messages
// ---------------------------------------------------------------------------

const TARGET = {
  className: "ZCL_APP",
  frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_APP",
  externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_APP",
  system: "DEV",
};

test("the load message carries the target, the params and the model roots", () => {
  const msg = loadMessage(TARGET, "sap_horizon", "EN", ["MT_ITEMS"], "Reloaded");
  assert.equal(msg.type, "load");
  assert.equal(msg.className, "ZCL_APP");
  assert.equal(msg.frameUrl, TARGET.frameUrl);
  assert.equal(msg.externalUrl, TARGET.externalUrl);
  assert.equal(msg.theme, "sap_horizon");
  assert.equal(msg.language, "EN");
  assert.deepEqual(msg.modelRoots, ["MT_ITEMS"]);
  assert.equal(msg.reason, "Reloaded");
  // the short URL is display text - host without the query noise
  assert.ok(msg.shortUrl.includes("host"));
  assert.ok(!msg.shortUrl.includes("app_start"));
});

test("the stale message says why", () => {
  assert.deepEqual(staleMessage("Saved - activate to update"), {
    type: "stale",
    reason: "Saved - activate to update",
  });
});

// ---------------------------------------------------------------------------
// modelRootsOfSource - what a stateful reload may restore
// ---------------------------------------------------------------------------

test("the model roots of a builder class are its bound attributes", () => {
  const list = APP_TEMPLATES.find((t) => t.id === "list")!;
  const roots = modelRootsOfSource(list.source);
  assert.ok(roots.length > 0, "the list template binds mt_products");
});

test("a class without the builder has no model roots", () => {
  const roots = modelRootsOfSource(
    "CLASS zcl_plain DEFINITION PUBLIC.\nENDCLASS.\n" +
      "CLASS zcl_plain IMPLEMENTATION.\nENDCLASS.\n"
  );
  assert.deepEqual(roots, []);
});

test("broken source yields no roots instead of throwing", () => {
  assert.deepEqual(modelRootsOfSource("not abap at all {{{"), []);
});
