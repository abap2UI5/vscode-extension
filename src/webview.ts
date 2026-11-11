/**
 * HTML for the webviews the extension renders. This is the module everyone
 * imports from; the markup itself lives in four files next to it:
 *
 * - `webviewshared.ts` — nonce, escaping, the theme / language / device
 *   lists, the inline icons and the base stylesheet.
 * - `webviewpreview.ts` — `previewHtml`, the running app: toolbar, device
 *   sizes, loading overlay.
 * - `webviewpanels.ts` — `propertyEditorHtml`, `viewPreviewHtml` and
 *   `navMapHtml`, the tool pages that need no running app.
 * - `webviewwelcome.ts` — `welcomeHtml`, the empty state shown before the
 *   first F9.
 *
 * All are plain strings without any build step. They only use VS Code theme
 * variables, so they follow the user's colour theme (light, dark, contrast).
 */

export {
  DEVICE_WIDTHS,
  LANGUAGES,
  THEMES,
  createNonce,
  escapeHtml,
  scriptJson,
} from "./webviewshared";
export { previewHtml } from "./webviewpreview";
export type { PreviewOptions } from "./webviewpreview";
export { navMapHtml, propertyEditorHtml, viewPreviewHtml } from "./webviewpanels";
export type { ViewPreviewOptions } from "./webviewpanels";
export { welcomeHtml } from "./webviewwelcome";
export type { OpenMode, WelcomeOptions } from "./webviewwelcome";
