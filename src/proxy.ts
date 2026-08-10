import * as http from "http";
import * as https from "https";
import { URL } from "url";

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

export class SapProxy {
  private server?: http.Server;
  private port?: number;
  private target?: URL;
  private authHeader?: string;

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

  /** Called once per finished response, with the full roundtrip timing -
   *  what feeds the traffic log and the toolbar's roundtrip badge. */
  onTraffic?: (entry: TrafficEntry) => void;

  /** Starts the proxy (or just refreshes auth if the target stays the same). */
  async start(targetOrigin: string, user: string, pass: string): Promise<number> {
    const target = new URL(targetOrigin);
    this.authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

    if (this.server && this.target && this.target.origin === target.origin) {
      return this.port!;
    }

    await this.stop();
    this.target = target;
    this.server = http.createServer((req, res) => this.handle(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });

    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this.port;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** True once start() succeeded, i.e. target and credentials are known. */
  get isRunning(): boolean {
    return !!this.server && !!this.target && !!this.authHeader;
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
          res.on("end", () => resolve({ status, body }));
        }
      );
      req.setTimeout(8000, () =>
        req.destroy(new Error("request to the system timed out"))
      );
      req.on("error", reject);
      req.end();
    });
  }

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
    const target = this.target!;
    const isHttps = target.protocol === "https:";
    const mod = isHttps ? https : http;
    const startedAt = Date.now();

    // Take over the incoming headers, overwrite host + auth
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers.host = target.host;
    headers.authorization = this.authHeader;

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
      path: req.url,
      headers,
      // dev systems often have self-signed certificates - verification is
      // opt-in via the abap2ui5.allowUnauthorizedCerts setting
      rejectUnauthorized: !this.allowUnauthorized,
    };

    const proxyReq = mod.request(options, (proxyRes) => {
      this.onResponse?.({
        status: proxyRes.statusCode ?? 0,
        path: String(req.url ?? ""),
      });
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
          path: String(req.url ?? ""),
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

      // Make cookies valid on localhost: strip Domain + Secure
      const setCookie = proxyRes.headers["set-cookie"];
      if (setCookie) {
        outHeaders["set-cookie"] = setCookie.map((c) =>
          c.replace(/;\s*Domain=[^;]+/i, "").replace(/;\s*Secure/i, "")
        );
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
      proxyRes.on("data", (chunk: Buffer) => {
        if (passedThrough) {
          res.write(chunk);
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
        if (size > INJECT_MAX_BYTES) {
          // Too big to be the app page - flush what is buffered and stream on.
          passedThrough = true;
          res.writeHead(proxyRes.statusCode || 502, outHeaders);
          for (const buffered of chunks) {
            res.write(buffered);
          }
          chunks.length = 0;
        }
      });
      proxyRes.on("end", () => {
        if (passedThrough) {
          res.end();
          return;
        }
        const body = injectRuntimeHook(Buffer.concat(chunks).toString("utf8"));
        const payload = Buffer.from(body, "utf8");
        delete outHeaders["transfer-encoding"];
        outHeaders["content-length"] = payload.length;
        res.writeHead(proxyRes.statusCode || 502, outHeaders);
        res.end(payload);
      });
      proxyRes.on("error", () => res.end());
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("abap2UI5 proxy error: " + err.message);
    });

    req.pipe(proxyReq);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.target = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  dispose(): void {
    void this.stop();
  }
}
