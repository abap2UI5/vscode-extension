/**
 * HTML for the three tool pages that need no running app: the "Control
 * Properties" view (`propertyEditorHtml`), the static view preview
 * (`viewPreviewHtml`) and the app navigation map (`navMapHtml`). Imported
 * through `webview.ts`.
 */

import { BASE_CSS, escapeHtml } from "./webviewshared";

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

  // Escapes for BOTH places the result is used: as text, and inside a
  // double-quoted attribute. The textContent/innerHTML round trip alone
  // escapes & < >, but NOT the quote - and every value here goes into
  // value="..." / title="..." / data-name="...". An ABAP literal may
  // legitimately contain one (a( 'say "hi"' )), which then closed the
  // attribute early and mangled the form row.
  function esc(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function render() {
    if (!state) { return; }
    if (state.type === 'none') {
      root.innerHTML = '<p class="empty">' + esc(state.reason || 'No builder control under the cursor.') + '</p>';
      return;
    }
    // Pinned in a local rather than read from the state object when a message
    // is sent: a refresh may repoint the form at a different control between
    // the click and its handler, and the host refuses an edit whose tokenStart
    // is not the one it is showing. Capturing it here binds every message to
    // the form the user actually clicked.
    const tokenStart = state.tokenStart;
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
      vscodeApi.postMessage({ type: 'reveal', tokenStart: tokenStart });
    });
    for (const el of root.querySelectorAll('[data-name]')) {
      el.addEventListener('change', () => {
        vscodeApi.postMessage({ type: 'set', name: el.dataset.name, value: el.value, tokenStart: tokenStart });
      });
    }
    for (const el of root.querySelectorAll('[data-remove]')) {
      el.addEventListener('click', () => {
        vscodeApi.postMessage({ type: 'remove', name: el.dataset.remove, tokenStart: tokenStart });
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
          vscodeApi.postMessage({ type: 'set', name: name, value: value, tokenStart: tokenStart });
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
  .loading { color: var(--vscode-descriptionForeground); text-align: center; padding: 2em 0; }
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
  ${
    busy && !shots.length
      ? `<p class="loading">Rendering the view in headless Chromium - the first run may take a few seconds…</p>`
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
  /** True when the workspace scan stopped at its file cap - the map may
   *  then be missing apps, and says so instead of posing as complete. */
  truncated?: boolean;
}): string {
  const { nonce, svg, appCount, edgeCount, truncated } = options;
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
  .edge[data-file] { cursor: pointer; pointer-events: stroke; }
  .edge[data-file]:hover { stroke: var(--vscode-focusBorder); opacity: 1; }
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
  #refresh {
    padding: 3px 10px;
    margin: 0 0 14px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border-color: var(--vscode-panel-border, rgba(128,128,128,0.35));
  }
  #refresh:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
  }
</style>
</head>
<body>
  <p class="meta">${
    empty
      ? "No abap2UI5 app classes found in the workspace - the map draws every class implementing <code>z2ui5_if_app</code> and each <code>nav_app_call( )</code> between them."
      : `${appCount} app${appCount === 1 ? "" : "s"}, ${edgeCount} navigation${
          edgeCount === 1 ? "" : "s"
        } - dashed nodes are nav targets whose source is not in this workspace. Click a node to open its class, an arrow to jump to its <code>nav_app_call( )</code>.`
  }${truncated ? " The scan stopped at its file cap - apps beyond it may be missing." : ""}</p>
  <button id="refresh">Refresh</button>
  ${svg}
<script nonce="${nonce}">
(function () {
  const vscodeApi = acquireVsCodeApi();
  for (const node of document.querySelectorAll('.node[data-file]')) {
    node.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'open', file: node.dataset.file });
    });
  }
  // an edge carries the nav_app_call( ) that draws it - clicking the arrow
  // jumps to that call rather than to the top of the class
  for (const edge of document.querySelectorAll('.edge[data-file]')) {
    edge.addEventListener('click', () => {
      vscodeApi.postMessage({
        type: 'open',
        file: edge.dataset.file,
        offset: Number(edge.dataset.offset),
      });
    });
  }
  document.getElementById('refresh')?.addEventListener('click', () => {
    vscodeApi.postMessage({ type: 'refresh' });
  });
})();
</script>
</body>
</html>`;
}

