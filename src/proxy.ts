import * as http from "http";
import * as https from "https";
import { randomBytes } from "crypto";
import { URL } from "url";
import { redact } from "./report";

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

/** Tags out, entities and runs of whitespace collapsed. */
function flatten(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
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

/**
 * Class names out of an ADT quick-search answer. The tag's attribute order
 * is not fixed, so the tag is matched first and its attributes second; only
 * classes count (`CLAS/OC`) - the search itself is not told, because not
 * every ADT version accepts the filter parameter.
 */
export function parseAdtClassNames(xml: string): string[] {
  const names: string[] = [];
  for (const tag of xml.matchAll(/<adtcore:objectReference\b[^>]*>/g)) {
    const type = /adtcore:type="([^"]*)"/.exec(tag[0])?.[1];
    const name = /adtcore:name="([^"]*)"/.exec(tag[0])?.[1];
    if (type === "CLAS/OC" && name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** First segment of every url the proxy hands out, so the token that follows
 *  cannot be mistaken for a path on the system. */
const TOKEN_SEGMENT = "__abap2ui5";

/** Carries the token on requests whose path the proxy never sees prefixed -
 *  an app configured with an absolute bootstrap (`/sap/public/...`) asks for
 *  it from the server root. Planted on the first answer, HttpOnly so the page
 *  itself cannot read it back out. */
const TOKEN_COOKIE = "__abap2ui5_proxy";

/** The loopback names a browser can have connected through. Anything else in
 *  the Host header means the request arrived under a different hostname than
 *  the one the proxy hands out - the shape of a DNS rebinding attempt. */
const LOOPBACK_HOST = /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i;

/** How long a forwarded request may take before the proxy gives up. Without
 *  it a system that accepts the connection and then goes quiet holds the
 *  request - and the preview - open with nothing to show for it. */
const FORWARD_TIMEOUT_MS = 120_000;

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
    this.server = http.createServer((req, res) => this.handle(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });

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

  /**
   * The system path an incoming request is asking for, or undefined when the
   * request has no business here. Two ways to be authorized, and a request
   * that is neither is answered 404 rather than told what it got wrong.
   */
  private route(req: http.IncomingMessage): string | undefined {
    // A browser sends the host it connected to. Ours is always loopback, so
    // anything else is a name that resolves here without being ours - which
    // is what DNS rebinding looks like from this side.
    if (!LOOPBACK_HOST.test(String(req.headers.host ?? ""))) {
      return undefined;
    }

    const url = String(req.url ?? "/");
    const prefix = `/${TOKEN_SEGMENT}/${this.token}`;
    if (url === prefix) {
      return "/";
    }
    if (url.startsWith(`${prefix}/`)) {
      return url.slice(prefix.length);
    }
    // a launch url without a path (`https://host:44300?app_start=...`) leaves
    // the query directly behind the prefix - forwarding it as written would
    // put `GET ?app_start=... HTTP/1.1` on the wire, which servers reject
    if (url.startsWith(`${prefix}?`)) {
      return "/" + url.slice(prefix.length);
    }

    // no prefix: only the cookie from an earlier authorized answer counts
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${TOKEN_COOKIE}=`));
    return cookie?.slice(TOKEN_COOKIE.length + 1) === this.token
      ? url
      : undefined;
  }

  /**
   * One GET against the system with the credentials the proxy already holds -
   * what the ADT lookups and the UI5-version detection are built on. The
   * body is capped: everything asked for this way is a small text answer.
   */
  fetchFromSystem(
    path: string,
    accept = "application/xml, application/json, */*"
  ): Promise<{ status: number; body: string }> {
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
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          method: "GET",
          path,
          headers: {
            authorization: auth,
            accept,
          },
          rejectUnauthorized: !this.allowUnauthorized,
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (body.length < 256 * 1024) {
              body += chunk;
            }
          });
          res.on("end", () => {
            // A rejection here used to be silent: these requests happen on a
            // timer rather than on a keystroke, so nothing in the UI said the
            // logon had stopped working.
            if (status === 401 || status === 403) {
              if (status === 401) {
                this.authRejected = true;
              }
              this.onResponse?.({
                status,
                path,
                authenticate: headerValue(res.headers["www-authenticate"]),
                reason: describeRejection(body),
              });
            }
            resolve({ status, body });
          });
          // a connection that dies mid-body emits on the RESPONSE stream, and
          // an unhandled "error" there takes the extension host down with it
          res.on("error", reject);
        }
      );
      req.setTimeout(8000, () =>
        req.destroy(new Error("request to the system timed out"))
      );
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

    // What the traffic log and the status reports are allowed to see. The
    // incoming url carries the token, and those two end up in output channels
    // users paste into issues - which would hand over a working authorized
    // url for as long as the proxy runs. The forwarded path never has it.
    const reportedPath = path;

    const target = this.target!;
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const startedAt = Date.now();

    // Take over the incoming headers, overwrite host + auth
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = target.host;
    headers.authorization = this.authHeader;
    // the token is the proxy's own business and stops here
    if (headers.cookie) {
      const kept = String(headers.cookie)
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith(`${TOKEN_COOKIE}=`));
      if (kept.length > 0) {
        headers.cookie = kept.join("; ");
      } else {
        delete headers.cookie;
      }
    }

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

    // The browser addresses the proxy, so it sends 127.0.0.1 as Origin and
    // Referer while the forwarded Host is the SAP host. Origin-validating
    // CSRF checks reject that mismatch on every POST ("CSRF validation
    // failed - cross-origin POST rejected") - make the request look
    // same-origin to the system again.
    if (headers.origin) {
      headers.origin = target.origin;
    }
    if (headers.referer) {
      headers.referer = String(headers.referer).replace(
        this.origin,
        target.origin
      );
    }

    const options: https.RequestOptions = {
      protocol: target.protocol,
      hostname: target.hostname,
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
        proxyRes.on("data", (chunk: Buffer) => {
          if (sniff.length < REJECTION_SNIFF_BYTES) {
            sniff += chunk.toString("utf8");
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
      // alongside pipe( ) without disturbing it.
      let receivedBytes = 0;
      proxyRes.on("data", (chunk: Buffer) => {
        receivedBytes += chunk.length;
      });
      proxyRes.on("end", () => {
        this.onTraffic?.({
          method: String(req.method ?? "GET"),
          path: reportedPath,
          status: proxyRes.statusCode ?? 0,
          durationMs: Date.now() - startedAt,
          bytes: receivedBytes,
        });
      });
      const outHeaders: http.OutgoingHttpHeaders = { ...proxyRes.headers };

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

      // Rewrite redirects from the SAP host to the proxy
      if (outHeaders.location) {
        outHeaders.location = String(outHeaders.location).replace(
          target.origin,
          this.origin
        );
      }

      // Make cookies valid on localhost: strip Domain, and Secure unless the
      // cookie needs it. A `SameSite=None` cookie without `Secure` is dropped
      // outright by the webview's Chromium, so stripping it there loses the
      // session cookie of every system configured per SAP's cross-site notes
      // - and loopback counts as a trustworthy origin, so Secure is accepted
      // over http anyway.
      const setCookie = proxyRes.headers["set-cookie"];
      const cookies = setCookie
        ? setCookie.map((c) => {
            const withoutDomain = c.replace(/;\s*Domain=[^;]+/i, "");
            return /;\s*SameSite\s*=\s*None\b/i.test(withoutDomain)
              ? withoutDomain
              : withoutDomain.replace(/;\s*Secure/i, "");
          })
        : [];
      if (seedCookie) {
        cookies.push(
          `${TOKEN_COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Lax`
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
          decodeBody(Buffer.concat(chunks), contentType)
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
        return; // the client is already gone - nothing left to tell
      }
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  dispose(): void {
    void this.stop();
  }
}
