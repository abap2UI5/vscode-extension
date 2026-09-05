import { parseConfig } from "@abap2ui5/linter/config";
import type { LintConfig } from "@abap2ui5/linter/config";
import { applyBaseline } from "@abap2ui5/linter/baseline";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import type { CheckOptions, SettingsOptions } from "./lintconfig";

/*
 * configcore - what an `abap2ui5lint.jsonc` MEANS for a check, without
 * touching a filesystem.
 *
 * The desktop build reads the file with `fs` and the linter's own
 * `loadConfig`; the web build has neither and reads it through
 * `vscode.workspace.fs`. What both then do with the result has to be one
 * piece of code, or the two builds drift on precedence - which is the whole
 * defect this exists to prevent: an editor that checks against something CI
 * does not.
 *
 * Kept `fs`-free AND `path`-free on purpose. The web bundle aliases both to
 * shims that throw, so anything reached from `webcheck.ts` must do its own
 * string work on the '/'-separated paths a workspace URI carries.
 */

/** Config file names, in the linter's own discovery order. */
export const CONFIG_FILE_NAMES = ["abap2ui5lint.jsonc", "abap2ui5lint.json"];

/** The directory part of a '/'-separated path, "" for a bare file name. */
export function dirOf(filePath: string): string {
  const cut = filePath.lastIndexOf("/");
  return cut < 0 ? "" : filePath.slice(0, cut);
}

/** `dir` + a relative name, without a `path` module. */
export function joinPath(dir: string, name: string): string {
  if (!dir) {
    return name;
  }
  let base = dir;
  let rest = name;
  while (rest.startsWith("../")) {
    base = dirOf(base);
    rest = rest.slice(3);
  }
  return `${base.replace(/\/$/, "")}/${rest.replace(/^\.\//, "")}`;
}

/**
 * The config governing a file: the nearest one at or above it.
 *
 * The CLI walks upward from each path and takes the first hit, so a monorepo
 * with a config per app checks each app against its own. Given the flat list a
 * workspace search returns, the same answer is the candidate whose directory
 * is the longest prefix of the file's - and among two in one directory, the
 * `.jsonc` the linter prefers.
 */
export function nearestConfig(
  filePath: string,
  configFiles: readonly string[]
): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const candidate of configFiles) {
    const dir = dirOf(candidate);
    if (dir && !`${filePath}/`.startsWith(`${dir}/`)) {
      continue;
    }
    const rank = dir.length * 2 + (candidate.endsWith(".jsonc") ? 1 : 0);
    if (rank > bestLength) {
      best = candidate;
      bestLength = rank;
    }
  }
  return best;
}

/** A validated config, plus the one key `parseConfig` keeps that `loadConfig`
 *  resolves away: `extends`. The web host cannot follow it (no second file
 *  is read here), so it is surfaced for the caller to say so. */
export type ParsedLintConfig = LintConfig & { extends?: string };

/**
 * Parse an `abap2ui5lint.jsonc`'s TEXT, the way the CLI would.
 *
 * Through the linter's own `parseConfig`: the same JSONC stripping, the same
 * validation (an unknown key or rule id fails loudly, by design) and the same
 * normalisation - `ui5` folds into `minUi5` as a string, `distribution` is
 * lower-cased, `render: { pages }` becomes a boolean. A bare `JSON.parse`
 * skipped all of that, so the web build accepted a config the CLI refuses,
 * and read `"distribution": "OpenUI5"` as a spelling the property gate does
 * not recognise - which turned `sapui5-only-control` from the error CI
 * reports into a hint. Throws with the file named, as the CLI reports it.
 * `extends` is NOT followed - `loadConfig` does that with a filesystem; a
 * text-only consumer gets the key back to report.
 */
export function parseLintConfig(text: string, file: string): ParsedLintConfig {
  return parseConfig(file, text) as ParsedLintConfig;
}

/**
 * The check options a parsed config produces, over the VS Code settings.
 *
 * The precedence is the CLI's: the repo config wins wherever it speaks, the
 * settings fill in the rest - except `allow`, where the two lists MERGE,
 * because a repo-wide allowance and a personal one are both meant.
 */
export function optionsFromConfig(
  raw: LintConfig,
  configFile: string,
  settings: SettingsOptions
): CheckOptions {
  // only a real path may become one: `"baseline": true` is a typo, and
  // string work on it would throw out of every check that resolves options
  const baseline =
    typeof raw.baseline === "string" && raw.baseline ? raw.baseline : undefined;
  return {
    // `ui5` has already been folded into `minUi5` by the linter's validation
    minUi5: raw.minUi5 ?? settings.minUi5,
    // the config's own word, or the settings' - and `null` when neither
    // decided, which the linter treats as its own answer (see gate.ts)
    distribution: raw.distribution ?? settings.distribution,
    allow: [...new Set([...(raw.allow ?? []), ...settings.allow])],
    /*
     * Per RULE, not per block: the repo decides about the rules it names and
     * the settings fill in the rest. A personal opinion about a rule the
     * repository has one about would put the editor and CI on different
     * answers for the same file, which is the disagreement this whole module
     * exists to prevent - while a rule the repository says nothing about is
     * nobody else's business.
     */
    rules: mergeRules(settings.rules, raw.rules),
    baseline: baseline ? joinPath(dirOf(configFile), baseline) : undefined,
    configFile,
    // `render: false` switches CI's render gate off - the editor's must not
    // announce a pass for a gate the repository does not run
    render: raw.render,
    // the repo-level path patterns the CLI's walk prunes - what the workspace
    // sweep has to prune too, or a rebuilt baseline names files CI never sees
    ignore: raw.ignore,
  };
}

/** The repo config's rules over the settings', entry by entry. Undefined
 *  when neither side has an opinion, so the gate keeps its own defaults. */
function mergeRules(
  fromSettings: Record<string, unknown> | undefined,
  fromConfig: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!fromSettings && !fromConfig) {
    return undefined;
  }
  return { ...fromSettings, ...fromConfig };
}

/** A baseline file's text as key -> count. An unreadable one suppresses
 *  nothing: the CLI fails on it, and hiding findings behind a broken file
 *  would be the exact opposite of what it is for. */
export function parseBaseline(text: string): Map<string, number> | null {
  try {
    const raw = JSON.parse(text) as { findings?: Record<string, number> };
    return new Map(Object.entries(raw.findings ?? {}));
  } catch {
    return null;
  }
}

/**
 * Drop the findings a baseline covers. Same contract as the desktop path:
 * mutates `findings`, returns how many went, and leaves stale entries for CI
 * to fail on.
 */
export function applyBaselineMap(
  findings: PropertyFinding[],
  baseline: Map<string, number>,
  baselineFile: string,
  sourceFilePath: string
): number {
  if (!baseline.size || !findings.length) {
    return 0;
  }
  // applyBaseline consumes the counts in place - copy, so one keystroke's
  // check does not eat the budget of the next
  const results = [{ file: sourceFilePath, findings }];
  const { suppressed } = applyBaseline(results, new Map(baseline), dirOf(baselineFile));
  findings.length = 0;
  findings.push(...results[0].findings);
  return suppressed;
}
