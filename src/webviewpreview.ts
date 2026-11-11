/**
 * HTML for the running app's webview (`previewHtml`): toolbar, device sizes,
 * loading overlay and the page script that talks to the host. Imported
 * through `webview.ts`.
 */

import { shortUrl } from "./urls";
import { redactQueryCredentials } from "./report";
import {
  BASE_CSS,
  DEVICE_WIDTHS,
  LANGUAGES,
  THEMES,
  escapeHtml,
  icon,
  optionList,
  scriptJson,
} from "./webviewshared";

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface PreviewOptions {
  /** URL loaded in the iframe (the local auth proxy in tab/panel mode). */
  frameUrl: string;
  /** Real SAP URL — shown in the toolbar and opened by "Open externally". */
  externalUrl: string;
  /** Class name of the app, shown as the title. */
  className: string;
  /** `sap-ui-theme` currently in force, "" for the system default. */
  theme: string;
  /** `sap-language` currently in force, "" for the logon language. */
  language: string;
  /** Top-level model paths of the class - what a stateful reload restores. */
  modelRoots: string[];
  /** The theme picker's entries - `THEMES` plus whatever the host merged in
   *  (the `abap2ui5.previewThemes` setting). Defaults to `THEMES`. */
  themes?: ReadonlyArray<[value: string, label: string]>;
  /** The language picker's entries - `LANGUAGES` plus whatever the host
   *  merged in (the `abap2ui5.previewLanguages` setting). */
  languages?: ReadonlyArray<[value: string, label: string]>;
  /** Device width the last preview showed - the webview's own saved state
   *  wins while it lives, this seeds a freshly created one. */
  device?: string;
  /** Why this preview appears ("Moved into the panel") - shown as the toast a
   *  load message would carry; the first render has no load message. */
  reason?: string;
  nonce: string;
}

export function previewHtml(options: PreviewOptions): string {
  const { nonce } = options;
  // the tooltip is display, and a launch template may carry sap-user/sap-password
  const externalUrl = escapeHtml(redactQueryCredentials(options.externalUrl));
  const className = escapeHtml(options.className);
  const urlLabel = escapeHtml(shortUrl(options.externalUrl));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http: https:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>abap2UI5 Preview</title>
<style nonce="${nonce}">
${BASE_CSS}
  body { display: flex; flex-direction: column; overflow: hidden; }

  /* ---- toolbar ---- */
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    padding: 5px 8px;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--vscode-charts-green, #3fb950);
    flex: none;
    transition: background 120ms ease;
  }
  body[data-state="loading"] .dot {
    background: var(--vscode-charts-yellow, #d29922);
    animation: pulse 1.1s ease-in-out infinite;
  }
  body[data-state="slow"] .dot { background: var(--vscode-charts-orange, #db6d28); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

  .name {
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  /* Shown between class name and URL once the source was saved but not activated. */
  .badge {
    display: none;
    flex: none;
    align-items: center;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 0.82em;
    white-space: nowrap;
    color: var(--vscode-editorWarning-foreground, #d29922);
    border: 1px solid currentColor;
    opacity: 0.85;
    cursor: pointer;
  }
  .badge:hover { opacity: 1; }
  body[data-stale="true"] .badge { display: inline-flex; }
  /* Runtime errors the app reported since the last (re)load. */
  .errors {
    display: none;
    flex: none;
    align-items: center;
    gap: 4px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 0.82em;
    white-space: nowrap;
    color: var(--vscode-editorError-foreground, #f85149);
    border: 1px solid currentColor;
    opacity: 0.85;
    cursor: pointer;
  }
  .errors:hover { opacity: 1; }
  .errors.show { display: inline-flex; }
  /* Duration of the last backend roundtrip (POST), from the traffic log. */
  .rt {
    display: none;
    flex: none;
    align-items: center;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 0.82em;
    white-space: nowrap;
    opacity: 0.7;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
    cursor: pointer;
  }
  .rt:hover { opacity: 1; }
  .rt.show { display: inline-flex; }
  .rt.slow { color: var(--vscode-editorWarning-foreground, #d29922); border-color: currentColor; }
  .url {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.65;
    font-size: 0.92em;
  }

  .seg {
    display: flex;
    gap: 2px;
    flex: none;
  }
  .seg button { padding: 3px 7px; border-radius: 5px; opacity: 0.7; }
  .seg button:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.14));
  }
  .seg button[aria-pressed="true"] {
    opacity: 1;
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    background: var(--vscode-inputOption-activeBackground, rgba(0,120,212,0.25));
    border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  }

  select {
    font: inherit;
    font-size: 0.9em;
    flex: none;
    max-width: 130px;
    padding: 2px 4px;
    border-radius: 5px;
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    background: var(--vscode-dropdown-background, transparent);
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border, transparent));
  }
  select:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }

  .act { padding: 4px 7px; opacity: 0.8; flex: none; }
  .act:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.14)); }
  .act[aria-pressed="true"] {
    opacity: 1;
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    background: var(--vscode-inputOption-activeBackground, rgba(0,120,212,0.25));
    border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
  }
  .act.spin .ico { animation: spin 600ms ease; }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* ---- stage ---- */
  .stage {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    justify-content: center;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .viewport {
    position: relative;
    width: 100%;
    height: 100%;
    transition: width 160ms ease;
  }
  .stage[data-device="tablet"] .viewport { width: ${DEVICE_WIDTHS.tablet}px; max-width: 100%; }
  .stage[data-device="phone"] .viewport { width: ${DEVICE_WIDTHS.phone}px; max-width: 100%; }
  .stage[data-device="tablet"] .viewport,
  .stage[data-device="phone"] .viewport {
    border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
  }
  iframe { border: 0; width: 100%; height: 100%; background: #fff; display: block; }

  /* ---- loading overlay ---- */
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    background: var(--vscode-editor-background);
    transition: opacity 220ms ease;
  }
  body[data-state="ready"] .overlay { opacity: 0; pointer-events: none; }
  .spinner {
    width: 26px; height: 26px;
    border-radius: 50%;
    border: 2px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
    animation: rotate 800ms linear infinite;
  }
  @keyframes rotate { to { transform: rotate(360deg); } }
  .overlay p { margin: 0; opacity: 0.75; }
  .hint {
    display: none;
    align-items: center;
    gap: 10px;
    font-size: 0.92em;
    opacity: 0.75;
  }
  body[data-state="slow"] .hint { display: flex; }
  .hint button {
    padding: 3px 10px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
  }

  /* ---- toast ---- */
  .toast {
    position: absolute;
    right: 14px;
    bottom: 14px;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 0.9em;
    color: var(--vscode-notifications-foreground, var(--vscode-foreground));
    background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-notificationCenter-border, var(--vscode-panel-border, transparent));
    box-shadow: 0 2px 10px rgba(0,0,0,0.25);
    opacity: 0;
    transform: translateY(6px);
    transition: opacity 180ms ease, transform 180ms ease;
    pointer-events: none;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
</style>
</head>
<body data-state="loading" data-stale="false">
  <div class="bar">
    <span class="dot" id="dot"></span>
    <span class="name" id="name">${className}</span>
    <button class="badge" id="stale" title="The source was saved but not activated - the preview still shows the active version. Click to reload it anyway.">not activated</button>
    <button class="badge" id="act" title="Activate the class through your ABAP tooling and reload - the command 'Activate and Reload Preview', Ctrl+F3 in an ADT document">activate</button>
    <button class="errors" id="errors" title="Runtime errors the app reported since the last load. Click to jump to the likely source line and open the abap2UI5 output log."></button>
    <button class="rt" id="rt" title="Last backend roundtrip (POST through the auth proxy). Click to open the traffic log."></button>
    <span class="url" id="url" title="${externalUrl}">${urlLabel}</span>
    <div class="seg" role="group" aria-label="Preview size">
      <button id="d-desktop" data-device="desktop" aria-pressed="true" title="Desktop width">${icon("desktop")}</button>
      <button id="d-tablet" data-device="tablet" aria-pressed="false" title="Tablet width (${DEVICE_WIDTHS.tablet}px)">${icon("tablet")}</button>
      <button id="d-phone" data-device="phone" aria-pressed="false" title="Phone width (${DEVICE_WIDTHS.phone}px)">${icon("phone")}</button>
    </div>
    <select id="theme" title="UI5 theme (sap-ui-theme)" aria-label="UI5 theme">${optionList(
      options.themes ?? THEMES,
      options.theme
    )}</select>
    <select id="language" title="Logon language (sap-language)" aria-label="Logon language">${optionList(
      options.languages ?? LANGUAGES,
      options.language
    )}</select>
    <button class="act" id="inspect" aria-pressed="false" title="Inspect: click a control in the app to jump to its builder call (Esc cancels)">${icon("inspect")}</button>
    <button class="act" id="model" title="Show the app's JSON model">${icon("model")}</button>
    <button class="act" id="pin" aria-pressed="false" title="Keep the app's model across reloads: capture it before the reload, restore it after (best effort)">${icon("pin")}</button>
    <button class="act" id="shot" title="Take a screenshot of the running app (headless Chromium)">${icon("camera")}</button>
    <button class="act" id="reload" title="Reload the app">${icon("refresh")}</button>
    <button class="act" id="ext" title="Open in the default browser">${icon("external")}</button>
  </div>

  <div class="stage" id="stage" data-device="desktop">
    <div class="viewport">
      <!-- src is set from the script below, so the load listener is never missed -->
      <iframe id="app" title="abap2UI5 app"
              sandbox="allow-forms allow-scripts allow-same-origin allow-popups allow-modals allow-downloads"></iframe>
    </div>
    <div class="overlay" id="overlay">
      <div class="spinner"></div>
      <p id="loading-text">Starting ${className}&hellip;</p>
      <div class="hint">
        <span>Taking longer than usual.</span>
        <button id="hint-reload">Reload</button>
        <button id="hint-check">Check connection</button>
        <button id="hint-ext">Open externally</button>
      </div>
    </div>
    <div class="toast" id="toast"></div>
  </div>

<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  const body = document.body;
  const frame = document.getElementById('app');
  const stage = document.getElementById('stage');
  const nameEl = document.getElementById('name');
  const urlEl = document.getElementById('url');
  const loadingText = document.getElementById('loading-text');
  const toast = document.getElementById('toast');
  const reloadBtn = document.getElementById('reload');

  let frameUrl = ${scriptJson(options.frameUrl)};
  let slowTimer;
  let toastTimer;

  // Runtime errors forwarded by the hook the proxy plants into the app.
  const errorsEl = document.getElementById('errors');
  let errorCount = 0;
  function setErrorCount(count) {
    errorCount = count;
    errorsEl.textContent = count === 1 ? '1 error' : count + ' errors';
    errorsEl.classList.toggle('show', count > 0);
  }
  errorsEl.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'showRuntimeLog' });
  });

  // The roundtrip badge: the host relays every successful POST's duration.
  const rtEl = document.getElementById('rt');
  rtEl.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'showTraffic' });
  });

  // Inspect mode and the model dump talk to the hook inside the app iframe.
  const inspectBtn = document.getElementById('inspect');
  const modelBtn = document.getElementById('model');
  let inspectOn = false;
  // Commands - and above all the restored model data - go only to the page
  // the preview itself loaded. The app may navigate the frame anywhere, and
  // a '*' target would hand whatever page sits there the captured model.
  function frameOrigin() {
    try { return new URL(frameUrl).origin; } catch (e) { return null; }
  }
  function postToApp(message) {
    const origin = frameOrigin();
    if (!origin) { return; }
    try { frame.contentWindow.postMessage(message, origin); } catch (e) { /* not loaded yet */ }
  }
  function markInspect(on) {
    inspectOn = on;
    inspectBtn.setAttribute('aria-pressed', String(on));
  }
  inspectBtn.addEventListener('click', () => {
    markInspect(!inspectOn);
    postToApp({ __abap2ui5Cmd: 'inspect', on: inspectOn });
  });
  // True between a host's 'dumpModel' and the app's answer to it.
  let modelForHost = false;
  modelBtn.addEventListener('click', () => {
    modelForHost = false;
    postToApp({ __abap2ui5Cmd: 'model' });
  });
  document.getElementById('shot').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'screenshot', device: stage.dataset.device });
  });

  // Stateful reload: while the pin is on, the model is captured right before
  // a reload and restored into the fresh page - so a popup-deep state does
  // not fall back to square one on every activation.
  const pinBtn = document.getElementById('pin');
  let pinOn = false;
  let modelRoots = ${scriptJson(options.modelRoots)};
  const initialReason = ${scriptJson(options.reason ?? null)};
  let pendingRestore = null;  // captured model JSON, waiting for the fresh page
  let awaitingCapture = null; // {url, message} while the capture is in flight
  function markPin(on) {
    pinOn = on;
    pinBtn.setAttribute('aria-pressed', String(on));
  }
  pinBtn.addEventListener('click', () => {
    markPin(!pinOn);
    persistState();
  });
  function filteredRestore(text) {
    // Only the class's own model roots travel across the reload - the
    // framework's internal state belongs to the fresh page.
    try {
      const all = JSON.parse(text);
      if (!modelRoots || !modelRoots.length) { return null; }
      const out = {};
      let any = false;
      for (const root of modelRoots) {
        if (all && typeof all === 'object' && root in all) {
          out[root] = all[root];
          any = true;
        }
      }
      return any ? out : null;
    } catch (e) { return null; }
  }

  // Device width and the pin survive a webview being hidden and restored.
  // The webview's own state dies with the webview, so a freshly created one
  // is seeded with the device the host remembered for this window.
  const saved = vscodeApi.getState() || {};
  setDevice(saved.device || ${scriptJson(options.device || "desktop")}, false);
  markPin(!!saved.pin);
  function persistState() {
    vscodeApi.setState({ device: stage.dataset.device, pin: pinOn });
  }

  function setDevice(device, persist) {
    stage.dataset.device = device;
    for (const btn of document.querySelectorAll('.seg button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.device === device));
    }
    if (persist !== false) {
      persistState();
      vscodeApi.postMessage({ type: 'device', value: device });
    }
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }
  if (initialReason) { showToast(initialReason); }

  function beginLoad(message) {
    body.dataset.state = 'loading';
    loadingText.textContent = message;
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (body.dataset.state === 'loading') { body.dataset.state = 'slow'; }
    }, 12000);
  }

  function doLoad(url, message) {
    // a capture still pending belongs to the load this one replaces - its
    // timeout or late reply would otherwise load the PREVIOUS app's url
    awaitingCapture = null;
    beginLoad(message);
    body.dataset.stale = 'false'; // whatever is loading now is the current active version
    setErrorCount(0); // errors of the previous load are history now
    rtEl.classList.remove('show'); // timings of the previous page are history
    frame.src = url; // reassigning src is what forces the reload
  }

  function load(url, message) {
    // With the pin on, ask the running page for its model first; the reload
    // proceeds when the answer (or a short timeout) arrives.
    if (!pinOn || body.dataset.state !== 'ready') {
      pendingRestore = null;
      doLoad(url, message);
      return;
    }
    awaitingCapture = { url: url, message: message };
    postToApp({ __abap2ui5Cmd: 'model-restore' });
    setTimeout(() => {
      if (awaitingCapture) {
        const go = awaitingCapture;
        awaitingCapture = null;
        pendingRestore = null;
        doLoad(go.url, go.message);
      }
    }, 400);
  }

  frame.addEventListener('load', () => {
    clearTimeout(slowTimer);
    body.dataset.state = 'ready';
    markInspect(false); // the fresh page has a fresh hook, mode off
    if (pinOn && pendingRestore) {
      const data = filteredRestore(pendingRestore);
      pendingRestore = null;
      if (data) { postToApp({ __abap2ui5Cmd: 'restore', data: data }); }
    }
  });

  /*
   * Every reload goes through the HOST, which owns what a reload entails
   * (the activation watch, the located runtime error, the focus bounce) and
   * cannot own it for a reload it never hears about. It answers with the
   * usual 'load' message, so the pin, the badges and the loading line below
   * behave exactly as on a reload the host started itself.
   */
  function askHostToReload() {
    vscodeApi.postMessage({ type: 'reload' });
  }

  reloadBtn.addEventListener('click', () => {
    reloadBtn.classList.remove('spin');
    void reloadBtn.offsetWidth; // restart the animation
    reloadBtn.classList.add('spin');
    askHostToReload();
  });

  document.getElementById('stale').addEventListener('click', askHostToReload);

  // Activating is what actually updates the server - the reload alone would
  // show the old version again.
  document.getElementById('act').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'command', command: 'abap2ui5.activate' });
  });

  document.getElementById('ext').addEventListener('click', openExternal);
  document.getElementById('hint-ext').addEventListener('click', openExternal);
  document.getElementById('hint-reload').addEventListener('click', askHostToReload);
  // An app frame that never loads is exactly what the connection check
  // diagnoses - offer it right where the wall is hit.
  document.getElementById('hint-check').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'command', command: 'abap2ui5.checkConnection' });
  });
  function openExternal() { vscodeApi.postMessage({ type: 'openExternal' }); }

  for (const btn of document.querySelectorAll('.seg button')) {
    btn.addEventListener('click', () => setDevice(btn.dataset.device, true));
  }

  // Theme and language are URL parameters of the app, so the host owns them:
  // it rewrites both URLs and sends the reload back as a normal 'load'.
  const themeEl = document.getElementById('theme');
  const languageEl = document.getElementById('language');
  themeEl.addEventListener('change', () => {
    vscodeApi.postMessage({ type: 'param', name: 'theme', value: themeEl.value });
  });
  languageEl.addEventListener('change', () => {
    vscodeApi.postMessage({ type: 'param', name: 'language', value: languageEl.value });
  });
  // Rebuilds a picker from [value, label] pairs; the current value keeps an
  // entry even when the new list does not know it (as the first render does).
  function fillSelect(el, entries, current) {
    if (!Array.isArray(entries)) { return; }
    const value = typeof current === 'string' ? current : el.value;
    el.textContent = '';
    let known = false;
    for (const entry of entries) {
      if (!Array.isArray(entry)) { continue; }
      const opt = document.createElement('option');
      opt.value = String(entry[0]);
      opt.textContent = String(entry[1]);
      known = known || opt.value === value;
      el.appendChild(opt);
    }
    if (!known && value) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      el.appendChild(opt);
    }
    el.value = value;
  }

  // Start the app only now: the load listener above is already attached.
  load(frameUrl, 'Starting ' + nameEl.textContent + '\\u2026');

  // The host sends 'load' on F9, on activation and on the reload command, and
  // 'stale' when the shown class was saved without being activated. The app
  // iframe posts runtime errors, marked so nothing else is ever mistaken for
  // one - they are counted here and relayed to the host for the output log.
  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    /*
     * WHO is talking matters here, not only what they say.
     *
     * Two very different senders reach this one listener: the extension host
     * (load / stale / roundtrip - the trusted chrome) and the app running in
     * the iframe (its runtime hook, and UI5's frame protection). The iframe is
     * not confined to the SAP system - the previewed app may link or navigate
     * anywhere - and any page in there may postMessage to its parent. It could
     * therefore send a 'load' of its own and rewrite the class name, the
     * system url shown under it and the reload target: a trusted-looking
     * frame drawn around a page nobody vouched for.
     *
     * event.source is the one thing a sender cannot forge. So the frame's
     * messages are exactly those from its own contentWindow, and anything the
     * HOST is allowed to say is refused from anywhere else.
     */
    const fromApp = event.source === frame.contentWindow;

    /*
     * UI5's own frame protection, answered for the sake of the protocol.
     *
     * It is NOT what makes the preview clickable - the proxy is, by serving
     * the bootstrap with "sap-ui-frameOptions=allow" (see "allowFraming").
     * This reply cannot do it: "_applyState(false, true)" only lifts the block
     * once "bRunnable" is already true, and in "trusted" mode behind a
     * "vscode-webview://" parent it never becomes true. 0.24.1 sent exactly
     * this message, on the wire exactly as UI5 reads it, and the app stayed
     * unclickable - the mode had to go instead.
     *
     * What stays true is the wire format, which is two plain strings, never
     * JSON - UI5 drops anything else before looking at it:
     *
     *   if (oSource === FrameOptions.__self || oSource == null ||
     *       typeof sData !== "string" ||
     *       sData.indexOf("SAPFrameProtection*") === -1) { return; }
     *
     * So the answer costs nothing and is the right one for a parent that
     * embeds a url it built itself: a page that IS runnable (same-origin, or
     * allowlisted by its own system) is unlocked by it.
     */
    if (typeof event.data === 'string') {
      if (fromApp && event.data === 'SAPFrameProtection*require-origin') {
        event.source.postMessage('SAPFrameProtection*parent-unlocked', '*');
      }
      return; // no string message carries anything else this listener wants
    }

    // Everything below the marker is the app talking about itself; a runtime
    // message from anywhere else is not one.
    const kind = fromApp ? msg.__abap2ui5Runtime : undefined;
    if (kind === 'inspect') {
      markInspect(false); // one-shot: the click ends the mode
      vscodeApi.postMessage({ type: 'inspected', chain: msg.chain || [] });
      return;
    }
    if (kind === 'inspect-state') {
      markInspect(!!msg.on);
      return;
    }
    if (kind === 'model') {
      // asked for by the host (a chat tool) rather than by the { } button:
      // marked, so the host answers the asker and opens no document
      const forHost = modelForHost;
      modelForHost = false;
      vscodeApi.postMessage({
        type: 'appModel',
        forHost: forHost,
        text: String(msg.text || ''),
        error: String(msg.error || ''),
      });
      return;
    }
    if (kind === 'model-restore') {
      // The capture the pin asked for right before a reload.
      if (awaitingCapture) {
        const go = awaitingCapture;
        awaitingCapture = null;
        pendingRestore = msg.text || null;
        doLoad(go.url, go.message);
      }
      return;
    }
    if (kind === 'restored') {
      showToast('Model restored');
      return;
    }
    if (kind) {
      setErrorCount(errorCount + 1);
      vscodeApi.postMessage({
        type: 'runtimeError',
        kind: String(kind),
        text: String(msg.text || ''),
      });
      return;
    }
    // From here on it is the host's protocol: the toolbar's own state. The
    // app frame may not write any of it.
    if (fromApp) { return; }
    if (msg.type === 'stale') {
      // Only the first save after a load says it out loud; the badge stays.
      // 'force' is the watch's give-up, worth a toast even on a stale badge.
      if (msg.reason && (msg.force || body.dataset.stale !== 'true')) {
        showToast(msg.reason);
      }
      body.dataset.stale = 'true';
      return;
    }
    if (msg.type === 'roundtrip') {
      rtEl.textContent = msg.ms + ' ms';
      rtEl.classList.add('show');
      rtEl.classList.toggle('slow', msg.ms >= 1000);
      return;
    }
    if (msg.type === 'dumpModel') {
      // The host asks for the running app's model (the chat tool) - the
      // { } button's command, answered to the host instead of a document.
      if (body.dataset.state !== 'ready') {
        vscodeApi.postMessage({ type: 'appModel', forHost: true, text: '', error: 'no app is loaded yet' });
        return;
      }
      modelForHost = true;
      postToApp({ __abap2ui5Cmd: 'model' });
      return;
    }
    if (msg.type === 'applyModel') {
      // An edited model document, pushed into the running page - the
      // pin's restore path, on demand. The host has already reduced it to
      // the class's own roots; it is filtered here once more, so the page
      // only ever receives what a restore may carry, whoever composed it.
      // Either way the host hears the outcome: it used to report "applied"
      // the moment it had posted, whatever happened here.
      if (body.dataset.state !== 'ready') {
        showToast('No app is loaded yet');
        vscodeApi.postMessage({ type: 'modelApplied', ok: false, reason: 'no app is loaded yet' });
        return;
      }
      const data = filteredRestore(JSON.stringify(msg.data || null));
      if (!data) {
        showToast('Nothing of the app\'s model in that document');
        vscodeApi.postMessage({ type: 'modelApplied', ok: false, reason: 'nothing of the app\'s model is in that document' });
        return;
      }
      postToApp({ __abap2ui5Cmd: 'restore', data: data });
      vscodeApi.postMessage({ type: 'modelApplied', ok: true });
      return;
    }
    if (msg.type === 'pickers') {
      // The theme / language settings changed while the app is up: the
      // <select>s were rendered from the lists as they were at load time.
      fillSelect(themeEl, msg.themes, msg.theme);
      fillSelect(languageEl, msg.languages, msg.language);
      return;
    }
    if (msg.type !== 'load') { return; }
    const switched = msg.className && msg.className !== nameEl.textContent;
    frameUrl = msg.frameUrl;
    if (msg.className) { nameEl.textContent = msg.className; }
    urlEl.textContent = msg.shortUrl || msg.externalUrl;
    urlEl.title = msg.externalUrl;
    if (typeof msg.theme === 'string') { themeEl.value = msg.theme; }
    if (typeof msg.language === 'string') { languageEl.value = msg.language; }
    if (Array.isArray(msg.modelRoots)) { modelRoots = msg.modelRoots; }
    // Another app means another model - never carry state across a switch.
    if (switched) { pendingRestore = null; }
    (switched ? doLoad : load)(
      frameUrl,
      (switched ? 'Starting ' : 'Reloading ') + nameEl.textContent + '\\u2026'
    );
    if (msg.reason) { showToast(msg.reason); }
  });
})();
</script>
</body>
</html>`;
}

