import * as vscode from "vscode";
import * as path from "path";
import { CONFIG_SECTION } from "./settings";
import { checkSettings } from "./checktarget";
import { isShadowScheme } from "./abap";
import { GateOptions } from "./gate";
import { preparedAbapOf } from "./language";
import {
  cliCollects,
  isAllClassesFile,
  isCheckableSource,
  isViewSource,
  mayBeCheckable,
} from "./checkcore";
import { workspaceClassIndex } from "./classindexfeed";
import {
  CheckOptions,
  configGeneration,
  findConfigFile,
  resolveOptions,
} from "./lintconfig";

/*
 * viewcheckoptions - what the desktop view check asks about a DOCUMENT before
 * it gates anything: is it checkable (memoised per version), which directory
 * its repo config is discovered from, which options and baseline govern it.
 * Split out of viewcheck.ts, which re-exports the public names; the only
 * state here is the checkability memo, and nothing outside this module
 * reaches into it.
 */

export function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/* The settings half of a check's options - the four `viewCheck` settings
 * with the active system's profile laid over them - is `checkSettings( )`
 * in checktarget.ts. */

/**
 * The checkability verdicts, memoised per document version. `isCheckable`
 * runs on EVERY keystroke, before the live check's debounce - and for a
 * `*.clas.abap` the content test turns down it went on to `optionsFor`, i.e.
 * a `statSync` per config file of the chain, per keystroke. The content half
 * depends on the text alone; the `allClasses` half on the governing config,
 * so an entry also records the config generation it was computed under and
 * the two config watchers (`configChanged`, the settings listener) drop the
 * memo outright. Entries of closed documents go with the other per-document
 * caches.
 */
const checkableMemo = new Map<
  string,
  { version: number; verdict: boolean; configGen: number }
>();

export function forgetCheckable(uri: vscode.Uri): void {
  checkableMemo.delete(uri.toString());
}

/** Every verdict - what the two config watchers do (see above). */
export function clearCheckable(): void {
  checkableMemo.clear();
}

/** See `isCheckableSource` - this is only the document unwrapping. */
export function isCheckable(doc: vscode.TextDocument): boolean {
  // the revision side of a git diff is the same class again: checked, every
  // finding showed twice, and "fix all" put read-only edits into its one
  // WorkspaceEdit
  if (isShadowScheme(doc.uri.scheme)) {
    return false;
  }
  const key = doc.uri.toString();
  const cached = checkableMemo.get(key);
  if (
    cached &&
    cached.version === doc.version &&
    cached.configGen === configGeneration()
  ) {
    return cached.verdict;
  }
  const verdict = decideCheckable(doc);
  checkableMemo.set(key, { version: doc.version, verdict, configGen: configGeneration() });
  return verdict;
}

function decideCheckable(doc: vscode.TextDocument): boolean {
  // the name and language first, before the buffer is joined: this runs on
  // every change of EVERY document, and a multi-megabyte log or JSON file
  // edited beside the ABAP work paid a full getText( ) per keystroke for a
  // verdict its name alone decides
  if (!mayBeCheckable(doc.fileName, doc.languageId)) {
    return false;
  }
  const checkable =
    isCheckableSource(doc.fileName, doc.languageId, doc.getText()) ||
    // `allClasses` is the repository config's word - asked only for a class
    // the content test turned down (the options are cached per config mtime)
    (isAllClassesFile(doc.fileName) && optionsFor(doc).allClasses === true);
  if (!checkable) {
    return false;
  }
  /* Only what the CLI's walk would reach - the same rule the workspace sweep
   * applies (`gateOne`). The live check squiggled a class under a
   * dot-directory or one the config's `ignore` prunes, the sweep then
   * deleted those findings as stale, and the next keystroke brought them
   * back; the Problems count never matched CI for such a file. A document
   * outside every workspace folder (a class from a system) has no place in
   * that walk and stays checkable, as in the sweep. */
  if (doc.uri.scheme !== "file") {
    return true;
  }
  const opts = optionsFor(doc);
  const root = opts.configFile
    ? path.dirname(opts.configFile)
    : vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  if (!root) {
    return true;
  }
  return cliCollects(path.relative(root, doc.uri.fsPath), { ignore: opts.ignore, root });
}

/** Does the document build a view of its own - what the systemless preview
 *  and the mock generator need (an app class whose view comes from another
 *  class is checkable, but has nothing to render or to mock). */
export function hasOwnView(doc: vscode.TextDocument): boolean {
  return !isShadowScheme(doc.uri.scheme) && isViewSource(doc.fileName, doc.languageId, doc.getText());
}

/** The document to check on demand: the active editor when it is checkable,
 *  otherwise the first checkable visible editor - the command should work
 *  even when the focus sits in the preview or another non-text tab. */
export function pickDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active && isCheckable(active)) {
    return active;
  }
  for (const editor of vscode.window.visibleTextEditors) {
    if (isCheckable(editor.document)) {
      return editor.document;
    }
  }
  return active;
}

/** The directory the repo config is discovered from: the document's own
 *  folder, so a multi-root workspace resolves per file, exactly like the CLI
 *  invoked in that directory would. */
function discoveryDir(doc: vscode.TextDocument): string | undefined {
  return discoveryDirOf(doc.uri);
}

/** Same question for a uri: its own folder when it is a file, otherwise the
 *  workspace's - a class opened through ADT is governed by the config of the
 *  repository you have open, or by the settings when there is none. */
export function discoveryDirOf(uri: vscode.Uri): string | undefined {
  if (uri.scheme === "file") {
    return path.dirname(uri.fsPath);
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The baseline file governing this document, if its repo config names one -
 *  what the "add to baseline" quick fix appends to. */
export function baselineFileFor(doc: vscode.TextDocument): string | undefined {
  return doc.uri.scheme === "file" ? optionsFor(doc).baseline : undefined;
}

/** The folder a baseline named by `configFile` must lie in to be written:
 *  the workspace folder holding that config, or - for a config outside every
 *  open folder, which a cloned repository cannot put there - the config's own
 *  directory. See `baselineWriteRefusal`. */
export function baselineRootOfConfig(configFile: string): string {
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(configFile));
  return folder?.uri.scheme === "file" ? folder.uri.fsPath : path.dirname(configFile);
}

/** The same root for a source file, through the config that governs it -
 *  undefined when none does (then there is no baseline to write either). */
export function baselineRootFor(sourceFile: string): string | undefined {
  const configFile = findConfigFile(path.dirname(sourceFile));
  return configFile ? baselineRootOfConfig(configFile) : undefined;
}

export function optionsFor(doc: vscode.TextDocument): CheckOptions {
  return resolveOptions(discoveryDir(doc), checkSettings());
}

/** The options plus the language features' memoised reconstruction of this
 *  document - one `prepareAbap` per version instead of one per consumer
 *  (see `GateOptions.prep`). XML never has one. */
export function gateOptionsFor(
  doc: vscode.TextDocument,
  options: CheckOptions,
  isXml: boolean
): GateOptions {
  // the workspace's class index: what CI's checkFiles judges the class-level
  // rules with (classindexfeed.ts), undefined while the linter takes none
  return isXml
    ? options
    : { ...options, prep: preparedAbapOf(doc), classIndex: workspaceClassIndex() };
}
