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
  const rel = path
    .relative(baselineBase(baselineFile), sourceFile)
    .split(path.sep)
    .join("/");
  const key = findingKey(rel, finding);
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
