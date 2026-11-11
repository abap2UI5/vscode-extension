import * as vscode from "vscode";
import * as path from "path";
import { checkSettings } from "./checktarget";
import { PropertyFinding } from "@abap2ui5/linter/properties";
import { GateResult, runGate, VIEW_XML_RE } from "./gate";
import { labelOf, noWorkspaceFolders } from "./abapsources";
import {
  cliCollects,
  editorFixPlan,
  isCheckableSource,
  workspaceFixSummary,
} from "./checkcore";
import {
  PlacedFindings,
  placeFindings,
  showProblemsMessage,
  textSource,
  toDiagnostics,
  toDiagnosticsPlaced,
} from "./diagnostics";
import { classIndexStamp, workspaceClassIndex } from "./classindexfeed";
import { plural } from "./text";
import { sweepEntryOf, sweepInBatches, textFingerprint } from "./checkschedule";
import { baselineWriteRefusal, rebuildBaseline } from "./baselinefile";
import { applyBaselineTo, clearBaselineCache, resolveOptions } from "./lintconfig";
import { baselineRootOfConfig, discoveryDirOf, isCheckable } from "./viewcheckoptions";
import { dropCachesIfConfigChanged, sweepCache } from "./viewcheckcaches";

/*
 * viewchecksweep - the view check over the WHOLE workspace: the sweep itself
 * (`sweepWorkspace`) and the three commands made of it - check, fix and the
 * baseline rebuild. Split out of viewcheck.ts, which registers the commands.
 * `sweeping` is assigned here alone; registration asks `isSweeping( )`.
 */

/** True while a workspace sweep runs. `fixWorkspace` opens every file it
 *  edits, and each open fires onDidOpenTextDocument - which scheduled a
 *  second full check of the same file, doubling the sweep's work and racing
 *  its own diagnostics.set. */
let sweeping = false;

/** What onDidOpenTextDocument asks before it schedules a check. */
export function isSweeping(): boolean {
  return sweeping;
}

// ---------------------------------------------------------------------------
// Whole workspace
// ---------------------------------------------------------------------------

/** File patterns the workspace sweep looks at - the NAMES the CLI's
 *  `collectFiles` walk collects: `*.clas.abap` and view/fragment XML. It used
 *  to be every `*.abap`, so a builder call inside `*.clas.testclasses.abap`,
 *  `*.clas.locals_imp.abap` or a report made the sweep check - and a rebuilt
 *  baseline name - files the CLI never sees, whose entries CI then failed as
 *  STALE. `cliCollects` finishes the job per file (dot-directories, the
 *  config's `ignore` patterns). */
const WORKSPACE_GLOB = "**/*.{clas.abap,view.xml,fragment.xml}";

/** What a sweep found, and whether it got to the end. A cancelled sweep has
 *  looked at part of the workspace, which is not the same answer - reporting
 *  "nothing found" for it, or applying its fixes as if they were the
 *  workspace's, says more than was actually checked. */
export interface SweepResult {
  files: SweptFile[];
  cancelled: boolean;
}

export interface SweptFile {
  uri: vscode.Uri;
  findings: PropertyFinding[];
  /** The version of the open document the findings were gated against, if it
   *  was open. `fixWorkspace` refuses to apply offsets to a buffer that has
   *  been typed in since - the sweep is `await`ed per file, so the window is
   *  real. Absent when the text came from disk. */
  version?: number;
  /** The findings' ranges, when the text came from disk and produced
   *  findings - computed while the text was in hand, so `checkWorkspace`
   *  places them without opening the file and without the sweep keeping
   *  the text. */
  placed?: PlacedFindings;
  /** `textFingerprint` of that text - what `fixWorkspace` compares the
   *  document against before it applies the offsets. */
  fingerprint?: string;
  /** The config file governing it, or undefined when the settings do - what
   *  `updateBaseline` filters on, so a nested config's files do not land in
   *  the root baseline as entries the CLI would call stale. */
  configFile?: string;
}

/**
 * Every checkable file in the workspace, gated once. Three commands are made
 * of this - check, fix and baseline - and they must agree on what "the
 * workspace says" means, down to which files are looked at and which config
 * governs each one.
 *
 * `baseline` decides whether the repo's baseline is applied: the check and
 * the fix want what the repo still considers a problem, while REBUILDING the
 * baseline needs the unfiltered truth - filtering it first would write a file
 * that waives nothing and calls every waived finding new on the next run.
 */
async function sweepWorkspace(
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  options: { baseline: boolean },
  log: (m: string) => void
): Promise<SweepResult> {
  /*
   * The workspace's files, plus the checkable documents this window has open
   * that are not among them. Without the second half a sweep run against a
   * system through ADT reported "no checkable files found" while the classes
   * were sitting open in the editor - and the on-save check had been
   * checking them all along.
   */
  // `node_modules` and the dot-directories are what the CLI's walk skips;
  // `.git` is named here only to spare the glob the descent - `cliCollects`
  // drops every other dot-entry (and would drop this one)
  const found = await vscode.workspace.findFiles(
    WORKSPACE_GLOB,
    "**/{node_modules,.git}/**"
  );
  /*
   * An open document WINS over the file of the same name, always - it is what
   * the user is looking at, and `fixWorkspace` turns these findings into
   * offsets that are then applied to exactly that document.
   *
   * Reading the file instead was a silent corruption: a class that is open
   * with unsaved changes AND on disk was gated against the disk text, and the
   * resulting character offsets were mapped through the dirty buffer. Every
   * fix after the first divergence landed a few characters off - mid-token,
   * in one WorkspaceEdit. The same mismatch put the workspace check's
   * squiggles on the wrong lines.
   */
  const open = new Map<string, vscode.TextDocument>();
  for (const doc of vscode.workspace.textDocuments) {
    open.set(doc.uri.toString(), doc);
  }
  const targets: Array<{ uri: vscode.Uri; open?: vscode.TextDocument }> = found.map(
    (uri) => ({ uri, open: open.get(uri.toString()) })
  );
  const known = new Set(found.map((uri) => uri.toString()));
  for (const doc of vscode.workspace.textDocuments) {
    if (!known.has(doc.uri.toString()) && isCheckable(doc)) {
      targets.push({ uri: doc.uri, open: doc });
    }
  }

  /* The settings half of the options, read once for the whole sweep: it is
   * the same four values for every file, and only the config DISCOVERED per
   * directory differs. Rebuilding it per file re-read four settings and
   * allocated an object per file for no answer that could change. */
  const sweepSettings = checkSettings();

  /* The I/O half runs AHEAD of the CPU-bound gate, in small concurrent
   * batches: the old loop awaited one stat, then one read, then gated, file
   * by file, so a sweep over a network share or a large repository spent most
   * of its wall time waiting on the disk one file at a time. A batch is
   * staged with `Promise.all` (bounded, so a 5000-file workspace does not
   * open 5000 reads at once) and then gated strictly IN ORDER - the finding
   * set and the order the callers see are exactly the serial loop's. The
   * host gets a turn after every gated file (`sweepInBatches`): the gate is
   * synchronous, and a batch of eight gated back to back, batch after batch,
   * held the shared extension host for the whole sweep.
   *
   * Progress is reported every `PROGRESS_EVERY` files plus once at the end:
   * per file it was one host roundtrip per entry, which on a fast gate cost
   * more than the check it reported on. */
  const IO_BATCH = 8;
  const PROGRESS_EVERY = 25;
  let reported = 0;
  const report = (index: number) => {
    progress.report({
      message: `${index + 1}/${targets.length} - ${labelOf(targets[index].uri)}`,
      increment: ((index + 1 - reported) * 100) / targets.length,
    });
    reported = index + 1;
  };

  /** One target's I/O, done concurrently within a batch: the cache stamp
   *  (version or mtime), and the text when the cache misses. `undefined`
   *  means the file vanished between the glob and the stat/read - skipped,
   *  as before. An open document is captured synchronously, so its text
   *  still matches the version in its stamp. */
  const stage = async (target: {
    uri: vscode.Uri;
    open?: vscode.TextDocument;
  }): Promise<
    | { stamp: string; text?: string; version?: number }
    | undefined
  > => {
    if (target.open) {
      // always with the text - it is already in memory, and carrying it even
      // on a cache hit means a cache cleared mid-sweep (a config change) can
      // still be gated instead of skipped. The version travels WITH the
      // text: `checkWorkspace` and `fixWorkspace` compare it against the
      // document's to decide whether the ranges still describe the buffer,
      // and a version read later, at gate time, after the batch's I/O and
      // the yield to the host, was the version of whatever the user had
      // typed by then - the guard then let old offsets into a new buffer.
      return {
        stamp: `v${target.open.version}|${classIndexStamp(target.uri.toString())}`,
        text: target.open.getText(),
        version: target.open.version,
      };
    }
    let stamp: string;
    try {
      /* The text is not all a class is judged on: what the class index says
       * about its superclass chain and its readers is too, so that is part
       * of the stamp - an edited superclass re-gates its subclasses, and
       * nothing else. */
      stamp =
        `m${(await vscode.workspace.fs.stat(target.uri)).mtime}` +
        `|${classIndexStamp(target.uri.toString())}`;
    } catch {
      return undefined;
    }
    const cached = sweepCache.get(target.uri.toString());
    if (cached && cached.stamp === stamp) {
      return { stamp };
    }
    try {
      /* TextDecoder, not Buffer.toString: it drops a byte-order mark, and
       * `TextDocument.getText()` never has one. Fixes carry character
       * offsets into the text they were computed from, and `fixWorkspace`
       * maps them through `doc.positionAt` of the BOM-less document - with
       * the mark counted in, every fix in such a file landed one character
       * off. The live check and the web sweep already read it this way; the
       * cost is that the sweep does not report `byte-order-mark` for a file
       * on disk, exactly as the live check does not. */
      return {
        stamp,
        text: new TextDecoder().decode(
          await vscode.workspace.fs.readFile(target.uri)
        ),
      };
    } catch {
      return undefined;
    }
  };

  const swept: SweptFile[] = [];
  /** One staged target, in the glob's order; true when the gate ran. */
  const gateOne = async (
    target: { uri: vscode.Uri; open?: vscode.TextDocument },
    io: { stamp: string; text?: string; version?: number } | undefined,
    index: number
  ): Promise<boolean> => {
    if ((index + 1) % PROGRESS_EVERY === 0 || index === targets.length - 1) {
      report(index);
    }
    if (!io) {
      return false;
    }
    const uri = target.uri;
    const key = uri.toString();
    // a document with no path on disk has no directory to discover a config
    // from - the workspace's own config governs it, as it does on the live path
    const opts = resolveOptions(discoveryDirOf(uri), sweepSettings);
    dropCachesIfConfigChanged();
    /* Only what the CLI's walk would reach, judged from the directory it
     * walks: the governing config's, or the workspace folder when the
     * settings govern. A file under a dot-directory or one a config
     * `ignore` pattern prunes is checked by nobody in CI - checking it here
     * squiggles what CI never sees, and a baseline rebuilt from it carries
     * an entry CI fails as stale. Open documents that the glob did not
     * find (a class from a system) have no place in that walk and stay. */
    if (known.has(key) && uri.scheme === "file") {
      const root = opts.configFile
        ? path.dirname(opts.configFile)
        : vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
      if (
        root &&
        !cliCollects(path.relative(root, uri.fsPath), { ignore: opts.ignore, root })
      ) {
        return false;
      }
    }
    /* Gated once per text: the cache key is the open document's version or
     * the file's mtime, so a re-run only pays for what changed since. The
     * cached findings are PRE-baseline - the baseline is applied per run
     * below, because the rebuild needs the unfiltered truth. */
    const cached = sweepCache.get(key);
    let entry = cached && cached.stamp === io.stamp ? cached : undefined;
    let gated = false;
    if (!entry) {
      let text = io.text;
      if (text === undefined) {
        // staged as a cache hit, but the entry was dropped between staging
        // and gating (a config change clears the cache mid-sweep) - re-read
        // rather than silently skip the file
        try {
          text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        } catch {
          return false;
        }
      }
      const isXml = VIEW_XML_RE.test(uri.path);
      // the content half of the linter's collectFiles: a builder (or
      // frozen-builder) class, an app class without a view, and under
      // `allClasses` every class
      if (!isXml && !isCheckableSource(uri.path, "abap", text, { allClasses: opts.allClasses })) {
        sweepCache.set(key, { stamp: io.stamp, findings: [], skip: true });
        return false;
      }
      let gate: GateResult;
      gated = true;
      try {
        gate = runGate(
          text,
          uri.scheme === "file" ? uri.fsPath : uri.path,
          isXml,
          isXml ? opts : { ...opts, classIndex: workspaceClassIndex() }
        );
      } catch (err) {
        // one file that cannot be parsed is not a reason to abandon the sweep
        log(`view-check: ${labelOf(uri)} skipped - ${String(err)}`);
        return true;
      }
      // the ranges now, while the text is here - the cache keeps those and
      // a fingerprint, not the text (an open document needs neither: its
      // version in the stamp says whether the findings still describe it)
      entry = sweepEntryOf(io.stamp, gate, target.open ? undefined : text, (gated, findings) =>
        placeFindings(textSource(gated), findings)
      );
      sweepCache.set(key, entry);
    }
    if (entry.skip) {
      return gated;
    }
    const findings = entry.findings.slice();
    if (options.baseline && opts.baseline && uri.scheme === "file") {
      applyBaselineTo(findings, opts.baseline, uri.fsPath);
    }
    swept.push({
      uri,
      findings,
      version: io.version,
      placed: entry.placed,
      fingerprint: entry.fingerprint,
      configFile: opts.configFile,
    });
    return gated;
  };
  await sweepInBatches(targets, {
    batch: IO_BATCH,
    stage,
    handle: gateOne,
    cancelled: () => token.isCancellationRequested,
  });
  return { files: swept, cancelled: token.isCancellationRequested };
}

/**
 * Checks every checkable file in the workspace, the way CI does, and fills
 * the Problems panel with the result. The on-save check only ever sees what
 * someone happened to open; this is the answer to "will the linter gate pass
 * before I push?".
 */
export async function checkWorkspace(
  diagnostics: vscode.DiagnosticCollection,
  log: (m: string) => void
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "abap2UI5: checking views",
      cancellable: true,
    },
    async (progress, token) => {
      sweeping = true;
      let swept: SweepResult;
      try {
        swept = await sweepWorkspace(progress, token, { baseline: true }, log);
        let problems = 0;
        let moved = 0;
        /* What the sweep published, and what it deliberately did not touch -
         * the reconciliation below removes everything else.
         *
         * Clearing the collection first was simpler and wrong: a file that
         * was edited WHILE the sweep ran is skipped as `moved`, so the clear
         * threw away the diagnostics the live check had just published for
         * the current text and put nothing back. The file then looked clean
         * until the next keystroke. */
        const published = new Set<string>();
        const untouched = new Set<string>();
        for (const file of swept.files) {
          /* Ranges come from the text that was gated: the open document when
           * it still is what was gated, the swept text otherwise - never a
           * buffer that was typed in while the sweep ran, whose lines the
           * findings no longer describe. Opening every clean file as a
           * document just to place nothing was the old cost here. */
          let diags: vscode.Diagnostic[] = [];
          if (file.version !== undefined) {
            const doc = vscode.workspace.textDocuments.find(
              (d) => d.uri.toString() === file.uri.toString()
            );
            if (!doc || doc.version !== file.version) {
              moved++;
              untouched.add(file.uri.toString());
              continue;
            }
            diags = toDiagnostics(doc, file.findings, []);
          } else if (file.findings.length && file.placed) {
            diags = toDiagnosticsPlaced(file.findings, file.placed);
          }
          diagnostics.set(file.uri, diags);
          published.add(file.uri.toString());
          problems += diags.length;
        }
        // What the sweep did not find is no longer a problem: a file that was
        // fixed, reverted or deleted since the last run kept its diagnostics
        // forever, because only the files it DID report were written.
        if (!swept.cancelled) {
          const stale: vscode.Uri[] = [];
          diagnostics.forEach((uri) => {
            const key = uri.toString();
            if (!published.has(key) && !untouched.has(key)) {
              stale.push(uri);
            }
          });
          for (const uri of stale) {
            diagnostics.delete(uri);
          }
        }
        if (moved) {
          log(
            `view-check: workspace check - ${moved} file(s) not reported, ` +
              "edited while the sweep ran"
          );
        }
        log(
          `view-check: workspace sweep - ${swept.files.length} file(s), ` +
            `${problems} problem(s)${swept.cancelled ? " (cancelled)" : ""}`
        );
        const summary = swept.cancelled
          ? `abap2UI5: cancelled after ${plural(swept.files.length, "file")} - ` +
            `${plural(problems, "problem")} so far.`
          : !swept.files.length
            ? noWorkspaceFolders()
              ? "abap2UI5: nothing checkable is open. Without a folder in " +
                "the workspace there is nothing to search, so the check " +
                "covers the classes you have open - open one and run it again."
              : "abap2UI5: no checkable ABAP or view files found in this workspace."
            : problems
              ? `abap2UI5: ${plural(problems, "problem")} in ${plural(swept.files.length, "file")} - see the Problems panel.`
              : `abap2UI5: ${plural(swept.files.length, "file")} checked, nothing found.`;
        if (problems) {
          showProblemsMessage(summary, false);
        } else {
          vscode.window.showInformationMessage(summary);
        }
      } finally {
        sweeping = false;
      }
    }
  );
}

/**
 * Every mechanical fix in the workspace, in one edit.
 *
 * The per-file "fix all" is the right size while you are writing one class,
 * and the wrong one for the two cases that actually hurt: adopting the linter
 * on a repository that never ran it, and a rule whose autofix arrived after
 * the code did. Both are workspace-shaped, and doing them file by file means
 * opening every file to find out that most need nothing.
 *
 * It goes through a WorkspaceEdit rather than writing files: one undo step,
 * the editor's own refactor preview, and unsaved buffers are respected
 * instead of overwritten.
 */
export async function fixWorkspace(log: (m: string) => void): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "abap2UI5: fixing views",
      cancellable: true,
    },
    async (progress, token) => {
      // held through the open loop below too: every openTextDocument fires
      // onDidOpenTextDocument, which would schedule a full check per file
      sweeping = true;
      try {
        const swept = await sweepWorkspace(progress, token, { baseline: true }, log);
        if (swept.cancelled) {
          // half a workspace's fixes applied as if they were the workspace's
          vscode.window.showInformationMessage(
            "abap2UI5: cancelled - nothing was changed."
          );
          return;
        }
        const edit = new vscode.WorkspaceEdit();
        /** Findings a span edit corrects, and files given an LF line ending -
         *  counted apart (`workspaceFixSummary`). */
        let fixed = 0;
        let toLf = 0;
        let files = 0;
        let moved = 0;
        for (const file of swept.files) {
          // `editorFixPlan`: a CRLF file is turned LF by a line-ending
          // change, not by its `\r` deletions, which no editor position
          // addresses
          const plan = editorFixPlan(file.findings);
          const planned = plan.spans;
          if (!planned.length && !plan.toLf) {
            continue;
          }
          const doc = await vscode.workspace.openTextDocument(file.uri);
          /* A fix is a pair of character offsets into the text that was gated.
           * If that text has changed since - the sweep awaits each file, and a
           * fast typist is faster than a workspace scan - the offsets address
           * different characters now, and applying them rewrites the wrong
           * span. Skipping is the only safe answer; the next run picks it up. */
          if (file.version !== undefined && doc.version !== file.version) {
            moved++;
            continue;
          }
          // Gated from DISK, but opened (and typed in) since: there is no
          // version to compare, the text itself has to match - by the
          // fingerprint the sweep kept of what it gated.
          if (
            file.version === undefined &&
            file.fingerprint !== undefined &&
            textFingerprint(doc.getText()) !== file.fingerprint
          ) {
            moved++;
            continue;
          }
          // through the refactor preview: a workspace's worth of edits is
          // reviewed, not sprung
          const meta = { needsConfirmation: true, label: "abap2UI5 mechanical fix" };
          const edits: Array<[vscode.TextEdit, vscode.WorkspaceEditEntryMetadata]> = planned.map(
            (fix) => [
              new vscode.TextEdit(
                new vscode.Range(doc.positionAt(fix.start), doc.positionAt(fix.end)),
                fix.text
              ),
              meta,
            ]
          );
          if (plan.toLf) {
            edits.push([vscode.TextEdit.setEndOfLine(vscode.EndOfLine.LF), meta]);
          }
          edit.set(file.uri, edits);
          // the CRLF finding is resolved by the line-ending change, not a span
          fixed += plan.findings - plan.byLineEnding;
          toLf += plan.toLf ? 1 : 0;
          files++;
        }
        if (moved) {
          log(
            `view-check: workspace fix - ${moved} file(s) skipped, edited while the sweep ran`
          );
        }
        const skipped = moved
          ? ` ${plural(moved, "file")} edited while the sweep ran ` +
            `${moved === 1 ? "was" : "were"} left alone.`
          : "";
        if (!files) {
          vscode.window.showInformationMessage(
            `abap2UI5: nothing in ${plural(swept.files.length, "file")} can be corrected mechanically.` +
              skipped
          );
          return;
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
          vscode.window.showInformationMessage(
            "abap2UI5: no fixes were applied." + skipped
          );
          return;
        }
        const summary = workspaceFixSummary({ fixed, toLf, files });
        log(`view-check: workspace fix - ${summary}`);
        /* Overlapping fixes are left for the next run, here as everywhere -
         * so the count is what was applied, not what remains, and saying so is
         * what tells someone to run it again. */
        vscode.window.showInformationMessage(
          `abap2UI5: ${summary}. ` +
            "Run it again if fixes overlapped; the files are edited, not saved." +
            skipped
        );
      } finally {
        sweeping = false;
      }
    }
  );
}

/**
 * Rebuild the repo's baseline from what the workspace reports now - the
 * editor's `--update-baseline`.
 *
 * Adopting the linter on a repository with history is the case this exists
 * for: the lightbulb can waive findings one at a time, which is right when
 * three are left and hopeless when four hundred are. The baseline file the
 * CLI honours is the supported way to say "everything as of today is known",
 * and until now writing it meant leaving the editor for the command line.
 */
export async function updateBaseline(
  log: (m: string) => void,
  /** viewcheck.ts's `recheckOpenDocuments` - handed in, because the memos it
   *  drops and the re-check it starts belong to the document check. */
  recheckOpenDocuments: () => void
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    vscode.window.showInformationMessage(
      "abap2UI5: no folder is open - a baseline belongs to a repository."
    );
    return;
  }
  // in a multi-root window the baseline of the INTENDED repository is
  // rebuilt, not silently the first folder's
  const folder =
    folders.length === 1
      ? folders[0]
      : await vscode.window.showWorkspaceFolderPick({
          placeHolder: "Which repository's baseline should be rebuilt?",
        });
  if (!folder) {
    return;
  }
  const rootOptions = resolveOptions(folder.uri.fsPath, checkSettings());
  const baselineFile = rootOptions.baseline;
  if (!baselineFile) {
    // the config path is known here, so the message can open the file the
    // line has to be added to
    const openConfig = rootOptions.configFile ? "Open abap2ui5lint.jsonc" : undefined;
    void vscode.window
      .showWarningMessage(
        'abap2UI5: this repository names no baseline. Add "baseline": ' +
          '"abap2ui5lint-baseline.json" to abap2ui5lint.jsonc first - the file ' +
          "is only honoured by the CLI when the config points at it.",
        ...(openConfig ? [openConfig] : [])
      )
      .then((pick) => {
        if (pick && rootOptions.configFile) {
          void vscode.window.showTextDocument(
            vscode.Uri.file(rootOptions.configFile)
          );
        }
      });
    return;
  }
  // refused before the sweep, not after it: rebuildBaseline asks again
  const baselineRoot = rootOptions.configFile
    ? baselineRootOfConfig(rootOptions.configFile)
    : undefined;
  const refusal = baselineWriteRefusal(baselineFile, baselineRoot);
  if (refusal) {
    vscode.window.showWarningMessage(`abap2UI5: ${refusal}`);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `abap2UI5: rewrite ${path.basename(baselineFile)} from what the workspace ` +
      "reports right now? Every finding that exists today becomes waived; " +
      "the previous content is replaced.",
    { modal: true },
    "Rebuild baseline"
  );
  if (confirmed !== "Rebuild baseline") {
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "abap2UI5: rebuilding the baseline",
      cancellable: true,
    },
    async (progress, token) => {
      // unfiltered on purpose: the baseline is what is being written, so it
      // must not be applied to the findings that write it
      sweeping = true;
      let swept: SweepResult;
      try {
        swept = await sweepWorkspace(progress, token, { baseline: false }, log);
      } finally {
        sweeping = false;
      }
      if (swept.cancelled) {
        vscode.window.showInformationMessage(
          "abap2UI5: cancelled - the baseline is unchanged."
        );
        return;
      }
      /*
       * Only real files this baseline's own config governs go in.
       *
       * The sweep deliberately also gates documents that have no file behind
       * them (a class opened through ADT), files of the other folders in a
       * multi-root window, and files a NESTED config governs - whose findings
       * the CLI applies against that config's own baseline, never this one.
       * None of them can ever produce a matching entry when the CLI runs over
       * this repository - and a baseline entry that matches nothing is not
       * inert: it is STALE, which the linter reports and CI fails on. So
       * writing them would hand somebody a baseline that breaks the build it
       * was written to unblock.
       */
      const root = path.dirname(baselineFile);
      const inRepo = (uri: vscode.Uri): boolean => {
        if (uri.scheme !== "file") {
          return false;
        }
        const rel = path.relative(root, uri.fsPath);
        return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      };
      // the CLI walks from the config's directory, and prunes what its
      // `ignore` names - a file it never collects cannot be a baseline entry
      const configDir = rootOptions.configFile
        ? path.dirname(rootOptions.configFile)
        : folder.uri.fsPath;
      const mine = swept.files.filter(
        (file) =>
          inRepo(file.uri) &&
          file.configFile === rootOptions.configFile &&
          cliCollects(path.relative(configDir, file.uri.fsPath), {
            ignore: rootOptions.ignore,
            root: configDir,
          })
      );
      const foreign = swept.files.length - mine.length;
      if (foreign) {
        log(
          `view-check: baseline - ${foreign} file(s) outside ${root}, with no ` +
            "file on disk, or governed by another config were not written into it"
        );
      }
      try {
        const written = rebuildBaseline(
          baselineFile,
          mine.map((file) => ({
            file: file.uri.fsPath,
            findings: file.findings,
          })),
          baselineRoot
        );
        // the file just changed; its memo is keyed on an mtime that may not
        // have moved yet
        clearBaselineCache(baselineFile);
        recheckOpenDocuments();
        log(
          `view-check: baseline rebuilt - ${written.findings} finding(s) in ` +
            `${written.entries} entries -> ${baselineFile}`
        );
        // the natural next step after a rewrite is looking at what was written
        const openBaseline = "Open Baseline";
        void vscode.window
          .showInformationMessage(
            `abap2UI5: ${path.basename(baselineFile)} now waives ` +
              `${plural(written.findings, "finding")} from ${plural(mine.length, "file")}.` +
              (foreign
                ? ` ${plural(foreign, "file")} outside the repository or governed by ` +
                  `another config ${foreign === 1 ? "was" : "were"} not included.`
                : ""),
            openBaseline
          )
          .then((pick) => {
            if (pick === openBaseline) {
              void vscode.window.showTextDocument(vscode.Uri.file(baselineFile));
            }
          });
      } catch (err) {
        vscode.window.showWarningMessage(
          `abap2UI5: could not write ${baselineFile} - ${String(err)}`
        );
      }
    }
  );
}
