/**
 * HTML for the empty state shown before the first F9 (`welcomeHtml`).
 * Imported through `webview.ts`.
 */

import { BASE_CSS, escapeHtml, icon } from "./webviewshared";

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
  /** Most recently launched app in this window - one click to run it again. */
  recentApp?: string;
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
  const { nonce, hasLaunchUrl, openMode, runningClass, recentApp } = options;
  const here = openMode === "panel";
  const elsewhere = openMode === "external" ? "in your browser" : "in an editor tab";
  const running = runningClass ? escapeHtml(runningClass) : "";

  // The last launched app, one click away - only while nothing is running,
  // and only once a launch URL exists to run it against.
  const rerun =
    !running && hasLaunchUrl && recentApp
      ? `<button data-run="${escapeHtml(recentApp)}">${icon("refresh")}Run ${escapeHtml(
          recentApp
        )}</button>`
      : "";

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
      <li><span class="num">3</span><span>Activate the class &mdash; <kbd>Ctrl+F3</kbd> in an ADT document (in an app class file on disk it pushes the class to the system first), or the <em>activate</em> button in the preview toolbar / the command <em>Activate and Reload Preview</em> &mdash; and the preview reloads on its own. A save alone leaves the server on the active version, so it does not reload.</span></li>
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
    <h1>abap2UI5 Preview</h1>
    <p class="sub">${subtitle}</p>
    ${running && !here ? away : steps}
    <div class="actions">
      ${rerun}
      ${primary}
      ${
        running && !here
          ? ""
          : `<button class="secondary" data-command="abap2ui5.newApp">${icon(
              "code"
            )}New app from template</button>`
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
  for (const btn of document.querySelectorAll('[data-run]')) {
    btn.addEventListener('click', () => {
      vscodeApi.postMessage({ type: 'runRecent', value: btn.dataset.run });
    });
  }
})();
</script>
</body>
</html>`;
}
