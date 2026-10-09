/*
 * The linter release this bundle ships, as `esbuild.js` stamped it: the npm
 * version from package-lock.json (`LINTER_PIN`) and the commit that version
 * was published from, from package.json's `linterRelease` (`LINTER_COMMIT`,
 * empty when that record does not speak for the locked version).
 *
 * Read HERE and nowhere else. The render gate's bundle URL, its `npx`
 * fallback and the bug report each read the defines themselves, and two
 * readers of one stamp are two places a fallback can differ.
 *
 * Dependency-free: a define is replaced at build time wherever the literal
 * `process.env.LINTER_…` appears - here alone.
 */

export interface LinterRelease {
  /** The bundled npm version, "" in a build with nothing stamped. */
  version: string;
  /** Its release commit (40 hex), "" when unknown - see esbuild.js. */
  commit: string;
}

export const LINTER_RELEASE: Readonly<LinterRelease> = Object.freeze({
  version: process.env.LINTER_PIN || "",
  commit: process.env.LINTER_COMMIT || "",
});
