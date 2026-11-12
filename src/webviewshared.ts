/**
 * What every webview page shares: the CSP nonce, HTML and script escaping,
 * the theme / language / device-size lists, the inline icons and the base
 * stylesheet. The pages themselves live next to this file
 * (`webviewpreview.ts`, `webviewpanels.ts`, `webviewwelcome.ts`);
 * `webview.ts` re-exports all of it and is the module to import from.
 */

/** Random nonce so the webview CSP can allow exactly our own script/style.
 *  A nonce is a security token, so it comes from the crypto RNG - Math.random
 *  is predictable enough to be worth not relying on here. Web Crypto
 *  (`globalThis.crypto`) rather than node's "crypto" module: it is the same
 *  RNG in Node 22 and in a browser worker, and the node module is one the web
 *  bundle does not shim - importing it here is what kept this module out of
 *  the web graph. */
export function createNonce(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  // base64url by hand: btoa exists in both hosts, Buffer only in node
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON for interpolation into an inline `<script>`: `JSON.stringify` leaves
 *  `<` alone, so a value containing `</script>` would end the script element
 *  mid-string and put markup behind the nonce'd tag. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
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

/** Viewport widths of the preview's device buttons. The stage CSS, the
 *  button tooltips and the screenshot command all render the same numbers -
 *  one constant, so they cannot drift apart. */
export const DEVICE_WIDTHS = { tablet: 834, phone: 414 } as const;

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

/** `<option>` list with the current value pre-selected. A current value the
 *  list does not know (written by another version, say) gets its own entry -
 *  a select showing the wrong value silently would misreport what the URL
 *  actually carries. */
export function optionList(
  entries: ReadonlyArray<[string, string]>,
  current: string
): string {
  const known = entries.some(([value]) => value === current);
  return (
    entries
      .map(
        ([value, label]) =>
          `<option value="${escapeHtml(value)}"${
            value === current ? " selected" : ""
          }>${escapeHtml(label)}</option>`
      )
      .join("") +
    (known
      ? ""
      : `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`)
  );
}

// ---------------------------------------------------------------------------
// Icons (inline, so the webview needs no resources of its own)
// ---------------------------------------------------------------------------

export const ICON = {
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

export function icon(name: keyof typeof ICON): string {
  return `<svg class="ico" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
}

// ---------------------------------------------------------------------------
// Shared styling
// ---------------------------------------------------------------------------

export const BASE_CSS = `
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

