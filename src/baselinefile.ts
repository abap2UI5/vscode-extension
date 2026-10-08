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

/** A path with its symbolic links resolved - the file itself when it exists,
 *  else its directory (a baseline not written yet), else as given. */
function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    // not there (yet)
  }
  try {
    return path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
  } catch {
    return path.resolve(file);
  }
}

/**
 * Why `baselineFile` must not be written, or undefined when it may be.
 *
 * The file is whatever the repository's `abap2ui5lint.jsonc` names, and
 * "Add to Baseline" / "Update Baseline" REPLACE it with JSON. Unconfined, a
 * cloned repository saying `"baseline": "../../.config/Code/User/settings.json"`
 * (or committing a symbolic link that goes there) had the editor overwrite a
 * file of the user's on the first click. So it has to lie inside `root` - the
 * workspace folder holding the config - once its links are resolved; without
 * a root there is nothing to confine it to, and nothing is written.
 */
export function baselineWriteRefusal(
  baselineFile: string,
  root: string | undefined
): string | undefined {
  if (!root) {
    return (
      `refusing to write ${baselineFile} - no abap2ui5lint.jsonc in an open ` +
      "folder names it as this file's baseline"
    );
  }
  const rel = path.relative(realPath(root), realPath(baselineFile));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return (
      `refusing to write ${baselineFile} - the "baseline" of abap2ui5lint.jsonc ` +
      `lies outside the workspace folder ${root}. Point it at a file inside ` +
      "the repository."
    );
  }
  return undefined;
}

/** Throws the refusal, so no writer below can forget to ask. */
function assertWritable(baselineFile: string, root: string | undefined): void {
  const refusal = baselineWriteRefusal(baselineFile, root);
  if (refusal) {
    throw new Error(refusal);
  }
}

/** The one way a baseline is written: keys sorted for a stable diff, the
 *  stored note preserved, one trailing newline - shared by the append and
 *  the rebuild so the file format cannot fork. */
function writeBaseline(
  baselineFile: string,
  note: string | undefined,
  findings: Record<string, number>
): { entries: number; findings: number } {
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(findings).sort()) {
    sorted[k] = findings[k];
  }
  fs.writeFileSync(
    baselineFile,
    `${JSON.stringify({ note: note ?? NOTE, findings: sorted }, null, 2)}\n`
  );
  return {
    entries: Object.keys(sorted).length,
    findings: Object.values(sorted).reduce((a, b) => a + b, 0),
  };
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
  files: ReadonlyArray<{ file: string; findings: readonly PropertyFinding[] }>,
  root: string | undefined
): { entries: number; findings: number } {
  assertWritable(baselineFile, root);
  const raw = readBaseline(baselineFile);
  const counted: Record<string, number> = {};
  for (const { file, findings } of files) {
    for (const key of baselineKeys(baselineFile, file, findings)) {
      counted[key] = (counted[key] ?? 0) + 1;
    }
  }
  return writeBaseline(baselineFile, raw.note, counted);
}

/**
 * Appends one finding to the baseline file - the same key and count semantics
 * `--update-baseline` writes, so the CLI recognises the entry. Returns the key
 * that was added. Every writer takes the `root` the file must lie in (see
 * `baselineWriteRefusal`) and throws without touching anything outside it.
 */
export function addToBaseline(
  baselineFile: string,
  sourceFile: string,
  finding: PropertyFinding,
  root: string | undefined
): string {
  return addAllToBaseline(
    baselineFile,
    [{ file: sourceFile, findings: [finding] }],
    root
  )[0];
}

/**
 * Appends many findings with ONE read and ONE write. "Add all findings of
 * this rule" used to call `addToBaseline` per finding - a full parse, sort
 * and rewrite each time, and every write fired the baseline watcher, which
 * re-checks every open document. Returns the keys added, in order.
 */
export function addAllToBaseline(
  baselineFile: string,
  files: ReadonlyArray<{ file: string; findings: readonly PropertyFinding[] }>,
  root: string | undefined
): string[] {
  assertWritable(baselineFile, root);
  const raw = readBaseline(baselineFile);
  const findings: Record<string, number> = raw.findings ?? {};
  const added: string[] = [];
  for (const { file, findings: fileFindings } of files) {
    for (const key of baselineKeys(baselineFile, file, fileFindings)) {
      findings[key] = (findings[key] ?? 0) + 1;
      added.push(key);
    }
  }
  if (added.length) {
    writeBaseline(baselineFile, raw.note, findings);
  }
  return added;
}
