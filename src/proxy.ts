import * as http from "http";
import * as https from "https";
import type { Duplex } from "stream";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { StringDecoder } from "string_decoder";
import { URL } from "url";
import { redact } from "./report";
import { rebasedLocation } from "./urls";

/** Non-2xx answer from the ADT class lookup, with the status to decide on. */
export class AdtStatusError extends Error {
  constructor(public readonly status: number) {
    super(`ADT answered ${status}`);
  }
}

/** What the ADT metadata of a class says about its current state. */
export interface AdtClassState {
  version?: "active" | "inactive";
  /** Timestamp of the last change, e.g. `2026-07-29T23:28:37Z`. */
  changedAt?: string;
}

/**
 * Small local reverse proxy: accepts requests on 127.0.0.1 and forwards them
 * to the SAP system, injecting the basic-auth header into EVERY request. That
 * way the embedded browser (webview iframe) needs no login of its own and does
 * not run into a 401.
 *
 * All paths are forwarded transparently (UI5 resources under /sap/public,
 * /sap/bc/ui5_ui5 and so on), since the iframe sends root-relative paths to
 * the proxy automatically.
 */
/** What the system answered to one forwarded request. */
export interface ProxyResponse {
  status: number;
  /** Request path, for the log line. */
  path: string;
  /**
   * The `WWW-Authenticate` header of a rejected request, verbatim. It is the
   * one field that says whether the system offered basic auth at all - a
   * system that answers 401 WITHOUT it is not asking for a password, and no
   * amount of retyping one will help.
   */
  authenticate?: string;
  /**
   * What the rejection page said, flattened to one line and redacted - "User
   * is locked", "Password must be changed", "Logon not possible in client
   * 100". The status alone cannot tell those apart.
   */
  reason?: string;
}

/**
 * How much of a rejection body to read. The sentence worth having is at the
 * top of the page; reading further only risks pulling a session id into a log
 * that gets pasted into issues.
 */
const REJECTION_SNIFF_BYTES = 4096;

/**
 * Tags out, entities and runs of whitespace collapsed.
 *
 * The end tags allow whitespace before the `>` - `</script >` closes a
 * script exactly as `</script>` does, and a pattern that insists on the
 * bare form does not match it, leaves the element unremoved, and then has
 * its tags stripped by the general rule below. What is left is the script
 * BODY, in the one line that goes to the output channel and from there into
 * a pasted bug report - which is the opposite of what the redaction in this
 * file is for.
 */
function flatten(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The one line of a rejection page worth logging.
 *
 * SAP answers a refused logon with a full HTML page whose first line is a
 * doctype, so the naive "first line of the body" says nothing. The title
 * carries the message on the ICF logon error page; anything else falls back
 * to the flattened body. Redacted, because this ends up in the output channel
 * and from there in bug reports.
 */
export function describeRejection(body: string): string | undefined {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = flatten(title?.[1] ?? "") || flatten(body);
  return text ? redact(text).slice(0, 200) : undefined;
}

/** A response header as one string, whatever shape node hands over. */
function headerValue(value: string | string[] | undefined): string | undefined {
  const text = Array.isArray(value) ? value.join(", ") : value;
  return text ? text : undefined;
}

/** One finished request/response pair, as the traffic log records it. The
 *  duration spans first byte out to last byte in - the full roundtrip the
 *  user waits for, not the time to first byte. */
export interface TrafficEntry {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  /** Response body size as received (before any hook injection). */
  bytes: number;
}

// ---------------------------------------------------------------------------
// Runtime-error forwarding
// ---------------------------------------------------------------------------

/*
 * The embedded iframe swallows everything the running app says: a thrown
 * error, a failed assertion, a rejected promise are visible only in the
 * browser devtools - exactly the context switch the preview exists to avoid.
 * The proxy is the one place every HTML response passes through, so it plants
 * a small hook that forwards window errors, unhandled rejections and
 * console.error to the embedding page via postMessage. The preview webview
 * relays them to the extension host, which writes them to the abap2UI5
 * output channel and counts them in the toolbar.
 */

/** Marker property of the forwarded messages - the webview filters on it. */
export const RUNTIME_MESSAGE_MARKER = "__abap2ui5Runtime";

/** Per page load, so a render loop cannot flood the channel. */
const RUNTIME_MESSAGE_CAP = 50;

/** The hook itself. ES5 on purpose: it runs inside whatever the system
 *  serves, which may be an old-browser error page.
 *
 *  Beyond the error forwarding it answers two commands the preview posts
 *  into the iframe (marked `__abap2ui5Cmd`):
 *
 *  - `inspect`: highlight the hovered UI5 control and, on click, send the
 *    control's type/id chain up to the preview - the extension matches it
 *    against the reconstructed view and jumps to the builder call. One-shot:
 *    a click (or Escape) ends the mode and says so.
 *  - `model`: send the app's default JSON model data - the running
 *    counterpart of the statically derived model shape.
 *
 *  The hook runs inside the app page itself, so it may use the app's own
 *  `sap` global to resolve DOM elements to real controls. */
const RUNTIME_HOOK = `<script>/*abap2ui5-runtime-hook*/(function(){
var sent=0;
function post(m){try{parent.postMessage(m,'*');}catch(e){}}
function send(kind,text){
  if(sent>=${RUNTIME_MESSAGE_CAP})return;
  sent++;
  post({${RUNTIME_MESSAGE_MARKER}:kind,text:String(text).slice(0,2000)});
}
window.addEventListener('error',function(e){
  var msg=e&&e.message?e.message:'Script error';
  if(e&&e.filename){msg+=' ('+e.filename.split('/').pop()+':'+e.lineno+')';}
  send('error',msg);
});
window.addEventListener('unhandledrejection',function(e){
  var r=e&&e.reason;
  send('rejection',(r&&(r.stack||r.message))||String(r));
});
var orig=console.error;
console.error=function(){
  var parts=[];
  for(var i=0;i<arguments.length;i++){
    var a=arguments[i];
    parts.push(a&&a.stack?a.stack:String(a));
  }
  send('console',parts.join(' '));
  return orig.apply(console,arguments);
};

// ---- controls: DOM element -> UI5 control -------------------------------
function byId(id){
  try{if(window.sap&&sap.ui&&sap.ui.getCore){var c=sap.ui.getCore().byId(id);if(c)return c;}}catch(e){}
  try{return sap.ui.core.Element.registry.get(id);}catch(e){}
  return null;
}
function controlEl(t){
  while(t&&t!==document.documentElement){
    if(t.getAttribute&&t.getAttribute('data-sap-ui'))return t;
    t=t.parentNode;
  }
  return null;
}

// ---- inspect mode -------------------------------------------------------
var inspectOn=false,hoverEl=null,prevOutline='';
function clearHover(){
  if(hoverEl){hoverEl.style.outline=prevOutline;hoverEl=null;}
}
function setInspect(on){
  if(on===inspectOn)return;
  inspectOn=on;
  clearHover();
  document.documentElement.style.cursor=on?'crosshair':'';
}
document.addEventListener('mouseover',function(e){
  if(!inspectOn)return;
  var el=controlEl(e.target);
  if(el===hoverEl)return;
  clearHover();
  if(el){hoverEl=el;prevOutline=el.style.outline;el.style.outline='2px solid #0a84ff';}
},true);
document.addEventListener('click',function(e){
  if(!inspectOn)return;
  e.preventDefault();e.stopPropagation();
  var el=controlEl(e.target);
  var chain=[];
  var ctrl=el&&byId(el.getAttribute('data-sap-ui'));
  while(ctrl&&chain.length<15){
    try{chain.push({type:ctrl.getMetadata().getName(),id:ctrl.getId()});}catch(ex){}
    ctrl=ctrl.getParent&&ctrl.getParent();
  }
  setInspect(false);
  post({${RUNTIME_MESSAGE_MARKER}:'inspect-state',on:false});
  if(chain.length){post({${RUNTIME_MESSAGE_MARKER}:'inspect',chain:chain});}
},true);
document.addEventListener('keydown',function(e){
  if(inspectOn&&e.key==='Escape'){
    setInspect(false);
    post({${RUNTIME_MESSAGE_MARKER}:'inspect-state',on:false});
  }
},true);

// ---- model dump ---------------------------------------------------------
function appModel(){
  var el=document.querySelector('[data-sap-ui]');
  var ctrl=el&&byId(el.getAttribute('data-sap-ui'));
  var model=ctrl&&ctrl.getModel&&ctrl.getModel();
  if(!model&&window.sap&&sap.ui&&sap.ui.getCore&&sap.ui.getCore().getModel){
    model=sap.ui.getCore().getModel();
  }
  return model;
}
function sendModel(kind){
  try{
    var model=appModel();
    if(!model||!model.getData){
      post({${RUNTIME_MESSAGE_MARKER}:kind,error:'no JSON model found on the app (is it still loading?)'});
      return;
    }
    var text=JSON.stringify(model.getData());
    post({${RUNTIME_MESSAGE_MARKER}:kind,text:String(text).slice(0,2000000)});
  }catch(ex){
    post({${RUNTIME_MESSAGE_MARKER}:kind,error:String(ex)});
  }
}

// ---- model restore (stateful reload) ------------------------------------
// The preview captured the model before a reload; the fresh page's model
// only exists once the UI5 bootstrap and the first backend answer are
// through, so the restore retries until it finds one.
function tryRestore(data,left){
  try{
    var model=appModel();
    if(model&&model.setData&&model.getData&&model.getData()){
      model.setData(data,true); // merge - new keys of the fresh load survive
      post({${RUNTIME_MESSAGE_MARKER}:'restored'});
      return;
    }
  }catch(ex){}
  if(left>0){setTimeout(function(){tryRestore(data,left-1);},500);}
}

// ---- commands from the preview ------------------------------------------
window.addEventListener('message',function(evt){
  // only the preview that embeds this page may drive it: an iframe the app
  // itself embeds can post here too, and 'restore' would let it write the
  // app's model - which the app then sends on to the system
  if(evt.source!==window.parent)return;
  var cmd=evt&&evt.data&&evt.data.__abap2ui5Cmd;
  if(!cmd)return;
  if(cmd==='inspect'){setInspect(!!evt.data.on);}
  if(cmd==='model'){sendModel('model');}
  if(cmd==='model-restore'){sendModel('model-restore');}
  if(cmd==='restore'&&evt.data.data){tryRestore(evt.data.data,20);}
});
})();</script>`;

/**
 * Plants the hook into an HTML document, as early as possible so it is
 * installed before the UI5 bootstrap runs: right after `<head>`, else right
 * after `<html>`, else in front of everything. Returns the input unchanged
 * only when it is not recognisable as an HTML document at all.
 */
/**
 * The bootstrap attribute that decides whether a framed app may run, in both
 * spellings UI5 accepts.
 */
const FRAME_OPTIONS_ATTR =
  /(\bdata-sap-ui-frame-?options\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * Turns `sap-ui-frameOptions` into `allow` on every page this proxy serves.
 *
 * abap2UI5 ships `data-sap-ui-frameOptions="trusted"`, and in an iframe that
 * mode NEVER unlocks here - not for want of an answer, but by construction.
 * `sap/ui/security/FrameOptions` blocks the document the moment it finds
 * itself framed (`_lock( )` puts a capture-phase handler that calls
 * `preventDefault( )` on every input event), and it only lifts that block from
 * `_applyState(bRunnable, bParentUnlocked)`, which needs BOTH flags. The
 * preview can supply the second one and never the first:
 *
 *   - `bRunnable` comes from a same-origin parent, or from an allowlist
 *     matching the parent's origin. Our parent is the webview, whose origin is
 *     `vscode-webview://<id>` - not the system's, and in nobody's allowlist.
 *   - the first message from the parent runs `_check( )` BEFORE the
 *     "parent-unlocked" branch, and `_check( )` with no allowlist and no
 *     allowlist service ends in `_callback(false)`: "Embedding blocked because
 *     the allowlist or the allowlist service is not configured correctly".
 *
 * So the app rendered, ate every click, and 0.24.1's correct-on-the-wire
 * answer changed only WHICH log line explained it. The mode itself has to go.
 *
 * Which is defensible exactly here: frame protection exists to stop a FOREIGN
 * page from framing an SAP app and harvesting clicks. The framing page is this
 * extension, the url is the one it built from the configured system, and it is
 * served over loopback behind a capability token. There is no third party in
 * this picture - and the alternative is not a safer preview, it is one nobody
 * can click.
 *
 * Only the bootstrap attribute is rewritten. A page that configures the mode
 * some other way (a `window["sap-ui-config"]` object) keeps it, and stays
 * locked - abap2UI5 does not, and inventing a JavaScript rewrite for a shape
 * nobody serves is how the last two attempts at this went wrong.
 */
export function allowFraming(html: string): string {
  return html.replace(FRAME_OPTIONS_ATTR, '$1"allow"');
}

export function injectRuntimeHook(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + RUNTIME_HOOK + html.slice(at);
  }
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + RUNTIME_HOOK + html.slice(at);
  }
  if (/^\s*(<!doctype|<)/i.test(html)) {
    return RUNTIME_HOOK + html;
  }
  return html;
}

/** Documents bigger than this are streamed through untouched - an HTML this
 *  size is not the app page the hook is for. */
const INJECT_MAX_BYTES = 5 * 1024 * 1024;

/** The charset a `Content-Type` declares, lowercased, or "" when it is silent. */
function charsetOf(contentType: string): string {
  return (
    /;\s*charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1].toLowerCase() ?? ""
  );
}

/**
 * The body of an injectable document as text. Everything the hook is planted
 * into gets re-encoded as UTF-8, so a document that arrived in one of the
 * single-byte charsets an old ICM still serves its logon and error pages in
 * has to be decoded as such first - `toString("utf8")` turned every umlaut on
 * those pages into replacement characters.
 */
export function decodeBody(body: Buffer, contentType: string): string {
  const charset = charsetOf(contentType);
  const latin1 =
    charset === "iso-8859-1" ||
    charset === "iso8859-1" ||
    charset === "latin1" ||
    charset === "windows-1252" ||
    charset === "cp1252";
  return body.toString(latin1 ? "latin1" : "utf8");
}

/** The same `Content-Type` with its charset set to UTF-8, which is what the
 *  injected document is encoded in when it leaves. */
export function withUtf8Charset(contentType: string): string {
  if (!contentType) {
    return "text/html; charset=utf-8";
  }
  return charsetOf(contentType)
    ? contentType.replace(/;\s*charset\s*=\s*"?[\w-]+"?/i, "; charset=utf-8")
    : `${contentType}; charset=utf-8`;
}

/** One class reference out of an ADT quick-search answer. */
export interface AdtClassRef {
  name: string;
  /** The class's short text, when the answer carried one. */
  description?: string;
  /** The package the class lives in, when the answer carried it. */
  packageName?: string;
}

/** The five named XML entities, plus the numeric forms. An attribute value
 *  arrives escaped - a short text of `Sales &amp; Distribution` used to reach
 *  the QuickPick with the `&amp;` still in it. */
function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
  };
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (all, entity: string) => {
      if (entity[0] === "#") {
        const code =
          entity[1] === "x" || entity[1] === "X"
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
      }
      return named[entity.toLowerCase()];
    }
  );
}

/** One attribute of a matched tag, entity-decoded; undefined when absent or
 *  empty. */
function attributeOf(tag: string, name: string): string | undefined {
  const raw = new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  return raw ? decodeXmlEntities(raw) : undefined;
}

/**
 * Class references out of an ADT quick-search answer. The tag's attribute
 * order is not fixed, so the tag is matched first and its attributes second;
 * only classes count (`CLAS/OC`) - the search itself is not told, because not
 * every ADT version accepts the filter parameter.
 */
export function parseAdtClassRefs(xml: string): AdtClassRef[] {
  const refs: AdtClassRef[] = [];
  for (const tag of xml.matchAll(/<adtcore:objectReference\b[^>]*>/g)) {
    const type = attributeOf(tag[0], "adtcore:type");
    const name = attributeOf(tag[0], "adtcore:name");
    if (type !== "CLAS/OC" || !name || refs.some((ref) => ref.name === name)) {
      continue;
    }
    refs.push({
      name,
      description: attributeOf(tag[0], "adtcore:description"),
      packageName: attributeOf(tag[0], "adtcore:packageName"),
    });
  }
  return refs;
}

/**
 * The host a request to `target` is opened against. `URL.hostname` keeps the
 * brackets of an IPv6 literal (`https://[fd00::10]:44300/` -> `[fd00::10]`),
 * and Node hands that string to getaddrinfo as if it were a name - ENOTFOUND,
 * which the connection check then read as "the hostname does not resolve".
 * The same thing `url.urlToHttpOptions( )` does to the field, kept explicit
 * because three request sites here depend on it.
 */
export function requestHostname(target: URL): string {
  return target.hostname.replace(/^\[(.*)\]$/, "$1");
}

/**
 * A `Set-Cookie` from the system, made valid on the proxy's origin.
 *
 * Three attributes describe the SYSTEM's authority and break on loopback:
 * `Domain` (the system's host - the browser refuses it for 127.0.0.1),
 * `Path` (a cookie scoped to `/sap/bc/z2ui5` is never sent with the
 * `/__abap2ui5/<token>/sap/bc/z2ui5` requests the page actually makes, so
 * every such session cookie was set and then silently never returned), and
 * `Secure` - which goes unless the cookie needs it: a `SameSite=None` cookie
 * without `Secure` is dropped outright by the webview's Chromium, so stripping
 * it there loses the session cookie of every system configured per SAP's
 * cross-site notes - and loopback counts as a trustworthy origin, so Secure is
 * accepted over http anyway.
 *
 * Exported for the tests; the plain path and the relayed 101 of a WebSocket
 * upgrade both apply it, so a cookie planted on the handshake is as valid as
 * one planted on a page.
 */
export function rewriteSetCookie(cookie: string): string {
  const rebased = cookie
    .replace(/;\s*Domain=[^;]*/i, "")
    .replace(/;\s*Path=[^;]*/i, "; Path=/");
  return /;\s*SameSite\s*=\s*None\b/i.test(rebased)
    ? rebased
    : rebased.replace(/;\s*Secure\b/i, "");
}

/**
 * A `Referer` the browser addressed to the proxy, as the system would have
 * seen it. Rewritten by SHAPE rather than by replacing the long-lived base:
 * a page loaded through a one-shot url (the screenshot) refers to itself as
 * `http://127.0.0.1:<port>/__abap2ui5/<one-shot>/...`, which the base never
 * matched - so the one-shot token, spent but recognisable, travelled on to
 * the system in every follow-up request. Any token-shaped first segment goes;
 * a bare proxy url (a cookie-authorized page) is rebased on its own. A
 * referer that is not this proxy's is left alone.
 */
export function rebasedReferer(
  referer: string,
  proxyOrigin: string,
  target: URL
): string {
  const base = new URL(proxyOrigin).origin; // http://127.0.0.1:<port>
  if (!referer.startsWith(base)) {
    return referer;
  }
  const rest = referer.slice(base.length);
  if (rest && !/^[/?#]/.test(rest)) {
    return referer; // another port that merely starts with these digits
  }
  const prefixed = new RegExp(`^/${TOKEN_SEGMENT}/[A-Za-z0-9_-]+(?=[/?#]|$)`).exec(
    rest
  );
  const path = prefixed ? rest.slice(prefixed[0].length) : rest;
  return target.origin + (path.startsWith("/") ? path : `/${path}`);
}

/** First segment of every url the proxy hands out, so the token that follows
 *  cannot be mistaken for a path on the system. */
const TOKEN_SEGMENT = "__abap2ui5";

/** Carries the token on requests whose path the proxy never sees prefixed -
 *  an app configured with an absolute bootstrap (`/sap/public/...`) asks for
 *  it from the server root. Planted on the first answer, HttpOnly so the page
 *  itself cannot read it back out. The name carries the PORT: cookies are
 *  host-scoped, not port-scoped, so two windows' proxies (two systems at
 *  once is a supported setup) would otherwise overwrite each other's cookie
 *  and break the other window's absolute-path requests. */
const TOKEN_COOKIE = "__abap2ui5_proxy";

/**
 * Whether two tokens match, in constant time. The gate compares against
 * whatever a caller sent, and a local process gets unlimited low-jitter
 * attempts against loopback - hashing first makes the comparison's timing
 * independent of where the strings diverge.
 */
function tokensEqual(candidate: string, token: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(token).digest()
  );
}

/** The loopback names a browser can have connected through. Anything else in
 *  the Host header means the request arrived under a different hostname than
 *  the one the proxy hands out - the shape of a DNS rebinding attempt. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

/**
 * Whether a request's `Host` is one this machine's own loopback can be
 * reached under.
 *
 * Exported because EVERY local listener that acts with the system
 * credentials owes its callers this check, not just this one - a port on
 * 127.0.0.1 is reachable by any process on the machine and by any page that
 * resolves a name to loopback. The system MCP server is the second such
 * listener and shares it; a third must too.
 */
export function isLoopbackHost(host: string | undefined): boolean {
  return LOOPBACK_HOST.test(String(host ?? ""));
}

/** How long a forwarded request may go QUIET before the proxy gives up - an
 *  inactivity timeout, so a slow but progressing download survives. Without
 *  it a system that accepts the connection and then says nothing holds the
 *  request - and the preview - open with nothing to show for it. */
const FORWARD_TIMEOUT_MS = 120_000;

/** Absolute deadline for the small text answers `fetchFromSystem` asks for -
 *  a socket-inactivity timeout would let a trickling server hold an ADT
 *  lookup open forever. */
const FETCH_TIMEOUT_MS = 8000;

/** Everything asked for via `fetchFromSystem` is a small text answer - once
 *  this much arrived, the rest is not worth downloading. */
const FETCH_BODY_CAP = 256 * 1024;

/** How many minted-but-unused one-shot tokens are kept - see
 *  `SapProxy.singleUseTokens`. The oldest is dropped beyond this. */
const SINGLE_USE_MAX = 8;

/** The request headers that describe one hop rather than the request, and so
 *  must not travel through a proxy (RFC 7230 section 6.1). `transfer-encoding`
 *  stays: Node manages the framing of what it forwards itself. */
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "upgrade",
];

export class SapProxy {
  private server?: http.Server;
  private port?: number;
  private target?: URL;
  private authHeader?: string;
  /**
   * The shared secret in the proxy's own urls. The port is random but
   * scannable, and every request the proxy forwards carries the system
   * credentials - so without a secret any process on this machine, and any
   * web page that reaches loopback, could drive an authenticated session
   * against the SAP system (ADT included). Same construction the system MCP
   * server uses for the same reason (see mcpsystem.ts).
   *
   * It sits in the path rather than in a header because the browser has to
   * carry it on its own: the preview loads the app page, and the app page
   * then asks for `resources/sap-ui-core.js` and posts its roundtrips
   * RELATIVE to that url, so a prefix travels with them at no cost.
   */
  private token?: string;

  /**
   * Secondary tokens, each accepted for exactly ONE authorized request and
   * retired the moment it is used.
   *
   * They exist for the one caller that cannot receive the long-lived token
   * privately: headless Chromium takes the page to shoot only as a command
   * line argument, and an argument vector is readable by every process of
   * this user (`ps`, /proc/<pid>/cmdline). What leaked there used to be the
   * capability token itself - good for an authenticated session against the
   * system for as long as the proxy ran. A one-shot token is spent on the
   * screenshot's very first request, and the page's follow-up requests are
   * carried by the HttpOnly cookie that first authorized answer plants.
   *
   * A minted token that is never used just sits here, so the set is capped -
   * a screenshot that never starts must not grow this without bound.
   */
  private readonly singleUseTokens = new Set<string>();

  /** Live WebSocket tunnels. An upgraded socket no longer belongs to the
   *  http server, so `close( )` neither waits for it nor closes it - stop( )
   *  has to take these down itself or hang on them forever. */
  private readonly tunnels = new Set<Duplex>();

  /**
   * Whether requests to the system may proceed when its TLS certificate
   * cannot be verified (self-signed, private CA, hostname mismatch).
   * Defaults to true because typical SAP dev systems serve self-signed
   * certificates - the `abap2ui5.allowUnauthorizedCerts` setting feeds it.
   */
  allowUnauthorized = true;

  /**
   * Called for every answer the system gives. The proxy is the only place
   * that sees them: inside the iframe a 401 is just a blank or unhelpful
   * page, and the extension used to have nothing to say about it. The host
   * uses this to turn a rejected logon into an actionable message.
   */
  onResponse?: (response: ProxyResponse) => void;

  /**
   * Set when the system rejected the injected credentials with 401.
   *
   * A UI5 page asks for dozens of resources, and the proxy puts the same
   * user and password on every one of them - so ONE wrong password produces a
   * burst of failed logons, and a system with a lockout policy counts every
   * one of them. Eleven in a few seconds is what a single F9 was observed to
   * send. While this is set the proxy answers locally instead of asking the
   * system again; `start( )` clears it, which is what re-entering the
   * credentials (and every F9) goes through.
   */
  private authRejected = false;

  /** Called once per finished response, with the full roundtrip timing -
   *  what feeds the traffic log and the toolbar's roundtrip badge. */
  onTraffic?: (entry: TrafficEntry) => void;

  /**
   * Serialises start/stop. Both await the network, and two overlapping calls
   * (F9 racing "Run an App from the System", or the 401 re-logon) used to
   * close the same old server and then each assign `this.server` - leaving
   * the loser listening forever with the credentials still injected, on a
   * port nothing could close again.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.queue.then(op, op);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Starts the proxy (or just refreshes auth if the target stays the same). */
  start(targetOrigin: string, user: string, pass: string): Promise<number> {
    return this.serialize(() => this.startNow(targetOrigin, user, pass));
  }

  private async startNow(
    targetOrigin: string,
    user: string,
    pass: string
  ): Promise<number> {
    const target = new URL(targetOrigin);
    const authHeader =
      "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    // new credentials are a new attempt, whether or not the server restarts
    this.authRejected = false;

    if (this.server && this.target && this.target.origin === target.origin) {
      this.authHeader = authHeader;
      return this.port!;
    }

    // assigned after stop( ), which clears the credentials of the proxy it
    // tears down - including, before this order, the ones just handed in
    await this.stopNow();
    this.authHeader = authHeader;
    this.target = target;
    this.token = randomBytes(16).toString("base64url");
    // one-shot tokens belong to the proxy that minted them
    this.singleUseTokens.clear();
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head)
    );

    try {
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", resolve);
      });
    } catch (err) {
      // a proxy that never got its port must not LOOK started: the
      // same-origin fast path above would keep handing out
      // `http://127.0.0.1:undefined/...` forever
      await this.stopNow();
      throw err;
    }

    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this.port;
  }

  /**
   * Base url of the running proxy, token included - swap the system's origin
   * for this one and the resulting url is both routed and authorized. Callers
   * do not have to know about the token: it is part of what they replace, and
   * everything the page asks for afterwards is relative to it.
   */
  get origin(): string {
    return `http://127.0.0.1:${this.port}/${TOKEN_SEGMENT}/${this.token}`;
  }

  /** True once start() succeeded, i.e. target and credentials are known. */
  get isRunning(): boolean {
    return !!this.server && !!this.target && !!this.authHeader;
  }

  /** Which SYSTEM this proxy currently forwards to, normalised - undefined
   *  while it is not running. Callers that remember something about a system
   *  (rather than about the proxy) key it on this, so switching systems does
   *  not carry the old one's verdict over. */
  get systemOrigin(): string | undefined {
    return this.target?.origin;
  }

  /** The cookie name of THIS proxy - see {@link TOKEN_COOKIE} on the port. */
  private get cookieName(): string {
    return `${TOKEN_COOKIE}_${this.port}`;
  }

  /**
   * The system path an incoming request is asking for, or undefined when the
   * request has no business here. Two ways to be authorized, and a request
   * that is neither is answered 404 rather than told what it got wrong.
   */
  private route(req: http.IncomingMessage): string | undefined {
    // Fail closed while the proxy is not fully started: during stop( )'s
    // close window the token is already gone, and `undefined === undefined`
    // used to AUTHORIZE a cookie-less request against the cleared state.
    const token = this.token;
    if (!token || !this.target || !this.authHeader || this.port === undefined) {
      return undefined;
    }

    // A browser sends the host it connected to. Ours is always loopback, so
    // anything else is a name that resolves here without being ours - which
    // is what DNS rebinding looks like from this side.
    if (!isLoopbackHost(req.headers.host)) {
      return undefined;
    }

    const url = String(req.url ?? "/");
    // Origin-form only. A browser addressing an origin server sends the path
    // (`GET /x HTTP/1.1`); the absolute form (`GET http://127.0.0.1:<port>/x`)
    // is a forward-proxy request nobody legitimately makes here - and it used
    // to fall through to the cookie branch below and be forwarded VERBATIM,
    // token segment included, to the system.
    if (!url.startsWith("/")) {
      return undefined;
    }
    const root = `/${TOKEN_SEGMENT}/`;
    if (url.startsWith(root)) {
      const rest = url.slice(root.length);
      const end = rest.search(/[/?]/);
      const candidate = end === -1 ? rest : rest.slice(0, end);
      // The one-shot token is spent HERE, where authorization is decided:
      // the request it authorizes goes through, its answer plants the
      // cookie the page's follow-up requests ride on, and the token itself
      // is refused from the next request on. Only the prefixed form counts -
      // a one-shot token is never accepted out of a cookie.
      if (tokensEqual(candidate, token) || this.spendSingleUse(candidate)) {
        if (end === -1) {
          return "/";
        }
        // a launch url without a path (`https://host:44300?app_start=...`)
        // leaves the query directly behind the prefix - forwarding it as
        // written would put `GET ?app_start=... HTTP/1.1` on the wire,
        // which servers reject
        return rest[end] === "?" ? "/" + rest.slice(end) : rest.slice(end);
      }
    }

    // No prefix: only the cookie from an earlier authorized answer counts -
    // and only from the page it was planted for. The cookie is host-scoped
    // and SameSite=None (it has to travel from the framed page), so every
    // page in the webview's cookie jar carries it: a foreign <img>, iframe or
    // form on 127.0.0.1:<another port> would ride it, with the Origin rewrite
    // in `prepareForwardHeaders` making the request look same-origin to the
    // system. The browser says where a request comes from: `same-origin` is
    // the app page's own resources and roundtrips, `none` a user-initiated
    // navigation (the headless screenshot), an absent header a client that is
    // not a browser. Anything else is cross-site by its own account.
    const site = headerValue(req.headers["sec-fetch-site"]);
    if (site && site !== "same-origin" && site !== "none") {
      return undefined;
    }
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${this.cookieName}=`));
    return cookie && tokensEqual(cookie.slice(this.cookieName.length + 1), token)
      ? url
      : undefined;
  }

  /**
   * Whether `candidate` is one of the outstanding one-shot tokens - and if
   * so, retires it. Compared in constant time like the long-lived one.
   */
  private spendSingleUse(candidate: string): boolean {
    for (const oneShot of this.singleUseTokens) {
      if (tokensEqual(candidate, oneShot)) {
        this.singleUseTokens.delete(oneShot);
        return true;
      }
    }
    return false;
  }

  /**
   * The same url, authorized by a freshly minted ONE-SHOT token instead of
   * the proxy's long-lived one - for a consumer that cannot keep the url
   * private. Returns the url unchanged when it does not belong to this
   * proxy, or while the proxy is not running: an unrecognised url is not
   * this method's to rewrite.
   *
   * See `singleUseTokens` for why the screenshot needs it.
   */
  singleUseUrl(url: string): string {
    const base = this.origin;
    if (!this.token || this.port === undefined || !url.startsWith(base)) {
      return url;
    }
    if (this.singleUseTokens.size >= SINGLE_USE_MAX) {
      // insertion order: the oldest minted-but-unused token goes first
      const oldest = this.singleUseTokens.values().next().value;
      if (oldest !== undefined) {
        this.singleUseTokens.delete(oldest);
      }
    }
    const oneShot = randomBytes(16).toString("base64url");
    this.singleUseTokens.add(oneShot);
    return (
      `http://127.0.0.1:${this.port}/${TOKEN_SEGMENT}/${oneShot}` +
      url.slice(base.length)
    );
  }

  /**
   * One GET against the system with the credentials the proxy already holds -
   * what the ADT lookups and the UI5-version detection are built on. The
   * body is capped: everything asked for this way is a small text answer.
   *
   * `background` marks a best-effort probe nobody asked for: its 401 must
   * neither trip the retry breaker (`authRejected`) nor raise the re-logon
   * prompt - a probe against the wrong client would otherwise break a
   * launch whose own credentials are fine. `signal` aborts the request, for
   * callers that supersede their own lookups while the user types.
   * `timeoutMs` widens the default deadline, for a caller that would rather
   * wait than misread a slow answer as an unreachable host - the connection
   * check, against an ICF service compiling on its first request.
   */
  fetchFromSystem(
    path: string,
    accept = "application/xml, application/json, */*",
    options: { background?: boolean; signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<{ status: number; body: string; authenticate?: string }> {
    const target = this.target;
    const auth = this.authHeader;
    if (!target || !auth) {
      return Promise.reject(new Error("proxy not started"));
    }
    if (this.authRejected) {
      // the activation poller runs on a timer, so without this it would keep
      // offering the rejected password long after the user stopped looking
      return Promise.reject(
        new Error("the system rejected the stored credentials")
      );
    }
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: target.protocol,
          hostname: requestHostname(target),
          port: target.port || (isHttps ? 443 : 80),
          method: "GET",
          path,
          headers: {
            authorization: auth,
            accept,
          },
          rejectUnauthorized: !this.allowUnauthorized,
          signal: options.signal,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let body = "";
          let settled = false;
          res.setEncoding("utf8");
          const finish = () => {
            if (settled) {
              return;
            }
            settled = true;
            // A rejection here used to be silent: these requests happen on a
            // timer rather than on a keystroke, so nothing in the UI said the
            // logon had stopped working.
            const authenticate = headerValue(res.headers["www-authenticate"]);
            if ((status === 401 || status === 403) && !options.background) {
              if (status === 401) {
                this.authRejected = true;
              }
              this.onResponse?.({
                status,
                path,
                authenticate,
                reason: describeRejection(body),
              });
            }
            // The header travels with the answer too: the connection check
            // needs it to tell "wrong password" from "no basic auth at all".
            resolve({ status, body, authenticate });
          };
          res.on("data", (chunk: string) => {
            if (body.length < FETCH_BODY_CAP) {
              body += chunk;
            } else {
              // enough arrived to answer with - stop downloading the rest
              finish();
              res.destroy();
            }
          });
          res.on("end", finish);
          // a connection that dies mid-body emits on the RESPONSE stream, and
          // an unhandled "error" there takes the extension host down with it
          res.on("error", (err) => {
            if (!settled) {
              reject(err);
            }
          });
        }
      );
      const deadline = setTimeout(
        () => req.destroy(new Error("request to the system timed out")),
        options.timeoutMs ?? FETCH_TIMEOUT_MS
      );
      req.on("close", () => clearTimeout(deadline));
      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Reads the activation state of a class from the system's ADT service
   * (`/sap/bc/adt/oo/classes/<name>`), using the credentials the proxy already
   * injects. The root element's `adtcore:version` attribute is `inactive`
   * while a saved-but-not-activated version exists and flips back to `active`
   * on activation, and `adtcore:changedAt` moves with every change — together
   * the only way to notice an activation done outside this extension, since
   * VS Code has no event for it.
   *
   * Resolves to whatever of the two the answer carried. Rejects with an
   * {@link AdtStatusError} on a non-2xx status.
   */
  async fetchClassState(
    className: string,
    sapClient?: string
  ): Promise<AdtClassState> {
    const path =
      "/sap/bc/adt/oo/classes/" +
      encodeURIComponent(className.toLowerCase()) +
      (sapClient ? `?sap-client=${encodeURIComponent(sapClient)}` : "");
    const { status, body } = await this.fetchFromSystem(path);
    if (status < 200 || status >= 300) {
      throw new AdtStatusError(status);
    }
    // First occurrences in document order sit on the root element.
    const version = body.match(/adtcore:version="(active|inactive)"/);
    const changedAt = body.match(/adtcore:changedAt="([^"]+)"/);
    return {
      version: version ? (version[1] as "active" | "inactive") : undefined,
      changedAt: changedAt ? changedAt[1] : undefined,
    };
  }

  /**
   * The headers a forwarded request leaves this proxy with - the ONE place
   * that decides them, for the plain path and the upgrade path alike.
   *
   * Four things happen here, and all four are security-relevant enough that
   * two copies of them is a liability: the system's `Host`, the injected
   * credentials, the proxy's own token cookie (which stops here - matched by
   * prefix, so another window's port-scoped cookie stops here too), and the
   * `Origin`/`Referer` rewrite that makes the request look same-origin to the
   * system again. The browser addresses the proxy, so it sends 127.0.0.1 in
   * both while the forwarded `Host` is the SAP host, and origin-validating
   * CSRF checks reject that mismatch on every POST ("CSRF validation failed -
   * cross-origin POST rejected").
   *
   * `stripHopByHop` is the one deliberate difference between the two callers:
   * those headers describe the browser's connection to the proxy rather than
   * the request and must not travel on - except on an upgrade, which IS the
   * hop its `Connection`/`Upgrade` pair is about.
   */
  private prepareForwardHeaders(
    incoming: http.IncomingHttpHeaders,
    target: URL,
    proxyOrigin: string,
    options: { stripHopByHop: boolean }
  ): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...incoming };
    if (options.stripHopByHop) {
      for (const name of HOP_BY_HOP_HEADERS) {
        delete headers[name];
      }
    }
    headers.host = target.host;
    headers.authorization = this.authHeader;
    if (headers.cookie) {
      const kept = String(headers.cookie)
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith(TOKEN_COOKIE));
      if (kept.length > 0) {
        headers.cookie = kept.join("; ");
      } else {
        delete headers.cookie;
      }
    }
    if (headers.origin) {
      headers.origin = target.origin;
    }
    if (headers.referer) {
      headers.referer = rebasedReferer(String(headers.referer), proxyOrigin, target);
    }
    return headers;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = this.route(req);
    if (path === undefined) {
      res.writeHead(404).end();
      return;
    }
    if (this.authRejected) {
      // Answered here, without touching the system - see `authRejected`. The
      // status is the one the system gave, so the page behaves exactly as it
      // did on the answer that set the flag; the body says why nothing is
      // arriving, since this text is what an iframe ends up showing.
      res
        .writeHead(401, { "content-type": "text/plain; charset=utf-8" })
        .end(
          "abap2UI5: the system rejected the stored user or password. The " +
            "extension stopped repeating the request so the account does not " +
            "get locked. Enter the credentials again to retry."
        );
      this.onTraffic?.({
        method: String(req.method ?? "GET"),
        path,
        status: 401,
        durationMs: 0,
        bytes: 0,
      });
      return;
    }

    // an authorized request that came in prefixed leaves with the cookie, so
    // that an absolute-path resource is authorized too
    const seedCookie = String(req.url ?? "").startsWith(`/${TOKEN_SEGMENT}/`);

    // captured now: a system switch while this request is in flight must not
    // rewrite its response against the NEXT proxy's port and token
    const proxyOrigin = this.origin;
    const cookieName = this.cookieName;
    const token = this.token!;

    // What the traffic log and the status reports are allowed to see. The
    // incoming url carries the token, and those two end up in output channels
    // users paste into issues - which would hand over a working authorized
    // url for as long as the proxy runs. The forwarded path never has it.
    const reportedPath = path;

    const target = this.target!;
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const startedAt = Date.now();

    // One traffic entry per request, whichever way it ends - completed,
    // failed toward the system, or abandoned by the client.
    let trafficLogged = false;
    const logTraffic = (status: number, bytes: number) => {
      if (trafficLogged) {
        return;
      }
      trafficLogged = true;
      this.onTraffic?.({
        method: String(req.method ?? "GET"),
        path: reportedPath,
        status,
        durationMs: Date.now() - startedAt,
        bytes,
      });
    };

    // Host, credentials, token cookie, Origin/Referer - see
    // `prepareForwardHeaders`, which the upgrade path shares.
    const headers = this.prepareForwardHeaders(req.headers, target, proxyOrigin, {
      stripHopByHop: true,
    });

    // A document request may get the runtime hook injected below. Injecting
    // means reading the body, so ask for it uncompressed - for the handful of
    // HTML documents a UI5 app loads that costs nothing measurable.
    const expectsHtml =
      req.method === "GET" &&
      (/text\/html/i.test(String(req.headers.accept ?? "")) ||
        req.headers["sec-fetch-dest"] === "document" ||
        req.headers["sec-fetch-dest"] === "iframe");
    if (expectsHtml) {
      headers["accept-encoding"] = "identity";
    }

    const options: https.RequestOptions = {
      protocol: target.protocol,
      hostname: requestHostname(target),
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path,
      headers,
      // dev systems often have self-signed certificates - verification is
      // opt-in via the abap2ui5.allowUnauthorizedCerts setting
      rejectUnauthorized: !this.allowUnauthorized,
    };

    const proxyReq = mod.request(options, (proxyRes) => {
      // An upstream that dies mid-body emits on the RESPONSE stream, and
      // pipe( ) does not forward that to the destination - an unhandled
      // "error" here used to take the whole extension host down. Attached
      // before any branch below can return.
      proxyRes.on("error", () => {
        proxyRes.destroy();
        res.destroy();
      });

      const status = proxyRes.statusCode ?? 0;
      if (status === 401 || status === 403) {
        // Reported after the body rather than at header time: what makes a
        // rejection diagnosable is the sentence inside it, and these two
        // statuses are the only ones where waiting a few milliseconds buys
        // anything. A 401 also stops the burst of retries (`authRejected`).
        if (status === 401) {
          this.authRejected = true;
        }
        let sniff = "";
        const sniffDecoder = new StringDecoder("utf8");
        proxyRes.on("data", (chunk: Buffer) => {
          const wanted = REJECTION_SNIFF_BYTES - sniff.length;
          if (wanted > 0) {
            // sliced, and through a decoder: a chunk boundary inside a
            // multibyte character must not become a replacement character
            sniff += sniffDecoder.write(chunk.subarray(0, wanted));
          }
        });
        let reported = false;
        const reportRejection = () => {
          if (reported) {
            return;
          }
          reported = true;
          this.onResponse?.({
            status,
            path: reportedPath,
            authenticate: headerValue(proxyRes.headers["www-authenticate"]),
            reason: describeRejection(sniff),
          });
        };
        proxyRes.once("end", reportRejection);
        // an aborted rejection never reaches "end", and a rejection nobody
        // hears about is the state this whole path exists to end
        proxyRes.once("close", reportRejection);
      } else {
        this.onResponse?.({ status, path: reportedPath });
      }
      // The traffic log: measured to the last body byte, so the duration is
      // what the user actually waited for. The extra data listener rides
      // alongside pipe( ) without disturbing it. "close" logs the answers
      // that never reach "end" - a client that gave up mid-body used to
      // leave no line at all, exactly the request one debugs with this log.
      let receivedBytes = 0;
      proxyRes.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });
      proxyRes.on("end", () =>
        logTraffic(proxyRes.statusCode ?? 0, receivedBytes)
      );
      proxyRes.on("close", () =>
        logTraffic(proxyRes.statusCode ?? 0, receivedBytes)
      );
      const outHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };

      // hop-by-hop again, on the way back: the system's connection handling
      // is not the browser's
      delete outHeaders.connection;
      delete outHeaders["keep-alive"];

      // Allow framing: otherwise the server forbids embedding via
      // X-Frame-Options / CSP frame-ancestors -> the iframe would stay blank.
      delete outHeaders["x-frame-options"];
      for (const key of [
        "content-security-policy",
        "content-security-policy-report-only",
      ]) {
        const csp = outHeaders[key];
        if (typeof csp === "string") {
          const cleaned = csp
            .split(";")
            .filter((d) => !/^\s*frame-ancestors/i.test(d))
            .join(";")
            .trim();
          if (cleaned) {
            outHeaders[key] = cleaned;
          } else {
            delete outHeaders[key];
          }
        }
      }

      // Rewrite redirects from the SAP host to the proxy - structurally,
      // never by replacing the origin substring (see `rebasedLocation`).
      if (outHeaders.location) {
        outHeaders.location = rebasedLocation(
          String(outHeaders.location),
          target,
          proxyOrigin
        );
      }

      // Make the system's cookies valid on the proxy's origin - Domain, Path
      // and Secure, see `rewriteSetCookie`.
      const setCookie = proxyRes.headers["set-cookie"];
      const cookies = setCookie ? setCookie.map(rewriteSetCookie) : [];
      if (seedCookie) {
        // SameSite=None, not Lax: the page lives in an iframe whose top-level
        // document is the vscode-webview:// origin, so every request the page
        // makes counts as cross-site and a Lax cookie stays home - exactly the
        // absolute-path requests this cookie exists to authorize. None needs
        // Secure to be accepted, and loopback is a trustworthy origin, so
        // Chromium takes the pair over plain http (same reasoning as the SAP
        // session cookies above).
        cookies.push(
          `${cookieName}=${token}; Path=/; HttpOnly; SameSite=None; Secure`
        );
      }
      if (cookies.length > 0) {
        outHeaders["set-cookie"] = cookies;
      }

      // HTML documents get the runtime hook planted (see above). Anything
      // already compressed (a server ignoring accept-encoding) or without a
      // body is streamed through untouched.
      const contentType = String(proxyRes.headers["content-type"] ?? "");
      const injectable =
        expectsHtml &&
        /text\/html/i.test(contentType) &&
        !proxyRes.headers["content-encoding"] &&
        (proxyRes.statusCode ?? 0) !== 304;
      if (!injectable) {
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        proxyRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      let passedThrough = false;
      const buffer = (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size <= INJECT_MAX_BYTES) {
          return;
        }
        // Too big to be the app page - flush what is buffered and hand the
        // rest to pipe( ), which honours backpressure where a bare write( )
        // in this listener would buffer the remainder in memory.
        passedThrough = true;
        proxyRes.off("data", buffer);
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        for (const buffered of chunks) {
          res.write(buffered);
        }
        chunks.length = 0;
        proxyRes.pipe(res);
      };
      proxyRes.on("data", buffer);
      proxyRes.on("end", () => {
        if (passedThrough) {
          return; // pipe( ) ends the response itself
        }
        const body = injectRuntimeHook(
          allowFraming(decodeBody(Buffer.concat(chunks), contentType))
        );
        const payload = Buffer.from(body, "utf8");
        // the body leaves as UTF-8 whatever it arrived as, so the declared
        // charset has to move with it - an ISO-8859-1 logon page used to be
        // decoded wrongly and then served under its original charset
        outHeaders["content-type"] = withUtf8Charset(contentType);
        delete outHeaders["transfer-encoding"];
        outHeaders["content-length"] = payload.length;
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        res.end(payload);
      });
    });

    // a system that accepts the connection and then says nothing would
    // otherwise hold this request open for as long as the socket lives
    proxyReq.setTimeout(FORWARD_TIMEOUT_MS, () =>
      proxyReq.destroy(new Error(`no answer within ${FORWARD_TIMEOUT_MS} ms`))
    );

    proxyReq.on("error", (err) => {
      if (res.writableEnded || res.destroyed) {
        // the client is already gone - nothing left to tell, but the log
        // still gets its line (status 0: no answer reached anybody)
        logTraffic(0, 0);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      logTraffic(502, 0);
      res.end("abap2UI5 proxy error: " + err.message);
    });

    // The webview cancels in-flight loads on every reload and navigation.
    // Without this the forwarded request runs to completion (or the two-minute
    // timeout) against a client that stopped listening, holding a work process
    // on the system and - on the injecting path - buffering into nothing.
    res.on("close", () => {
      if (!res.writableEnded) {
        proxyReq.destroy();
      }
    });
    // a body that stops arriving mid-upload otherwise lands as an unhandled
    // "error" on the request stream
    req.on("error", () => proxyReq.destroy());
    res.on("error", () => proxyReq.destroy());

    req.pipe(proxyReq);
  }

  /**
   * A WebSocket upgrade, forwarded through the same gate and with the same
   * injected credentials as every other request. Node destroys the socket of
   * any `Upgrade:` request nobody listens for, so an app opening a WebSocket
   * used to die silently in the preview.
   */
  private handleUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void {
    const path = this.route(req);
    if (path === undefined || this.authRejected) {
      socket.destroy();
      return;
    }

    const target = this.target!;
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;

    // The upgrade needs its `Connection`/`Upgrade` pair to travel, so no
    // hop-by-hop stripping here - this IS the hop the pair is about.
    // Everything else is decided exactly as on the plain path.
    const headers = this.prepareForwardHeaders(req.headers, target, this.origin, {
      stripHopByHop: false,
    });

    // Tracked from here on, not from the 101: an upgraded socket no longer
    // belongs to the http server (see `tunnels`), and neither does one whose
    // upgrade is still pending - `close( )` waits for it all the same, so a
    // stop( ) during a pending upgrade used to hang on it forever.
    this.tunnels.add(socket);
    socket.on("close", () => this.tunnels.delete(socket));

    const proxyReq = mod.request({
      protocol: target.protocol,
      hostname: requestHostname(target),
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path,
      headers,
      rejectUnauthorized: !this.allowUnauthorized,
    });

    // A client that leaves before the system has answered takes the pending
    // request with it. A FIN counts as leaving: the http server hands the
    // socket over half-open-capable, so a client that merely ended its side
    // never produced a "close" - and the teardown below is only registered
    // once the 101 is in, so both sockets of an upgrade that never completed
    // used to stay open until stop( ).
    const abandon = () => {
      proxyReq.destroy();
      socket.destroy();
    };
    socket.on("close", abandon);
    socket.on("end", abandon);
    socket.on("error", abandon);
    // Read while the answer is pending - a socket nobody reads is paused, and
    // a paused socket surfaces neither the FIN nor the reset. Whatever the
    // client sends before the 101 (a WebSocket client sends nothing, but the
    // protocol is not ours to assume) is kept for the tunnel.
    const early: Buffer[] = [];
    const keepEarly = (chunk: Buffer) => {
      early.push(chunk);
    };
    socket.on("data", keepEarly);

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.off("close", abandon);
      socket.off("end", abandon);
      socket.off("error", abandon);
      socket.off("data", keepEarly);
      if (socket.destroyed || socket.readableEnded) {
        // the client hung up while the system was still deciding: there is
        // nobody to hand the tunnel to, and a tunnel with one end is a leak
        proxySocket.destroy();
        return;
      }
      this.tunnels.add(proxySocket);
      const teardown = () => {
        this.tunnels.delete(socket);
        this.tunnels.delete(proxySocket);
        socket.destroy();
        proxySocket.destroy();
      };
      socket.on("close", teardown);
      proxySocket.on("close", teardown);
      proxySocket.on("error", () => socket.destroy());
      socket.on("error", () => proxySocket.destroy());
      const lines = [
        `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ""}`.trimEnd(),
      ];
      for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
        const name = proxyRes.rawHeaders[i];
        const value = proxyRes.rawHeaders[i + 1];
        // the handshake may plant a session cookie exactly as a page does,
        // and it needs the same rebasing onto the proxy's origin - or it is
        // set once and never sent back
        lines.push(
          `${name}: ${name.toLowerCase() === "set-cookie" ? rewriteSetCookie(value) : value}`
        );
      }
      socket.write(lines.join("\r\n") + "\r\n\r\n");
      if (proxyHead.length) {
        socket.write(proxyHead);
      }
      if (head.length) {
        proxySocket.write(head);
      }
      for (const chunk of early) {
        proxySocket.write(chunk);
      }
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on("response", (proxyRes) => {
      // The system refused the upgrade - relay the refusal and hang up. A 401
      // here is the same rejected logon as on the plain path and is treated
      // the same way: an app that reopens its WebSocket on every failure used
      // to send one failed logon per attempt - the burst `authRejected` exists
      // to stop - while nothing ever offered the user to re-enter the
      // credentials, because nobody reported the answer.
      const status = proxyRes.statusCode ?? 502;
      if (status === 401) {
        this.authRejected = true;
      }
      this.onResponse?.({
        status,
        path,
        authenticate: headerValue(proxyRes.headers["www-authenticate"]),
      });
      // Ended AND destroyed once the refusal is out: nothing reads this socket
      // any more, and a WebSocket client has its first frame ready to send -
      // unread bytes keep a half-open socket from ever closing, and
      // `server.close( )` waiting on it.
      socket.end(
        `HTTP/1.1 ${status} ${proxyRes.statusMessage ?? ""}\r\n` +
          "connection: close\r\n\r\n",
        () => socket.destroy()
      );
      proxyRes.destroy();
    });
    proxyReq.on("error", () => socket.destroy());
    proxyReq.end();
  }

  stop(): Promise<void> {
    return this.serialize(() => this.stopNow());
  }

  private async stopNow(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.target = undefined;
    // the credentials and the token outlived the server they belonged to,
    // and isRunning read true for a proxy that had already been stopped
    this.authHeader = undefined;
    this.token = undefined;
    this.singleUseTokens.clear();
    for (const tunnel of this.tunnels) {
      tunnel.destroy();
    }
    this.tunnels.clear();
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close( ) alone waits for in-flight requests - up to the forward
        // timeout - and a system SWITCH awaits this before it can start, so
        // the connections go down with the server they belonged to
        server.closeAllConnections();
      });
    }
  }

  dispose(): void {
    void this.stop();
  }
}
