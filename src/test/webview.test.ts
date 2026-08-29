import { test } from "node:test";
import assert from "node:assert/strict";
import { navMapHtml, previewHtml, scriptJson, viewPreviewHtml, welcomeHtml } from "../webview";

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

test("script interpolations cannot end the script element", () => {
  // JSON.stringify leaves `<` alone, so a value containing `</script>` would
  // close the nonce'd script and put markup behind it
  assert.equal(scriptJson("</script><script>x"), '"\\u003c/script>\\u003cscript>x"');
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/x?q=</script><script>alert(1)</script>",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: ["</script>"],
    nonce: "n0nce",
  });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes('["</script>"]'));
});

test("commands and the restored model go only to the page the preview loaded", () => {
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: [],
    nonce: "n0nce",
  });
  assert.ok(html.includes("frameOrigin()"));
  assert.ok(
    !html.includes("contentWindow.postMessage(message, '*')"),
    "app commands are posted with a wildcard target again"
  );
});

test("an unknown stored theme still shows as the selected value", () => {
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "custom_house_theme",
    language: "",
    modelRoots: [],
    nonce: "n0nce",
  });
  assert.ok(html.includes('<option value="custom_house_theme" selected>'));
});

test("themes and languages the host merged in reach their pickers", () => {
  // the previewThemes/previewLanguages settings arrive as the optional
  // entry lists - the built-in lists alone would silently drop them
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: [],
    themes: [
      ["", "System theme"],
      ["z_house_theme", "House Theme"],
    ],
    languages: [
      ["", "Logon language"],
      ["CS", "Czech"],
    ],
    nonce: "n0nce",
  });
  assert.ok(html.includes('<option value="z_house_theme">House Theme</option>'));
  assert.ok(html.includes('<option value="CS">Czech</option>'));
});

test("the stale badge offers the activation, and the give-up toast is forced", () => {
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: [],
    nonce: "n0nce",
  });
  assert.ok(html.includes('id="act"'));
  assert.ok(html.includes("abap2ui5.activate"));
  assert.ok(html.includes("msg.force"));
});

test("the screenshot message names the device the preview shows", () => {
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: [],
    nonce: "n0nce",
  });
  assert.ok(html.includes("type: 'screenshot', device: stage.dataset.device"));
});

test("the slow-load hint offers the connection check", () => {
  // The wall a wrong launch URL puts up is a frame that never loads - the
  // overlay that notices it is exactly where the diagnosis belongs.
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: [],
    nonce: "n0nce",
  });
  assert.ok(html.includes('id="hint-check"'));
  assert.ok(html.includes("abap2ui5.checkConnection"));
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

test("the last launched app is one click away on the welcome screen", () => {
  const html = welcomeHtml({ ...BASE, openMode: "tab", recentApp: "ZCL_LAST" });
  assert.ok(html.includes('data-run="ZCL_LAST"'));
  assert.ok(html.includes("Run ZCL_LAST"));
  assert.ok(html.includes("runRecent"));
});

test("the relaunch offer needs a launch URL and steps aside for a running app", () => {
  const noUrl = welcomeHtml({
    ...BASE,
    hasLaunchUrl: false,
    openMode: "tab",
    recentApp: "ZCL_LAST",
  });
  assert.ok(!noUrl.includes("data-run="));
  const running = welcomeHtml({
    ...BASE,
    openMode: "tab",
    runningClass: "ZCL_MY_APP",
    recentApp: "ZCL_LAST",
  });
  assert.ok(!running.includes("data-run="));
});

test("the recent app's name is escaped, not injected", () => {
  const html = welcomeHtml({
    ...BASE,
    openMode: "tab",
    recentApp: '"><img src=x onerror=alert(1)>',
  });
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
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

// ---------------------------------------------------------------------------
// UI5 frame protection - the wire format is two strings, not JSON
// ---------------------------------------------------------------------------

test("the preview answers UI5 frame protection in the format UI5 reads", () => {
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: [],
    nonce: "n0nce",
  });

  // sap/ui/security/FrameOptions drops anything that is not a string
  // containing "SAPFrameProtection*" before it looks at it:
  //   typeof sData !== "string" || sData.indexOf("SAPFrameProtection*") === -1
  // so these two literals ARE the protocol.
  assert.ok(html.includes("SAPFrameProtection*require-origin"));
  assert.ok(html.includes("SAPFrameProtection*parent-unlocked"));

  // parent-origin only proves the parent is alive; it leaves the frame
  // blocked. A preview that embeds a url it built itself means unlocked.
  assert.ok(!html.includes("SAPFrameProtection*parent-origin"));

  // The regression this replaces: an invented JSON envelope. UI5 never sends
  // it and never reads it, so the app waited out its ten seconds and blocked
  // every click.
  assert.ok(!html.includes("sentinel"));
});

test("the preview refuses the host's own protocol from the app frame", () => {
  /*
   * The embedded app is not confined to the SAP system - it can link
   * anywhere, and any page in the iframe may postMessage to its parent. If
   * the listener took a 'load' from it, the toolbar would show a trusted
   * class name and system URL around an untrusted page, and the reload
   * button would reload THAT.
   *
   * event.source is the discriminator that cannot be forged, so it has to
   * stay in the emitted script.
   */
  const html = previewHtml({
    frameUrl: "http://127.0.0.1:1234/sap/bc/z2ui5?app_start=ZCL_X",
    externalUrl: "https://host:44300/sap/bc/z2ui5?app_start=ZCL_X",
    className: "ZCL_X",
    theme: "",
    language: "",
    modelRoots: [],
    nonce: "n0nce",
  });
  assert.ok(
    html.includes("event.source === frame.contentWindow"),
    "the provenance check is gone - the app frame can spoof the toolbar"
  );
  assert.ok(
    html.includes("if (fromApp) { return; }"),
    "the host-only branch is no longer gated on provenance"
  );
  // and the runtime marker is only honoured from the frame
  assert.ok(
    html.includes("fromApp ? msg.__abap2ui5Runtime : undefined"),
    "runtime messages are accepted from senders other than the app frame"
  );
});

test("the nav map wires clicks on nodes and on edges", () => {
  const html = navMapHtml({
    nonce: "n0nce",
    svg:
      '<svg><path class="edge" data-file="zcl_home.clas.abap" data-offset="42"/>' +
      '<g class="node" data-file="zcl_home.clas.abap"><rect/></g></svg>',
    appCount: 2,
    edgeCount: 1,
  });
  // nodes open the class, edges jump to the nav_app_call's offset
  assert.ok(html.includes(".node[data-file]"));
  assert.ok(html.includes(".edge[data-file] { cursor: pointer; pointer-events: stroke; }"));
  assert.ok(html.includes("offset: Number(edge.dataset.offset)"));
  // both handlers post the same 'open' message shape the host reads
  assert.ok(html.includes("{ type: 'open', file: node.dataset.file }"));
  assert.ok(html.includes("type: 'open'"));
});
