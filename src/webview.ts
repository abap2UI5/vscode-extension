/**
 * HTML for the two webviews the extension renders:
 *
 * - `previewHtml` — the running app: toolbar, device sizes, loading overlay.
 * - `welcomeHtml` — the empty state shown before the first F9.
 *
 * Both are plain strings without any build step. They only use VS Code theme
 * variables, so they follow the user's colour theme (light, dark, contrast).
 */

import { randomBytes } from "crypto";

export { shortUrl } from "./urls";
import { shortUrl } from "./urls";

/** Random nonce so the webview CSP can allow exactly our own script/style.
 *  A nonce is a security token, so it comes from the crypto RNG - Math.random
 *  is predictable enough to be worth not relying on here. */
export function createNonce(): string {
  return randomBytes(24).toString("base64url");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/*
 * The UI5 themes a preview can be switched to, and the logon languages the
 * picker offers. Both travel as ordinary URL parameters (`sap-ui-theme`,
 * `sap-language`), which is why this costs nothing but a reload: checking an
 * app in dark mode or in a second language is otherwise a trip to the
 * browser with a hand-edited URL.
 */
export const THEMES: ReadonlyArray<[value: string, label: string]> = [
  ["", "System theme"],
  ["sap_horizon", "Horizon"],
  ["sap_horizon_dark", "Horizon Dark"],
  ["sap_horizon_hcb", "Horizon HC Black"],
  ["sap_horizon_hcw", "Horizon HC White"],
  ["sap_fiori_3", "Quartz (Fiori 3)"],
  ["sap_fiori_3_dark", "Quartz Dark"],
  ["sap_belize", "Belize"],
];

export const LANGUAGES: ReadonlyArray<[value: string, label: string]> = [
  ["", "Logon language"],
  ["EN", "English"],
  ["DE", "German"],
  ["FR", "French"],
  ["ES", "Spanish"],
  ["IT", "Italian"],
  ["PT", "Portuguese"],
  ["NL", "Dutch"],
  ["PL", "Polish"],
  ["RU", "Russian"],
  ["ZH", "Chinese"],
  ["JA", "Japanese"],
];

/** `<option>` list with the current value pre-selected. */
function optionList(
  entries: ReadonlyArray<[string, string]>,
  current: string
): string {
  return entries
    .map(
      ([value, label]) =>
        `<option value="${escapeHtml(value)}"${
          value === current ? " selected" : ""
        }>${escapeHtml(label)}</option>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Icons (inline, so the webview needs no resources of its own)
// ---------------------------------------------------------------------------

const ICON = {
  refresh: `<path d="M8 3a5 5 0 1 0 4.9 6h-1.6A3.4 3.4 0 1 1 8 4.6c.9 0 1.7.3 2.3.9L8.6 7.2H13V2.8l-1.5 1.5A4.9 4.9 0 0 0 8 3z"/>`,
  external: `<path d="M9.5 2H14v4.5h-1.5V4.56L7.78 9.28 6.72 8.22l4.72-4.72H9.5V2z"/><path d="M3 4h4v1.5H4.5v6h6V9H12v4H3V4z"/>`,
  desktop: `<path d="M2 3h12v8H2V3zm1.5 1.5v5h9v-5h-9zM5.5 12.5h5V14h-5v-1.5z"/>`,
  tablet: `<path d="M3 2h10v12H3V2zm1.5 1.5v7.5h7V3.5h-7zM7 12h2v1H7v-1z"/>`,
  phone: `<path d="M4.5 1.5h7v13h-7v-13zM6 3.2v8.4h4V3.2H6zM7 12.6h2v1H7v-1z"/>`,
  code: `<path d="M5.6 3.6 6.7 4.7 3.9 7.5l2.8 2.8-1.1 1.1L1.7 7.5l3.9-3.9zm4.8 0 3.9 3.9-3.9 3.9-1.1-1.1 2.8-2.8-2.8-2.8 1.1-1.1z"/>`,
  book: `<path d="M2 3h4.2c.7 0 1.3.2 1.8.6.5-.4 1.1-.6 1.8-.6H14v9.2h-4.2c-.6 0-1.2.3-1.5.8h-.6c-.3-.5-.9-.8-1.5-.8H2V3zm1.5 1.5v6.2h2.7c.5 0 1 .1 1.4.3V5.7c-.3-.2-.6-.2-.9-.2H3.5zm9 0H9.8c-.3 0-.6 0-.9.2v5.3c.4-.2.9-.3 1.4-.3h2.2V4.5z"/>`,
  link: `<path d="M8.5 2.5 10 4l-1.4 1.4-1-1a1.8 1.8 0 0 0-2.6 2.6l1 1L4.6 9.4l-1.5-1.5a3.3 3.3 0 0 1 4.7-4.7l.7.3zm4 4a3.3 3.3 0 0 1 0 4.7l-1.5 1.5-1.4-1.4 1.4-1.4a1.8 1.8 0 0 0-2.6-2.6L7 8.7 5.6 7.3 7 5.9a3.3 3.3 0 0 1 5.5.6z"/>`,
  panel: `<path d="M2 3h12v10H2V3zm1.5 1.5v3.1h9V4.5h-9zm0 4.6v2.4h9V9.1h-9z"/>`,
  tab: `<path d="M2 4h5.5l1 1.5H14V13H2V4zm1.5 1.5v6h9V7H7.7l-1-1.5H3.5z"/>`,
  inspect: `<path d="M7.25 1h1.5v3.2h-1.5V1zM7.25 11.8h1.5V15h-1.5v-3.2zM1 7.25h3.2v1.5H1v-1.5zM11.8 7.25H15v1.5h-3.2v-1.5zM8 5.2A2.8 2.8 0 1 1 8 10.8 2.8 2.8 0 0 1 8 5.2zm0 1.5a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z"/>`,
  model: `<path d="M5.9 2C5 2 4.3 2.7 4.3 3.6v1.9c0 .5-.4.9-.9.9H3v1.2h.4c.5 0 .9.4.9.9v1.9c0 .9.7 1.6 1.6 1.6h1V10.7h-1v-1.6c0-.6-.3-1.2-.8-1.6.5-.4.8-1 .8-1.6V4.3h1V3H5.9zm4.2 0H9v1.3h1v1.6c0 .6.3 1.2.8 1.6-.5.4-.8 1-.8 1.6v1.6H9V12h1.1c.9 0 1.6-.7 1.6-1.6V8.5c0-.5.4-.9.9-.9h.4V6.4h-.4c-.5 0-.9-.4-.9-.9V3.6c0-.9-.7-1.6-1.6-1.6z"/>`,
  pin: `<path d="M9.5 1.5l5 5-1.4 1.4-.6-.2-2.4 2.4.3 2.3-1.3 1.3-2.6-2.6-3.3 3.3-1.1-1.1 3.3-3.3-2.6-2.6 1.3-1.3 2.3.3 2.4-2.4-.2-.6 1.4-1.4z"/>`,
  camera: `<path d="M6 2.5h4l.9 1.5H14v9H2v-9h3.1L6 2.5zm2 3.3A3.2 3.2 0 1 0 8 12.2 3.2 3.2 0 0 0 8 5.8zm0 1.5a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4z"/>`,
};

function icon(name: keyof typeof ICON): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
}

// ---------------------------------------------------------------------------
// Shared styling
// ---------------------------------------------------------------------------

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .ico { fill: currentColor; flex: none; }
  button {
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid transparent;
    border-radius: 5px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  kbd {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-bottom-width: 2px;
    background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17));
    color: var(--vscode-keybindingLabel-foreground, inherit);
  }
`;

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
  nonce: string;
}

export function previewHtml(options: PreviewOptions): string {
  const { nonce } = options;
  const externalUrl = escapeHtml(options.externalUrl);
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
  .stage[data-device="tablet"] .viewport { width: 834px; max-width: 100%; }
  .stage[data-device="phone"] .viewport { width: 414px; max-width: 100%; }
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
    <button class="errors" id="errors" title="Runtime errors the app reported since the last load. Click to open the abap2UI5 output log."></button>
    <button class="rt" id="rt" title="Last backend roundtrip (POST through the auth proxy). Click to open the traffic log."></button>
    <span class="url" id="url" title="${externalUrl}">${urlLabel}</span>
    <div class="seg" role="group" aria-label="Preview size">
      <button id="d-desktop" data-device="desktop" aria-pressed="true" title="Desktop width">${icon("desktop")}</button>
      <button id="d-tablet" data-device="tablet" aria-pressed="false" title="Tablet width (834px)">${icon("tablet")}</button>
      <button id="d-phone" data-device="phone" aria-pressed="false" title="Phone width (414px)">${icon("phone")}</button>
    </div>
    <select id="theme" title="UI5 theme (sap-ui-theme)" aria-label="UI5 theme">${optionList(
      THEMES,
      options.theme
    )}</select>
    <select id="language" title="Logon language (sap-language)" aria-label="Logon language">${optionList(
      LANGUAGES,
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

  let frameUrl = ${JSON.stringify(options.frameUrl)};
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
  function postToApp(message) {
    try { frame.contentWindow.postMessage(message, '*'); } catch (e) { /* not loaded yet */ }
  }
  function markInspect(on) {
    inspectOn = on;
    inspectBtn.setAttribute('aria-pressed', String(on));
  }
  inspectBtn.addEventListener('click', () => {
    markInspect(!inspectOn);
    postToApp({ __abap2ui5Cmd: 'inspect', on: inspectOn });
  });
  modelBtn.addEventListener('click', () => {
    postToApp({ __abap2ui5Cmd: 'model' });
  });
  document.getElementById('shot').addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'screenshot' });
  });

  // Stateful reload: while the pin is on, the model is captured right before
  // a reload and restored into the fresh page - so a popup-deep state does
  // not fall back to square one on every activation.
  const pinBtn = document.getElementById('pin');
  let pinOn = false;
  let modelRoots = ${JSON.stringify(options.modelRoots)};
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
  const saved = vscodeApi.getState() || {};
  setDevice(saved.device || 'desktop', false);
  markPin(!!saved.pin);
  function persistState() {
    vscodeApi.setState({ device: stage.dataset.device, pin: pinOn });
  }

  function setDevice(device, persist) {
    stage.dataset.device = device;
    for (const btn of document.querySelectorAll('.seg button')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.device === device));
    }
    if (persist !== false) { persistState(); }
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function beginLoad(message) {
    body.dataset.state = 'loading';
    loadingText.textContent = message;
    clearTimeout(slowTimer);
    slowTimer = setTimeout(() => {
      if (body.dataset.state === 'loading') { body.dataset.state = 'slow'; }
    }, 12000);
  }

  function doLoad(url, message) {
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

  reloadBtn.addEventListener('click', () => {
    reloadBtn.classList.remove('spin');
    void reloadBtn.offsetWidth; // restart the animation
    reloadBtn.classList.add('spin');
    load(frameUrl, 'Reloading ' + nameEl.textContent + '\\u2026');
  });

  document.getElementById('stale').addEventListener('click', () => {
    load(frameUrl, 'Reloading ' + nameEl.textContent + '\\u2026');
  });

  document.getElementById('ext').addEventListener('click', openExternal);
  document.getElementById('hint-ext').addEventListener('click', openExternal);
  document.getElementById('hint-reload').addEventListener('click', () => {
    load(frameUrl, 'Reloading ' + nameEl.textContent + '\\u2026');
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

  // Start the app only now: the load listener above is already attached.
  load(frameUrl, 'Starting ' + nameEl.textContent + '\\u2026');

  // The host sends 'load' on F9, on activation and on the reload command, and
  // 'stale' when the shown class was saved without being activated. The app
  // iframe posts runtime errors, marked so nothing else is ever mistaken for
  // one - they are counted here and relayed to the host for the output log.
  window.addEventListener('message', (event) => {
    const msg = event.data || {};

    /*
     * UI5's own frame protection. A system configured with
     * sap-ui-frameOptions=trusted lets the app run in an iframe only after
     * asking the embedding window for permission: sap/ui/security/FrameOptions
     * posts a request up and waits. Nobody answered, so after ten seconds UI5
     * gave up and blocked the frame - the app rendered and then ignored every
     * click, with only a console line to say why:
     *
     *   Reached timeout of 10000ms waiting for a response from parent window
     *
     * This preview IS the trusted parent: the url it embeds is the one the
     * extension built from the configured system. So it answers.
     *
     * The wire format is two plain strings, not JSON - and UI5 drops anything
     * else before looking at it:
     *
     *   if (oSource === FrameOptions.__self || oSource == null ||
     *       typeof sData !== "string" ||
     *       sData.indexOf("SAPFrameProtection*") === -1) { return; }
     *
     * so an object shaped like a protocol message is not a late answer, it is
     * no answer at all. "parent-unlocked" is the reply that unlocks the frame
     * (_applyState(false, true)); "parent-origin" only proves the parent is
     * alive and leaves the app blocked, which is not what this preview means.
     */
    if (typeof event.data === 'string') {
      if (event.data === 'SAPFrameProtection*require-origin' && event.source) {
        event.source.postMessage('SAPFrameProtection*parent-unlocked', '*');
      }
      return; // no string message carries anything else this listener wants
    }

    const kind = msg.__abap2ui5Runtime;
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
      vscodeApi.postMessage({
        type: 'appModel',
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
    if (msg.type === 'stale') {
      // Only the first save after a load says it out loud; the badge stays.
      if (msg.reason && body.dataset.stale !== 'true') { showToast(msg.reason); }
      body.dataset.stale = 'true';
      return;
    }
    if (msg.type === 'roundtrip') {
      rtEl.textContent = msg.ms + ' ms';
      rtEl.classList.add('show');
      rtEl.classList.toggle('slow', msg.ms >= 1000);
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

// ---------------------------------------------------------------------------
// Property editor (the "Control Properties" view)
// ---------------------------------------------------------------------------

/**
 * The skeleton of the property editor view. It renders nothing by itself -
 * the host posts the control under the cursor (`{type:'control', …}`) or the
 * reason there is none (`{type:'none'}`), and every edit goes back as a
 * message; the host owns the source, this form never does.
 */
export function propertyEditorHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Control Properties</title>
<style nonce="${nonce}">
${BASE_CSS}
  body { padding: 8px 10px; overflow-y: auto; }
  .empty { opacity: 0.7; margin: 6px 0; }
  h2 {
    margin: 0 0 2px;
    font-size: 1.05em;
    font-weight: 600;
    cursor: pointer;
  }
  h2:hover { text-decoration: underline; }
  .qname { opacity: 0.6; font-size: 0.86em; margin: 0 0 10px; word-break: break-all; }
  .rows { display: grid; grid-template-columns: minmax(70px, 38%) 1fr auto; gap: 4px 8px; align-items: center; }
  .rows label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.92em;
  }
  .rows label.deprecated { text-decoration: line-through; opacity: 0.7; }
  input, select {
    font: inherit;
    min-width: 0;
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
  }
  input:focus-visible, select:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .expr {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button.remove {
    padding: 2px 6px;
    opacity: 0.6;
  }
  button.remove:hover { opacity: 1; color: var(--vscode-editorError-foreground, #f85149); }
  .add {
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
    display: grid;
    grid-template-columns: minmax(70px, 38%) 1fr auto;
    gap: 4px 8px;
  }
  .add button {
    padding: 2px 10px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  .add button:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
  <div id="root"><p class="empty">Place the cursor on an \`ele( )\` / \`tag( )\` builder call - its control's properties appear here. The Inspect button in the preview lands here too.</p></div>
<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  const root = document.getElementById('root');
  let state = null;
  let queued = null;

  function editing() {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT');
  }

  function esc(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
  }

  function render() {
    if (!state) { return; }
    if (state.type === 'none') {
      root.innerHTML = '<p class="empty">' + esc(state.reason || 'No builder control under the cursor.') + '</p>';
      return;
    }
    let html = '<h2 id="title" title="Go to the builder call">' + esc(state.label) + '</h2>';
    html += '<p class="qname">' + esc(state.control || 'unknown control - is the namespace declared?') + '</p>';
    html += '<div class="rows">';
    for (const row of state.rows) {
      html += '<label class="' + (row.deprecated ? 'deprecated' : '') + '" title="' + esc(row.type || '') + '">' + esc(row.name) + '</label>';
      if (!row.literal) {
        html += '<span class="expr" title="' + esc(row.value) + '">' + esc(row.value) + '</span>';
      } else if (row.values && row.values.length) {
        html += '<select data-name="' + esc(row.name) + '">' +
          row.values.map((v) => '<option' + (v === row.value ? ' selected' : '') + '>' + esc(v) + '</option>').join('') +
          (row.values.indexOf(row.value) < 0 ? '<option selected>' + esc(row.value) + '</option>' : '') +
          '</select>';
      } else {
        html += '<input data-name="' + esc(row.name) + '" value="' + esc(row.value) + '">';
      }
      html += '<button class="remove" data-remove="' + esc(row.name) + '" title="Remove this attribute">✕</button>';
    }
    html += '</div>';
    if (state.canAppend) {
      html += '<div class="add">' +
        '<input id="add-name" list="members" placeholder="property">' +
        '<input id="add-value" list="member-values" placeholder="value">' +
        '<button id="add-btn">Add</button></div>';
      html += '<datalist id="members">' +
        state.addable.map((m) => '<option value="' + esc(m.name) + '">' + esc(m.type || '') + '</option>').join('') +
        '</datalist><datalist id="member-values"></datalist>';
    }
    root.innerHTML = html;

    document.getElementById('title').addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'reveal' });
    });
    for (const el of root.querySelectorAll('[data-name]')) {
      el.addEventListener('change', () => {
        vscodeApi.postMessage({ type: 'set', name: el.dataset.name, value: el.value });
      });
    }
    for (const el of root.querySelectorAll('[data-remove]')) {
      el.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'remove', name: el.dataset.remove });
      });
    }
    const addName = document.getElementById('add-name');
    const addBtn = document.getElementById('add-btn');
    if (addName && addBtn) {
      addName.addEventListener('input', () => {
        const member = state.addable.find((m) => m.name === addName.value);
        const list = document.getElementById('member-values');
        list.innerHTML = (member && member.values ? member.values : [])
          .map((v) => '<option value="' + esc(v) + '">').join('');
      });
      addBtn.addEventListener('click', () => {
        const name = addName.value.trim();
        const value = document.getElementById('add-value').value;
        if (name) {
          vscodeApi.postMessage({ type: 'set', name: name, value: value });
        }
      });
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type !== 'control' && msg.type !== 'none') { return; }
    if (editing()) { queued = msg; return; } // do not yank the form mid-edit
    state = msg;
    render();
  });
  window.addEventListener('focusout', () => {
    setTimeout(() => {
      if (queued && !editing()) { state = queued; queued = null; render(); }
    }, 100);
  });
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Static view preview (no system)
// ---------------------------------------------------------------------------

export interface ViewPreviewOptions {
  nonce: string;
  /** What the webview may load images from - `webview.cspSource`. */
  cspSource: string;
  /** The class or file the pictures are of. */
  title: string;
  /** One entry per view the file builds, already converted to webview URIs. */
  shots: ReadonlyArray<{ uri: string; label: string }>;
  /** Theme and viewport the pictures were taken in, for the caption. */
  theme: string;
  viewport: string;
  /** Where the model came from - a mock file, or the class itself. An empty
   *  table is a correct rendering of a model with no rows, and without this
   *  nobody can tell that from a broken binding. */
  data: string;
  /** Render errors that came WITH the pictures - shown, never hidden: a view
   *  with one broken binding still renders, and the picture is of the half
   *  that came up. */
  errors: readonly string[];
  /** Set while a re-render is in flight, so the last picture stays visible
   *  instead of the panel going blank on every save. */
  busy?: boolean;
  /** No picture at all - the message says why in the panel's own words. */
  problem?: string;
}

/**
 * The systemless view preview: the PNGs the render gate took, with what they
 * are of underneath them.
 *
 * Pictures rather than a live DOM on purpose. The renderer is a headless
 * Chromium outside this window, and piping its document into a webview would
 * mean shipping the whole UI5 runtime through the extension host to fake an
 * app that cannot round-trip anyway. A picture is what there is to see, and
 * it is honest about being one.
 */
export function viewPreviewHtml(options: ViewPreviewOptions): string {
  const { nonce, cspSource, title, shots, theme, viewport, data, errors, busy, problem } = options;
  const caption = `${escapeHtml(theme)} · ${escapeHtml(viewport)} · ${escapeHtml(data)}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>abap2UI5 View Preview</title>
<style nonce="${nonce}">
${BASE_CSS}
  body { padding: 12px 16px; overflow: auto; }
  h2 { font-size: 1.05em; margin: 0 0 2px; font-weight: 600; }
  .meta { opacity: 0.65; margin: 0 0 14px; font-size: 0.92em; }
  /* Side by side as soon as there is more than one: a device matrix and a
   * before/after comparison are both about seeing two pictures AT ONCE, and
   * stacked they would be a scroll apart. */
  .shots { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .shot { margin: 0 0 18px; flex: 1 1 320px; min-width: 0; }
  .shot img {
    max-width: 100%;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.4));
    border-radius: 4px;
    display: block;
  }
  .shot figcaption { opacity: 0.65; font-size: 0.9em; margin-top: 4px; }
  .problem, .errors {
    border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
    padding: 6px 10px;
    margin: 0 0 14px;
    background: var(--vscode-textBlockQuote-background, rgba(128,128,128,0.1));
  }
  .errors ul { margin: 4px 0 0; padding-left: 18px; }
  .errors code { font-family: var(--vscode-editor-font-family, monospace); }
  .busy { opacity: 0.5; }
</style>
</head>
<body>
  <h2>${escapeHtml(title)}</h2>
  <p class="meta">${caption}${busy ? " · rendering…" : ""}</p>
  ${problem ? `<p class="problem">${escapeHtml(problem)}</p>` : ""}
  ${
    errors.length
      ? `<div class="errors"><strong>${errors.length} render error${
          errors.length === 1 ? "" : "s"
        }</strong> - the picture shows what came up regardless:<ul>${errors
          .map((e) => `<li><code>${escapeHtml(e)}</code></li>`)
          .join("")}</ul></div>`
      : ""
  }
  <div class="shots ${busy ? "busy" : ""}">
  ${shots
    .map(
      (shot) => `<figure class="shot">
    <img src="${shot.uri}" alt="${escapeHtml(shot.label)}">
    <figcaption>${escapeHtml(shot.label)}</figcaption>
  </figure>`
    )
    .join("\n  ")}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// App navigation map
// ---------------------------------------------------------------------------

/** The map panel around a rendered SVG (see navmap.ts). App nodes carry
 *  `data-file`; a click posts it to the host, which opens the class. */
export function navMapHtml(options: {
  nonce: string;
  svg: string;
  appCount: number;
  edgeCount: number;
}): string {
  const { nonce, svg, appCount, edgeCount } = options;
  const empty = appCount === 0;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>abap2UI5 App Navigation</title>
<style nonce="${nonce}">
${BASE_CSS}
  body { padding: 12px 16px; overflow: auto; }
  .meta { opacity: 0.65; margin: 0 0 14px; }
  svg { max-width: none; }
  .edge {
    fill: none;
    stroke: var(--vscode-editorLineNumber-foreground, #888);
    stroke-width: 1.4;
    opacity: 0.75;
  }
  #arrow path { fill: var(--vscode-editorLineNumber-foreground, #888); }
  .node rect {
    fill: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.15));
    stroke: var(--vscode-panel-border, rgba(128,128,128,0.4));
  }
  .node[data-file] { cursor: pointer; }
  .node[data-file]:hover rect {
    stroke: var(--vscode-focusBorder);
    fill: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.25));
  }
  .node text {
    fill: var(--vscode-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
  }
  .node.ext rect { stroke-dasharray: 4 3; opacity: 0.7; }
  .node.ext text { opacity: 0.7; }
</style>
</head>
<body>
  <p class="meta">${
    empty
      ? "No abap2UI5 app classes found in the workspace - the map draws every class implementing <code>z2ui5_if_app</code> and each <code>nav_app_call( )</code> between them."
      : `${appCount} app${appCount === 1 ? "" : "s"}, ${edgeCount} navigation${
          edgeCount === 1 ? "" : "s"
        } - dashed nodes are nav targets whose source is not in this workspace. Click a node to open its class.`
  }</p>
  ${svg}
<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  for (const node of document.querySelectorAll('.node[data-file]')) {
    node.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'open', file: node.dataset.file });
    });
  }
})();
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Welcome / empty state
// ---------------------------------------------------------------------------

/** Where F9 opens an app — `abap2ui5.openMode`. */
export type OpenMode = "tab" | "panel" | "external";

export interface WelcomeOptions {
  nonce: string;
  /** False -> the first step nudges the user to configure the launch URL. */
  hasLaunchUrl: boolean;
  /**
   * Where F9 opens the app. Only `panel` ever replaces this screen with a
   * running app, so the other two say so rather than waiting forever.
   */
  openMode: OpenMode;
  /** Class of the app shown in an editor tab right now, if there is one. */
  runningClass?: string;
}

/**
 * The empty state of the panel view.
 *
 * It has to answer one question the old version left open: *why is nothing
 * happening here?* With the default `openMode` of `tab` this view is never
 * the one F9 fills, so it explains where the app goes instead and offers the
 * one click that moves it here.
 */
export function welcomeHtml(options: WelcomeOptions): string {
  const { nonce, hasLaunchUrl, openMode, runningClass } = options;
  const here = openMode === "panel";
  const elsewhere = openMode === "external" ? "in your browser" : "in an editor tab";
  const running = runningClass ? escapeHtml(runningClass) : "";

  // The three steps of the first run — step 2 names the place the app opens.
  const steps = `
    <ol>
      <li><span class="num">1</span><span>${
        hasLaunchUrl
          ? "Open an ABAP class that implements <code>z2ui5_if_app</code>."
          : "Set the launch URL of your system &mdash; asked once, stored in the settings."
      }</span></li>
      <li><span class="num">2</span><span>${
        hasLaunchUrl
          ? `Press <kbd>F9</kbd> &mdash; the app opens ${
              here ? "here" : elsewhere
            }, the cursor stays in the code.`
          : "Open an app class and press <kbd>F9</kbd>."
      }</span></li>
      <li><span class="num">3</span><span>Activate the class with <kbd>Ctrl+F3</kbd> &mdash; the preview reloads on its own. A save alone leaves the server on the active version, so it does not reload.</span></li>
    </ol>`;

  // An app is running, just not in this view: say where it is, not how to start.
  const away = `
    <p class="run"><span class="pill">${running}</span> is running in an editor tab.</p>
    <p class="sub">This panel shows the app only while <code>abap2ui5.openMode</code> is <code>panel</code>. Move it over &mdash; the app keeps running, it changes place.</p>`;

  const subtitle = here
    ? "Your app runs here, right next to the code."
    : `F9 opens your app ${elsewhere} &mdash; not in this panel.`;

  const primary =
    running && !here
      ? `<button data-command="abap2ui5.previewInPanel">${icon(
          "panel"
        )}Show it here</button><button class="secondary" data-command="abap2ui5.revealApp">${icon(
          "tab"
        )}Go to the tab</button>`
      : `<button data-command="${
          hasLaunchUrl ? "abap2ui5.selectSystem" : "abap2ui5.setLaunchUrl"
        }">${icon("link")}${
          hasLaunchUrl ? "Choose system" : "Set launch URL"
        }</button>${
          here
            ? ""
            : `<button class="secondary" data-command="abap2ui5.previewInPanel">${icon(
                "panel"
              )}Run apps here</button>`
        }`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>abap2UI5</title>
<style nonce="${nonce}">
${BASE_CSS}
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card { max-width: 460px; }
  h1 {
    margin: 0 0 4px;
    font-size: 1.25em;
    font-weight: 600;
  }
  .sub { margin: 0 0 20px; opacity: 0.7; }
  .run { margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
  .pill {
    font-family: var(--vscode-editor-font-family, monospace);
    font-weight: 600;
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  ol {
    margin: 0 0 20px;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  li { display: flex; gap: 10px; align-items: baseline; }
  .num {
    flex: none;
    width: 20px; height: 20px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.8em;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17));
    border-radius: 4px;
    padding: 1px 5px;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions button {
    padding: 5px 12px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  .actions button:hover { background: var(--vscode-button-hoverBackground); }
  .actions button.secondary {
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border-color: var(--vscode-panel-border, rgba(128,128,128,0.35));
  }
  .actions button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
  }
</style>
</head>
<body>
  <div class="card">
    <h1>abap2UI5 preview</h1>
    <p class="sub">${subtitle}</p>
    ${running && !here ? away : steps}
    <div class="actions">
      ${primary}
      ${
        running && !here
          ? ""
          : `<button class="secondary" data-command="abap2ui5.newApp">${icon(
              "code"
            )}Insert app template</button>`
      }
      <button class="secondary" data-command="abap2ui5.openHomepage">${icon("book")}Project on GitHub</button>
    </div>
  </div>
<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  for (const btn of document.querySelectorAll('[data-command]')) {
    btn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'command', command: btn.dataset.command });
    });
  }
})();
</script>
</body>
</html>`;
}
