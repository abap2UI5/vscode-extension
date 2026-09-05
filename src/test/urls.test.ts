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
  withoutLogonParams,
  rebasedLocation,
} from "../urls";

const TEMPLATE = "https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100";

test("the protocol survives slash collapsing", () => {
  assert.equal(
    normalizeUrl("https://host//sap//bc/z2ui5"),
    "https://host/sap/bc/z2ui5"
  );
});

test("the query survives slash collapsing", () => {
  // a parameter value is allowed to carry a URL of its own
  assert.equal(
    normalizeUrl("https://host//sap/bc/z2ui5?redirect=https://x//y&p=a//b"),
    "https://host/sap/bc/z2ui5?redirect=https://x//y&p=a//b"
  );
  assert.equal(normalizeUrl("https://host//p#a//b"), "https://host/p#a//b");
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
  // a template typed without its scheme PARSES - `host:` is a scheme - and
  // has the origin "null", the string; truthy, it became the key the
  // credentials were stored under ("SAP User for null") and the origin the
  // proxy then refused to start for
  assert.equal(originOf("host:44300/sap/bc/z2ui5?app_start=ZCL_A"), undefined);
  assert.equal(originOf("data:text/plain,x"), undefined);
});

test("a template is usable only with a placeholder and a real URL", () => {
  assert.ok(isUsableTemplate(TEMPLATE));
  assert.ok(isUsableTemplate("http://host:8000/sap/bc/z2ui5?app_start={class}"));
  assert.equal(isUsableTemplate(""), false);
  assert.equal(isUsableTemplate("https://host/sap/bc/z2ui5"), false, "no placeholder");
  assert.equal(isUsableTemplate("host/{class}"), false, "not a URL");
  assert.equal(
    isUsableTemplate("host:44300/sap/bc/z2ui5?app_start={class}"),
    false,
    "scheme-less: parses, with `host:` as the scheme"
  );
  assert.equal(isUsableTemplate("ftp://host/{class}"), false, "not http(s)");
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

/*
 * The redirect header.
 *
 * `proxiedUrl` was rebuilt from parsed parts because replacing the origin
 * substring silently missed any non-normalised spelling. The redirect path
 * kept the naive replace, with the same consequence one step later: the
 * browser follows the redirect to the system directly, without the injected
 * credentials, and the preview goes white.
 */

const TARGET = new URL("https://myhost:44300/sap/bc/z2ui5");
const REDIRECT_PROXY = "http://127.0.0.1:5123/__abap2ui5/tok3n";

test("rebasedLocation rewrites a redirect back to the system", () => {
  assert.equal(
    rebasedLocation("https://myhost:44300/sap/bc/gui/start", TARGET, REDIRECT_PROXY),
    `${REDIRECT_PROXY}/sap/bc/gui/start`
  );
});

test("rebasedLocation survives a host spelled in another case", () => {
  // URL.origin lowercases the host, so this never contained the origin
  // verbatim and the old replace did nothing at all
  assert.equal(
    rebasedLocation("https://MyHost:44300/sap/bc/x", TARGET, REDIRECT_PROXY),
    `${REDIRECT_PROXY}/sap/bc/x`
  );
});

test("rebasedLocation matches a default port written either way", () => {
  const target = new URL("https://myhost/sap/bc/z2ui5");
  assert.equal(
    rebasedLocation("https://myhost:443/sap/bc/x", target, REDIRECT_PROXY),
    `${REDIRECT_PROXY}/sap/bc/x`
  );
  assert.equal(
    rebasedLocation("https://myhost/sap/bc/x", target, REDIRECT_PROXY),
    `${REDIRECT_PROXY}/sap/bc/x`
  );
});

test("rebasedLocation keeps query and hash", () => {
  assert.equal(
    rebasedLocation(
      "https://myhost:44300/sap/bc/x?sap-client=100&a=b#frag",
      TARGET,
      REDIRECT_PROXY
    ),
    `${REDIRECT_PROXY}/sap/bc/x?sap-client=100&a=b#frag`
  );
});

test("rebasedLocation follows a scheme switch on the same authority", () => {
  // http -> https on the same host:port still has to go through the proxy,
  // which is the only route carrying the credentials
  assert.equal(
    rebasedLocation("http://myhost:44300/sap/bc/x", TARGET, REDIRECT_PROXY),
    `${REDIRECT_PROXY}/sap/bc/x`
  );
});

test("rebasedLocation leaves a foreign host alone", () => {
  const idp = "https://idp.example.com/saml?RelayState=x";
  assert.equal(rebasedLocation(idp, TARGET, REDIRECT_PROXY), idp);
});

test("rebasedLocation leaves a path-relative Location untouched", () => {
  // the browser resolves these against the page's own url, token and all -
  // rewriting them would double the prefix
  assert.equal(rebasedLocation("../x", TARGET, REDIRECT_PROXY), "../x");
  assert.equal(rebasedLocation("x?y=1", TARGET, REDIRECT_PROXY), "x?y=1");
});

test("rebasedLocation puts a root-relative Location behind the token", () => {
  // `/sap/bc/x` resolves against the proxy's BARE origin, where only the
  // cookie authorizes - and the browser marks that redirected navigation
  // cross-site (its initiator is the webview), which the cookie gate refuses.
  // Behind the token it is authorized the way the page was, and its own
  // relative resources keep the prefix.
  assert.equal(
    rebasedLocation("/sap/bc/x", TARGET, REDIRECT_PROXY),
    `${REDIRECT_PROXY}/sap/bc/x`
  );
  assert.equal(
    rebasedLocation("/sap/bc/x?sap-client=100#f", TARGET, REDIRECT_PROXY),
    `${REDIRECT_PROXY}/sap/bc/x?sap-client=100#f`
  );
});

test("rebasedLocation returns nonsense unchanged rather than throwing", () => {
  assert.equal(rebasedLocation("", TARGET, REDIRECT_PROXY), "");
  assert.equal(rebasedLocation("::::", TARGET, REDIRECT_PROXY), "::::");
});

test("the logon parameters come out of a URL that leaves the extension", () => {
  // the screenshot hands its page to Chromium as an argument every process
  // of this user can read - and the proxy injects the credentials anyway
  assert.equal(
    withoutLogonParams(
      "http://127.0.0.1:3000/__abap2ui5/tok3n/sap/bc/z2ui5" +
        "?sap-user=DEVELOPER&app_start=ZCL_A&sap-password=secret&sap-client=100"
    ),
    "http://127.0.0.1:3000/__abap2ui5/tok3n/sap/bc/z2ui5?app_start=ZCL_A&sap-client=100"
  );
  // spelled in any case
  assert.equal(
    withoutLogonParams("https://host/x?SAP-USER=a&Sap-Password=b&c=1"),
    "https://host/x?c=1"
  );
  // byte-identical when there is nothing to take out - an app's own `user`
  // parameter is not SAP's, and nothing is re-serialised
  const clean = "https://host:44300/sap/bc/z2ui5?app_start=ZCL_A&user=app-param#frag";
  assert.equal(withoutLogonParams(clean), clean);
  assert.equal(withoutLogonParams("nonsense"), "nonsense");
});
