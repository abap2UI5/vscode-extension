/*
 * repolayout - the sibling-checkout naming shared by every feature that
 * probes a repos root (the MCP registration, the local view-check fallback
 * and the example catalogues).
 *
 * The names themselves are NOT written here. abap2UI5/mcp-server owns the
 * ecosystem's rename history in `lib/repo-dirs.json`, because it is the
 * component that resolves the repos root; `src/data/repo-dirs.json` is a
 * generated snapshot of it (scripts/generate-repo-dirs.mjs, weekly drift gate
 * in bump-repo-dirs.yml, exactly like app-template.json and client-api.json).
 * A repository rename is one edit over there and one regenerated snapshot
 * here - never a second list to remember.
 *
 * Each list is newest first: a repository's current name, then what
 * `git clone` produced under its earlier names. GitHub redirects the old
 * paths, so a checkout made from an outdated README still sits in a directory
 * named after whichever name it was cloned under, and all of them resolve.
 */

import snapshot from "./data/repo-dirs.json";

const DIRS = snapshot.dirs as Record<string, readonly string[]>;

/** Directory names a linter checkout can carry (github.com/abap2UI5/linter). */
export const VIEW_CHECK_DIRS: readonly string[] = DIRS.viewCheck;

/** Directory names the control corpus can carry
 *  (github.com/abap2UI5/samples-controls) - the UI5 demo kit, ported. */
export const CORPUS_DIRS: readonly string[] = DIRS.corpus;

/** Directory names the pattern-sample checkout can carry
 *  (github.com/abap2UI5/samples). One of the three catalogues the MCP
 *  server's `examples` tool searches. */
export const SAMPLES_DIRS: readonly string[] = DIRS.samples;

/** Directory names the stack-sample checkout can carry
 *  (github.com/abap2UI5/samples-stack) - the apps that need an OData
 *  service, RAP, APC or the Fiori launchpad. The third catalogue. */
export const SAMPLES_STACK_DIRS: readonly string[] = DIRS.samplesStack;

/** Directory names an MCP server checkout can carry
 *  (github.com/abap2UI5/mcp-server, renamed from ai-mcp). Unlike the four
 *  above, this one is not passed to the server - it is how this extension
 *  FINDS the server before falling back to npx, so a checkout carrying the
 *  previous name has to keep working. */
export const SERVER_DIRS: readonly string[] = DIRS.server;
