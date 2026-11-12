/**
 * What the auth proxy does to an HTML document on its way to the preview:
 * the frame-options rewrite and the runtime hook it plants. Pure string
 * work - `SapProxy` decides which responses get it. `proxy.ts` re-exports
 * the public part and is the module to import from.
 */

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
export const INJECT_MAX_BYTES = 5 * 1024 * 1024;
