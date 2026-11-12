/*
 * The `tar` the render-gate installer extracts the checker bundle with, as
 * a bundle of its own: `esbuild.js` builds this entry to `dist/rendergate-tar.js`,
 * and `rendergate.ts` loads it the first time "Install Render Gate" runs.
 * Out of the main bundle on purpose - 86 KB that every activation parsed for
 * a command most windows never run.
 *
 * "Install Report Converter" (`report2ui5install.ts`) reads its archives
 * through the same file: `Parser` is what `x` unpacks with, so exporting it
 * costs the bundle nothing, and `tar` stays bundled once.
 */
export { x, Parser } from "tar";
