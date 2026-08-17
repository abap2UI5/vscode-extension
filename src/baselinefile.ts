import * as fs from "fs";
import * as path from "path";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { baselineBase, findingKey } from "@abap2ui5/linter/baseline";

/*
 * Reading and appending to the repo's abap2ui5lint baseline file.
 *
 * Split out of `quickfix.ts` for the usual reason in this codebase: that
 * module imports `vscode` and therefore cannot be reached by the node test
 * bundle, while this is plain file handling with a rule worth pinning down -
 * a baseline that does not parse must not be silently replaced.
 */

const NOTE =
  "abap2ui5-linter baseline: findings that existed when the linter " +
  "was adopted. Suppressed on every run; NEW findings still fail, " +
  "a STALE entry fails too. Regenerate with --update-baseline.";

interface Baseline {
  note?: string;
  findings?: Record<string, number>;
}

/**
 * The baseline as stored, or an empty one when the file does not exist yet.
 *
 * Throws when the file IS there and does not parse. That distinction is the
 * whole point: treating an unreadable baseline as an absent one would drop
 * every entry it carries on the next write, and a hand-edit or a merge
 * conflict is exactly how a baseline stops parsing.
 */
export function readBaseline(baselineFile: string): Baseline {
  let text: string | undefined;
  try {
    text = fs.readFileSync(baselineFile, "utf8");
  } catch {
    return {};
  }
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as Baseline;
  } catch (err) {
    throw new Error(
      `not a valid baseline file (${String(err)}) - fix or delete it, ` +
        "adding to it now would discard every entry it already carries"
    );
  }
}

/** The keys one file's findings contribute, with their counts - what both the
 *  single-finding append and the whole-file rebuild are made of. */
export function baselineKeys(
  baselineFile: string,
  sourceFile: string,
  findings: readonly PropertyFinding[]
): string[] {
  const rel = path
    .relative(baselineBase(baselineFile), sourceFile)
    .split(path.sep)
    .join("/");
  return findings.map((finding) => findingKey(rel, finding));
}

/**
 * Rewrite the baseline from what the whole workspace reports right now - the
 * editor's form of `--update-baseline`.
 *
 * A REPLACEMENT, not a merge, and that is the point: the CLI fails on a stale
 * entry (one nothing produces any more), so a baseline that only ever grows
 * would be a file nobody can keep green. What it costs is that every waiver
 * here is a waiver of something that exists today, which is exactly the
 * promise a baseline makes.
 */
export function rebuildBaseline(
  baselineFile: string,
  files: ReadonlyArray<{ file: string; findings: readonly PropertyFinding[] }>
): { entries: number; findings: number } {
  const raw = readBaseline(baselineFile);
  const counted: Record<string, number> = {};
  for (const { file, findings } of files) {
    for (const key of baselineKeys(baselineFile, file, findings)) {
      counted[key] = (counted[key] ?? 0) + 1;
    }
  }
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(counted).sort()) {
    sorted[k] = counted[k];
  }
  fs.writeFileSync(
    baselineFile,
    `${JSON.stringify({ note: raw.note ?? NOTE, findings: sorted }, null, 2)}\n`
  );
  return {
    entries: Object.keys(sorted).length,
    findings: Object.values(sorted).reduce((a, b) => a + b, 0),
  };
}

/**
 * Appends one finding to the baseline file - the same key and count semantics
 * `--update-baseline` writes, so the CLI recognises the entry. Returns the key
 * that was added.
 */
export function addToBaseline(
  baselineFile: string,
  sourceFile: string,
  finding: PropertyFinding
): string {
  const raw = readBaseline(baselineFile);
  const findings: Record<string, number> = raw.findings ?? {};
  const key = baselineKeys(baselineFile, sourceFile, [finding])[0];
  findings[key] = (findings[key] ?? 0) + 1;
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(findings).sort()) {
    sorted[k] = findings[k];
  }
  fs.writeFileSync(
    baselineFile,
    `${JSON.stringify({ note: raw.note ?? NOTE, findings: sorted }, null, 2)}\n`
  );
  return key;
}
