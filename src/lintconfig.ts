/*
 * The repo-level linter config, `abap2ui5lint.jsonc`.
 *
 * The linter's CLI and its GitHub Action honour that file, so CI checks a
 * repository against the UI5 floor, the distribution and the rule overrides
 * that repository pins. The editor used to read only the VS Code settings,
 * which meant the same file could be clean here and red in CI — the drift
 * AGENTS.md warned about. The config wins wherever it says something, because
 * CI is what has to pass; the settings fill in the rest.
 *
 * `vscode`-free: the settings come in as plain data, so the merge is a pure
 * function the test suite can drive.
 */

import * as fs from "fs";
import * as path from "path";
import { findConfigFrom, loadConfig, parseConfig } from "@abap2ui5/linter/config";
import type { LintConfig } from "@abap2ui5/linter/config";
import {
  applyBaseline,
  baselineBase,
  loadBaseline,
} from "@abap2ui5/linter/baseline";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { optionsFromConfig } from "./configcore";

/** The knobs both the config file and the VS Code settings can set. */
export interface CheckOptions {
  minUi5: string;
  /** `"sapui5"`, `"openui5"` - or null: nobody decided, which is the linter's
   *  own default and its own answer (a SAPUI5-only control is then a hint,
   *  not silence and not an error). */
  distribution: string | null;
  allow: string[];
  /** The config's `render` switch. `false` means CI does not run the render
   *  gate, so the editor must not announce a pass for it either. */
  render?: boolean;
  /** The config's `ignore` patterns - paths the CLI's directory walk prunes,
   *  which the workspace sweep therefore has to skip as well. */
  ignore?: string[];
  /** Per-rule severity overrides / switch-offs, as the linter interprets it. */
  rules?: Record<string, unknown>;
  /** The adoption baseline file (absolute) - findings it covers are dropped,
   *  exactly as `--baseline` drops them in CI. */
  baseline?: string;
  /** The config file the values came from, for the output channel. */
  configFile?: string;
  /** Set when a config file was found but could not be read. */
  error?: string;
}

/** What the extension's own settings contribute. */
export interface SettingsOptions {
  minUi5: string;
  /** null when the setting is left at its default: "not decided". */
  distribution: string | null;
  allow: string[];
  /** Per-rule severity overrides / switch-offs from the VS Code settings,
   *  in the shape `abap2ui5lint.jsonc` uses for the same thing. */
  rules?: Record<string, unknown>;
}

interface CacheEntry {
  /** The mtimes of every file the entry was read from, `extends` chain
   *  included - what decides whether it is still current. */
  stamp: string;
  /** Those files, so the next lookup knows which mtimes to compare. */
  chain: string[];
  loaded: LintConfig;
  error?: string;
}

const cache = new Map<string, CacheEntry>();

/** Forget everything — the config file changed on disk. */
export function clearConfigCache(): void {
  cache.clear();
  baselineCache.clear();
  discoveryCache.clear();
}

/** Bounds a runaway `extends` chain here - the linter refuses a cycle itself. */
const MAX_EXTENDS = 32;

/**
 * The files a config's answer is made of: itself, then whatever its `extends`
 * names, and so on - the same chain `loadConfig` follows. Read from the raw
 * text through the linter's own `parseConfig`, because the merged result
 * `loadConfig` returns has the `extends` key resolved away and says nothing
 * about where its values came from. A link that cannot be read or parsed ends
 * the chain there; `loadConfig` reports the same failure as the error.
 */
function configChain(file: string): string[] {
  const chain: string[] = [];
  let current: string | undefined = path.resolve(file);
  while (current && !chain.includes(current) && chain.length < MAX_EXTENDS) {
    chain.push(current);
    let text: string;
    try {
      text = fs.readFileSync(current, "utf8");
    } catch {
      break;
    }
    let base: string | undefined;
    try {
      base = (parseConfig(current, text) as { extends?: string }).extends;
    } catch {
      break;
    }
    current = base ? path.resolve(path.dirname(current), base) : undefined;
  }
  return chain;
}

/** The mtimes of a chain, as one comparable string. A file that is gone
 *  stamps as 0 - and differs from what it stamped as while it existed. */
function stampOf(chain: readonly string[]): string {
  return chain
    .map((f) => {
      try {
        return `${f}@${fs.statSync(f).mtimeMs}`;
      } catch {
        return `${f}@0`;
      }
    })
    .join("|");
}

/**
 * Reads a config file, memoised on the mtimes of every file it is made of:
 * the check runs on every keystroke once live checking is on, and re-parsing
 * JSONC that often would be the one avoidable cost in the whole path.
 *
 * Every file, not only the discovered one: a config that `extends` a base
 * file takes the base's values, and the memo used to be keyed on the
 * discovered file's mtime alone - so an edit to the base (a floor raised in
 * the shared config of a monorepo) changed nothing in the editor until the
 * extending file was touched or the window reloaded, while CI already
 * checked against the new value.
 */
function readConfig(file: string): CacheEntry {
  const cached = cache.get(file);
  if (cached && stampOf(cached.chain) === cached.stamp) {
    return cached;
  }
  const chain = configChain(file);
  const stamp = stampOf(chain);
  let entry: CacheEntry;
  try {
    entry = { stamp, chain, loaded: loadConfig(file) };
  } catch (err) {
    // A broken config is reported, never silently ignored: the linter itself
    // refuses to run on one, and pretending it is not there would mean the
    // editor checks against something CI does not.
    entry = {
      stamp,
      chain,
      loaded: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
  cache.set(file, entry);
  return entry;
}

/**
 * Which config file governs a directory, memoised.
 *
 * Only the PARSING was cached before, on the file's mtime - the discovery
 * itself walked the tree upward with a filesystem probe per level, on every
 * live check, every code-action request and every code-lens evaluation, i.e.
 * several times per keystroke. Both this and the parse memo are dropped by
 * `clearConfigCache`, which the config-file watcher calls, so a config that
 * appears or disappears is still noticed.
 */
const discoveryCache = new Map<string, string | undefined>();

/** The config file governing `dir`, searching upward — the linter's own
 *  discovery, so editor and CLI find the same file. */
export function findConfigFile(dir: string | undefined): string | undefined {
  if (!dir) {
    return undefined;
  }
  if (discoveryCache.has(dir)) {
    return discoveryCache.get(dir);
  }
  let found: string | undefined;
  try {
    found = findConfigFrom(dir) ?? undefined;
  } catch {
    found = undefined;
  }
  discoveryCache.set(dir, found);
  return found;
}

/**
 * The options one document is checked with: the repo config where it speaks,
 * the VS Code settings everywhere else. `allow` is the exception — the two
 * lists merge, because a repo-wide allowance and a personal one are both
 * meant. That is how the CLI treats it too.
 */
export function resolveOptions(
  dir: string | undefined,
  settings: SettingsOptions
): CheckOptions {
  const file = findConfigFile(dir);
  if (!file) {
    return { ...settings };
  }
  const { loaded, error } = readConfig(file);
  if (error) {
    return { ...settings, configFile: file, error };
  }
  /* The mapping itself lives in `configcore.ts`, shared with the web build:
   * two builds disagreeing about precedence is the same defect as an editor
   * disagreeing with CI. Only the READING differs - `fs` here, workspace.fs
   * there - and the baseline is re-resolved against the platform's own path
   * rules, since the shared code has to do without a `path` module. */
  const options = optionsFromConfig(loaded, file, settings);
  return {
    ...options,
    // only a real path: `"baseline": true` (a typo) fed to path.resolve
    // would throw out of every check that resolves options
    baseline:
      typeof loaded.baseline === "string" && loaded.baseline
        ? path.resolve(path.dirname(file), loaded.baseline)
        : undefined,
  };
}

interface BaselineEntry {
  mtimeMs: number;
  map: Map<string, number> | null;
}

const baselineCache = new Map<string, BaselineEntry>();

/** A baseline file as key -> count, memoised on its mtime like the config
 *  itself. An unreadable baseline suppresses nothing - the CLI fails on one,
 *  and hiding findings behind a broken file would be the opposite. */
function readBaseline(file: string): Map<string, number> | null {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const cached = baselineCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.map;
  }
  let map: Map<string, number> | null;
  try {
    map = loadBaseline(file);
  } catch {
    map = null;
  }
  baselineCache.set(file, { mtimeMs, map });
  return map;
}

/**
 * Forgets one baseline file - for the moment right after this extension wrote
 * it. The memo is keyed on the file's mtime, and filesystems whose timestamps
 * have one-second granularity report the same one for a write that closely
 * follows the read: the just-waived finding then kept its squiggle until
 * something else moved the clock.
 */
export function clearBaselineCache(file?: string): void {
  if (file) {
    baselineCache.delete(file);
  } else {
    baselineCache.clear();
  }
}

/**
 * Drops the findings the configured baseline covers - the adopted debt a
 * repository chose to grandfather. Returns how many were suppressed, so the
 * output channel can say the number instead of the findings just vanishing.
 * Stale entries are CI's to fail on, not the editor's.
 */
export function applyBaselineTo(
  findings: PropertyFinding[],
  baselineFile: string,
  sourceFilePath: string
): number {
  const map = readBaseline(baselineFile);
  if (!map || map.size === 0 || findings.length === 0) {
    return 0;
  }
  // applyBaseline consumes counts in place - copy, so one keystroke's check
  // does not eat the budget of the next
  const budget = new Map(map);
  const results = [{ file: sourceFilePath, findings }];
  const { suppressed } = applyBaseline(results, budget, baselineBase(baselineFile));
  findings.length = 0;
  findings.push(...results[0].findings);
  return suppressed;
}

/** One line for the output channel describing where the check's settings came
 *  from — the first question when the editor and CI disagree. */
export function describeOptions(options: CheckOptions): string {
  // an unrecognised distribution is echoed as written - this line exists for
  // diagnosing editor/CI disagreement, and a typo mapped to "SAPUI5" hides
  // exactly the mistake being looked for
  const dist =
    options.distribution === "openui5"
      ? "OpenUI5"
      : options.distribution === "sapui5"
        ? "SAPUI5"
        : options.distribution || "UI5 (distribution not set)";
  const from = options.configFile
    ? options.error
      ? `${options.configFile} (unreadable: ${options.error}) - using the VS Code settings`
      : options.configFile
    : "VS Code settings";
  return `target ${dist} ${options.minUi5}, from ${from}`;
}
