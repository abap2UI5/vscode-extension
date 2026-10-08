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

import * as path from "path";
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

/** Directory names an abap-cloud-gui checkout can carry
 *  (github.com/abap2UI5-addons/abap-cloud-gui) - where "Migrate Classic
 *  Report to abap2UI5" finds report2cloud under the repos root. An OPTIONAL
 *  key of the snapshot (scripts/generate-repo-dirs.mjs): empty until
 *  mcp-server's main carries `cloudGui`, and the setting or
 *  ABAP_CLOUD_GUI_HOME still resolve the checkout meanwhile. */
export const CLOUD_GUI_DIRS: readonly string[] =
  (DIRS as Partial<Record<string, readonly string[]>>).cloudGui ?? [];

/** Directory name -> the environment variable mcp-server resolves that
 *  checkout with (the `env` of its `lib/repo-dirs.json` entry). What the
 *  stdio server and the unit-test runner are started with, so they find the
 *  same clones under `abap2ui5.mcp.reposRoot` this extension does. */
export const HOME_VARS: ReadonlyArray<readonly [string, string]> = [
  ["abap2UI5", "A2UI5_HOME"],
  ...CORPUS_DIRS.map((d) => [d, "SAMPLES_CONTROLS_HOME"] as const),
  ...VIEW_CHECK_DIRS.map((d) => [d, "AI_VIEW_CHECK_HOME"] as const),
  /* The `examples` tool searches THREE sample catalogues, and until it did,
   * only the corpus needed an env var here. A checkout the extension does not
   * point at is not an error over there - the tool answers from the ones it
   * can read - so a missing one costs a third of the answer silently, which
   * is exactly why both are passed whenever they are present. */
  ...SAMPLES_DIRS.map((d) => [d, "SAMPLES_HOME"] as const),
  ...SAMPLES_STACK_DIRS.map((d) => [d, "SAMPLES_STACK_HOME"] as const),
  /* migrate_report runs abap-cloud-gui's converter, and only from a LOCAL
   * checkout (mcp-server keeps no mirror of it): a server started through
   * npx looks for its siblings next to the npx cache, so without this the
   * checkout "Migrate Classic Report" itself finds under the repos root was
   * invisible to the agent's tool. */
  ...CLOUD_GUI_DIRS.map((d) => [d, "ABAP_CLOUD_GUI_HOME"] as const),
];

/** The env variables for the checkouts present under `root` - the first
 *  directory name found per variable wins, the current name over a legacy
 *  one. `exists` is injected so the test needs no file system. */
export function checkoutHomes(
  root: string,
  exists: (dir: string) => boolean
): Record<string, string> {
  const env: Record<string, string> = {};
  const base = root.trim();
  if (!base) {
    return env;
  }
  for (const [repo, envVar] of HOME_VARS) {
    if (env[envVar]) {
      continue;
    }
    const dir = path.join(base, repo);
    if (exists(dir)) {
      env[envVar] = dir;
    }
  }
  return env;
}
