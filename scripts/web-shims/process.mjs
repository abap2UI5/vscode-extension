// esbuild inject shim for the WEB bundle: the pieces of `process` the
// bundled linter reaches for.
//
// A browser extension host has no `process` at all, so `process.cwd()` is a
// ReferenceError there rather than a missing function - and the linter calls
// it on every `applyRules` (to derive the cwd-relative spelling of a file
// name for `exclude` matching). `esbuild.js` defines `process.cwd` and
// `process.env` to these, so nothing in the web graph ever touches the real
// global.
//
// The values match the `path` shim's virtual root: there is no working
// directory in a browser, and no environment to read.
export const web_process_cwd = () => "/";
export const web_process_env = {};
