import { test } from "node:test";
import assert from "node:assert/strict";
import * as facade from "../webview";
import * as shared from "../webviewshared";
import * as preview from "../webviewpreview";
import * as panels from "../webviewpanels";
import * as welcome from "../webviewwelcome";

/**
 * `webview.ts` is the module everyone imports from; the markup lives in the
 * four `webview*.ts` files next to it. These tests pin that arrangement: the
 * facade hands out the very same objects, exports nothing of its own, and
 * every page is built on the one shared stylesheet.
 */

test("webview.ts re-exports the pages and helpers of the split modules unchanged", () => {
  const parts: Record<string, unknown> = { ...shared, ...preview, ...panels, ...welcome };
  const names = Object.keys(facade).sort();
  assert.deepEqual(names, [
    "DEVICE_WIDTHS",
    "LANGUAGES",
    "THEMES",
    "createNonce",
    "escapeHtml",
    "navMapHtml",
    "previewHtml",
    "propertyEditorHtml",
    "scriptJson",
    "viewPreviewHtml",
    "welcomeHtml",
  ]);
  for (const name of names) {
    assert.equal((facade as Record<string, unknown>)[name], parts[name], name);
  }
});

test("each page module owns exactly its pages", () => {
  assert.deepEqual(Object.keys(preview), ["previewHtml"]);
  assert.deepEqual(Object.keys(panels).sort(), ["navMapHtml", "propertyEditorHtml", "viewPreviewHtml"]);
  assert.deepEqual(Object.keys(welcome), ["welcomeHtml"]);
});

const VIEW_OPTIONS: panels.ViewPreviewOptions = {
  nonce: "n0nce",
  cspSource: "vscode-webview://x",
  title: "ZCL_X",
  shots: [],
  theme: "sap_horizon",
  viewport: "1280x800",
  data: "the class itself",
  errors: [],
};

test("every page carries the shared base stylesheet under its nonce", () => {
  const nonce = "n0nce";
  const pages: Record<string, string> = {
    preview: preview.previewHtml({
      nonce,
      frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
      externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
      className: "ZCL_X",
      theme: "",
      language: "",
      modelRoots: [],
    }),
    propertyEditor: panels.propertyEditorHtml(nonce),
    navMap: panels.navMapHtml({ nonce, svg: "<svg></svg>", appCount: 1, edgeCount: 0 }),
    viewPreview: panels.viewPreviewHtml(VIEW_OPTIONS),
    welcome: welcome.welcomeHtml({ nonce, hasLaunchUrl: true, openMode: "panel" }),
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(html.includes(shared.BASE_CSS), `${name}: base stylesheet`);
    assert.ok(html.includes(`nonce="${nonce}"`), `${name}: nonce`);
  }
});

test("the shared fragments: icons are inline svg, option lists escape and select", () => {
  for (const name of Object.keys(shared.ICON) as Array<keyof typeof shared.ICON>) {
    assert.match(shared.icon(name), /<svg[\s>]/, name);
  }
  const options = shared.optionList(shared.THEMES, shared.THEMES[1][0]);
  assert.equal(options.match(/ selected/g)?.length, 1);
  assert.ok(shared.optionList(shared.THEMES, '"><x').includes("&quot;&gt;&lt;x"));
});
