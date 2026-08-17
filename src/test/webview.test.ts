import { test } from "node:test";
import assert from "node:assert/strict";
import { previewHtml, viewPreviewHtml, welcomeHtml } from "../webview";

const BASE = { nonce: "n0nce", hasLaunchUrl: true } as const;

test("the preview carries the runtime-error badge, reset on every load", () => {
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: ["MT_ITEMS"],
    nonce: "n0nce",
  });
  assert.ok(html.includes('id="errors"'));
  // The roundtrip badge and the traffic log behind it.
  assert.ok(html.includes('id="rt"'));
  assert.ok(html.includes("showTraffic"));
  // Stateful reload: the pin, the capture command and the restore.
  assert.ok(html.includes('id="pin"'));
  assert.ok(html.includes("model-restore"));
  assert.ok(html.includes("'restore'"));
  assert.ok(html.includes('["MT_ITEMS"]'));
  // The screenshot button relays to the host command.
  assert.ok(html.includes('id="shot"'));
  assert.ok(html.includes("screenshot"));
  // The relay: the marked iframe messages reach the host as runtimeError.
  assert.ok(html.includes("__abap2ui5Runtime"));
  assert.ok(html.includes("runtimeError"));
  // A reload starts a clean count.
  assert.ok(html.includes("setErrorCount(0)"));
  // Inspect and model talk INTO the iframe and relay the answers out.
  assert.ok(html.includes('id="inspect"'));
  assert.ok(html.includes('id="model"'));
  assert.ok(html.includes("__abap2ui5Cmd"));
  assert.ok(html.includes("inspected"));
  assert.ok(html.includes("appModel"));
});

test("in panel mode the empty state promises the app right here", () => {
  const html = welcomeHtml({ ...BASE, openMode: "panel" });
  assert.ok(html.includes("Your app runs here"));
  assert.ok(html.includes("the app opens here"));
  // Nothing to move: the panel is already where F9 opens.
  assert.ok(!html.includes("abap2ui5.previewInPanel"));
});

test("in tab mode it says where the app really opens, and offers the move", () => {
  const html = welcomeHtml({ ...BASE, openMode: "tab" });
  assert.ok(html.includes("F9 opens your app in an editor tab"));
  assert.ok(html.includes("abap2ui5.previewInPanel"));
});

test("external mode names the browser, not a tab", () => {
  const html = welcomeHtml({ ...BASE, openMode: "external" });
  assert.ok(html.includes("F9 opens your app in your browser"));
  assert.ok(html.includes("abap2ui5.previewInPanel"));
});

test("a running app replaces the first-run steps with where it is", () => {
  const html = welcomeHtml({
    ...BASE,
    openMode: "tab",
    runningClass: "ZCL_MY_APP",
  });
  assert.ok(html.includes("ZCL_MY_APP"));
  assert.ok(html.includes("is running in an editor tab"));
  assert.ok(html.includes("abap2ui5.revealApp"));
  // The steps are for starting an app - one is already running.
  assert.ok(!html.includes("<ol>"));
});

test("without a launch URL the first step is still the launch URL", () => {
  const html = welcomeHtml({ ...BASE, hasLaunchUrl: false, openMode: "tab" });
  assert.ok(html.includes("abap2ui5.setLaunchUrl"));
  assert.ok(!html.includes("abap2ui5.selectSystem"));
});

test("the class name is escaped, not injected", () => {
  const html = welcomeHtml({
    ...BASE,
    openMode: "tab",
    runningClass: "<img src=x onerror=alert(1)>",
  });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});

// ---------------------------------------------------------------------------
// The systemless view preview
// ---------------------------------------------------------------------------

const SHOT = {
  nonce: "n0nce",
  cspSource: "vscode-resource:",
  title: "ZCL_MY_APP",
  theme: "sap_horizon",
  viewport: "1280x900",
  data: "model derived from the class",
} as const;

test("the preview shows the picture it was given, and what it is of", () => {
  const html = viewPreviewHtml({
    ...SHOT,
    shots: [{ uri: "vscode-resource://tmp/view.png?v=1", label: "view.png" }],
    errors: [],
  });
  assert.ok(html.includes("vscode-resource://tmp/view.png?v=1"));
  assert.ok(html.includes("ZCL_MY_APP"));
  assert.ok(html.includes("sap_horizon"));
  assert.ok(html.includes("1280x900"));
  // images only, and only from the webview's own source
  assert.ok(html.includes("img-src vscode-resource:"));
  assert.ok(!html.includes("<script"));
});

test("render errors are shown WITH the picture, never instead of it", () => {
  const html = viewPreviewHtml({
    ...SHOT,
    shots: [{ uri: "u", label: "view.png" }],
    errors: ["CREATE: Cannot add direct child without default aggregation"],
  });
  assert.ok(html.includes("1 render error"));
  assert.ok(html.includes("Cannot add direct child"));
  assert.ok(html.includes('src="u"'));
});

test("no picture: the panel says why in one sentence", () => {
  const html = viewPreviewHtml({
    ...SHOT,
    shots: [],
    errors: [],
    problem: "The installed render gate does not know --screenshot yet.",
  });
  assert.ok(html.includes("does not know --screenshot yet"));
  assert.ok(!html.includes("<img"));
});

test("a class name from the buffer is escaped, not injected", () => {
  const html = viewPreviewHtml({
    ...SHOT,
    title: "<img src=x onerror=alert(1)>",
    shots: [],
    errors: ["<script>alert(1)</script>"],
  });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;img"));
});

test("the caption says which data the picture shows", () => {
  // an empty table is a correct rendering of a model with no rows - without
  // this line it is indistinguishable from a broken binding
  const derived = viewPreviewHtml({ ...SHOT, shots: [], errors: [] });
  assert.ok(derived.includes("model derived from the class"));
  const mocked = viewPreviewHtml({
    ...SHOT,
    data: "zcl_travel.mock.json",
    shots: [{ uri: "u", label: "1280x900" }],
    errors: [],
  });
  assert.ok(mocked.includes("zcl_travel.mock.json"));
});

test("several pictures are laid out to be seen at once", () => {
  // a device matrix and a before/after comparison are both about comparing,
  // and stacked they would be a scroll apart
  const html = viewPreviewHtml({
    ...SHOT,
    viewport: "390x844,1280x900",
    shots: [
      { uri: "a", label: "390x844" },
      { uri: "b", label: "1280x900" },
    ],
    errors: [],
  });
  assert.ok(html.includes('class="shots'));
  assert.ok(html.includes("390x844") && html.includes("1280x900"));
});
