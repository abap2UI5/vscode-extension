/*
 * The `tar` the render-gate installer extracts the checker bundle with, as
 * a bundle of its own: `esbuild.js` builds this entry to `dist/rendergate-tar.js`,
 * and `rendergate.ts` loads it the first time "Install Render Gate" runs.
 * Out of the main bundle on purpose - 86 KB that every activation parsed for
 * a command most windows never run.
 */
export { x } from "tar";
