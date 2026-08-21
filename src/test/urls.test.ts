import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandTemplate,
  isUsableTemplate,
  normalizeUrl,
  originOf,
  proxiedUrl,
  sapClientOf,
  shortUrl,
  withParams,
} from "../urls";

const TEMPLATE = "https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100";

test("the protocol survives slash collapsing", () => {
  assert.equal(
    normalizeUrl("https://host//sap//bc/z2ui5"),
    "https://host/sap/bc/z2ui5"
  );
});

test("the class placeholder is replaced upper-cased and encoded", () => {
  assert.equal(
    expandTemplate(TEMPLATE, "zcl_my_app"),
    "https://host:44300/sap/bc/z2ui5?app_start=ZCL_MY_APP&sap-client=100"
  );
  assert.equal(expandTemplate("https://h/{CLASS}", "zcl_a"), "https://h/ZCL_A");
});

test("the toolbar label keeps host and path only", () => {
  assert.equal(shortUrl(expandTemplate(TEMPLATE, "zcl_a")), "host:44300/sap/bc/z2ui5");
  assert.equal(shortUrl("not a url"), "not a url");
});

test("theme and language are set and removed as plain parameters", () => {
  const url = expandTemplate(TEMPLATE, "zcl_a");
  const dark = withParams(url, { "sap-ui-theme": "sap_horizon_dark" });
  assert.ok(dark.includes("sap-ui-theme=sap_horizon_dark"));
  // An empty value means "back to the system default", not "set it to empty".
  const back = withParams(dark, { "sap-ui-theme": undefined });
  assert.equal(back.includes("sap-ui-theme"), false);
  assert.ok(back.includes("app_start=ZCL_A"));
});

test("the sap-client is read off the launch URL for the ADT lookups", () => {
  assert.equal(sapClientOf(expandTemplate(TEMPLATE, "zcl_a")), "100");
  assert.equal(sapClientOf("https://host/sap/bc/z2ui5"), undefined);
  assert.equal(sapClientOf("nonsense"), undefined);
});

test("the origin is what the proxy is started for", () => {
  assert.equal(originOf(TEMPLATE), "https://host:44300");
  assert.equal(originOf("nonsense"), undefined);
});

test("a template is usable only with a placeholder and a real URL", () => {
  assert.ok(isUsableTemplate(TEMPLATE));
  assert.equal(isUsableTemplate(""), false);
  assert.equal(isUsableTemplate("https://host/sap/bc/z2ui5"), false, "no placeholder");
  assert.equal(isUsableTemplate("host/{class}"), false, "not a URL");
});

// ---------------------------------------------------------------------------
// proxiedUrl - the launch URL rebased onto the proxy (issue #60)
// ---------------------------------------------------------------------------

const PROXY = "http://127.0.0.1:3000/__abap2ui5/tok3n";

test("a launch URL with a path keeps it behind the token", () => {
  assert.equal(
    proxiedUrl("https://host:44300/sap/bc/z2ui5?app_start=ZCL_A", PROXY),
    `${PROXY}/sap/bc/z2ui5?app_start=ZCL_A`
  );
});

test("a launch URL without a path gets a slash, so the token stays a directory", () => {
  // `https://host?app_start=X` used to become `.../__abap2ui5/<token>?...`,
  // making the token the last path segment - which the browser DROPS when it
  // resolves every relative url on the page. The bootstrap and every module
  // then asked for `/__abap2ui5/<resource>`, nothing loaded, and the preview
  // stayed white with the initial GET as the only request the system ever saw.
  const frameUrl = proxiedUrl("https://host?app_start=ZCL_A&sap-client=100", PROXY);
  assert.equal(frameUrl, `${PROXY}/?app_start=ZCL_A&sap-client=100`);
  // the resolution the fix exists for: a relative resource keeps the token
  assert.equal(
    new URL("resources/sap-ui-core.js", frameUrl).href,
    `${PROXY}/resources/sap-ui-core.js`
  );
});

test("an origin the URL never spells verbatim still lands on the proxy", () => {
  // URL.origin is normalised (lowercased host, default port dropped), so
  // replace(origin, proxyOrigin) was a no-op for these - the iframe then
  // loaded the SYSTEM directly, without the credentials the proxy injects.
  assert.equal(
    proxiedUrl("https://MyHost.example.com/sap/bc/z2ui5?app_start=X", PROXY),
    `${PROXY}/sap/bc/z2ui5?app_start=X`
  );
  assert.equal(
    proxiedUrl("https://host:443/sap/bc/z2ui5", PROXY),
    `${PROXY}/sap/bc/z2ui5`
  );
});

test("something that is not a URL yields no frame URL", () => {
  assert.equal(proxiedUrl("nonsense", PROXY), undefined);
});
