import { stripJsonc } from "@abap2ui5/linter/config";
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

/** Parse an `abap2ui5lint.jsonc`'s TEXT. Comments are stripped by the
 *  linter's own `stripJsonc`, so a config it accepts parses identically here.
 *  Throws with the file named, the way the CLI reports it. */
export function parseLintConfig(text: string, file: string): Record<string, unknown> {
  try {
    return JSON.parse(stripJsonc(text)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `${file}: not valid JSONC - ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * The check options a parsed config produces, over the VS Code settings.
 *
 * The precedence is the CLI's: the repo config wins wherever it speaks, the
 * settings fill in the rest - except `allow`, where the two lists MERGE,
 * because a repo-wide allowance and a personal one are both meant.
 */
export function optionsFromConfig(
  raw: Record<string, unknown>,
  configFile: string,
  settings: SettingsOptions
): CheckOptions {
  const baseline = raw.baseline as string | undefined;
  return {
    minUi5: (raw.minUi5 as string) ?? (raw.ui5 as string) ?? settings.minUi5,
    distribution: (raw.distribution as string) ?? settings.distribution,
    allow: [...new Set([...((raw.allow as string[] | undefined) ?? []), ...settings.allow])],
    rules: raw.rules as Record<string, unknown> | undefined,
    baseline: baseline ? joinPath(dirOf(configFile), baseline) : undefined,
    configFile,
  };
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
