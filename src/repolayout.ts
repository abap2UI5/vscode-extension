/*
 * repolayout - the sibling-checkout naming shared by every feature that
 * probes a repos root (the MCP registration and the local view-check
 * fallback). One list here instead of one per call site; ai-mcp's
 * lib/repos.mjs carries the same VIEW_CHECK_DIRS for its own resolution.
 */

/** Directory names a linter checkout can carry, newest first: `linter` is
 *  the repository's own name (github.com/abap2UI5/linter), the other two are
 *  what `git clone` produced under its earlier names. */
export const VIEW_CHECK_DIRS = ["linter", "abap2UI5-linter", "ai-view-check"] as const;

/** Directory names the samples corpus checkout can carry, newest first:
 *  `samples-controls` is the repository's own name
 *  (github.com/abap2UI5/samples-controls), the other two are what
 *  `git clone` produced under its earlier names (`abap2UI5-api`, and
 *  `ai-demokit` before that); ai-mcp's lib/repos.mjs carries the same
 *  CORPUS_DIRS for its own resolution. */
export const CORPUS_DIRS = ["samples-controls", "abap2UI5-api", "ai-demokit"] as const;

/** Directory names the pattern-sample checkout can carry, newest first
 *  (github.com/abap2UI5/samples). One of the three catalogues the MCP
 *  server's `examples` tool searches. */
export const SAMPLES_DIRS = ["samples", "abap2UI5-samples"] as const;

/** Directory names the stack-sample checkout can carry, newest first
 *  (github.com/abap2UI5/samples-stack) - the apps that need an OData
 *  service, RAP, APC or the Fiori launchpad. The third catalogue. */
export const SAMPLES_STACK_DIRS = ["samples-stack", "abap2UI5-samples-stack"] as const;
