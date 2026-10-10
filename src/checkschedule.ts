/*
 * The view check's `vscode`-free scheduling decisions - shared by the
 * desktop check (viewcheck.ts) and the web check (webcheck.ts), which keep
 * the timers, the documents and the diagnostics.
 *
 *   - in which order, and how far apart, "re-check everything open" runs
 *     its checks (`recheckSchedule`);
 *   - the per-document memo that lets one gate run serve the live check,
 *     the lightbulb, the status bar and the lens (`GateMemo`);
 *   - how a workspace sweep stages its I/O in batches and yields the host
 *     between the files it gates (`sweepInBatches`);
 *   - what the sweep remembers per file, and that it is not the text
 *     (`sweepEntryOf`, `textFingerprint`).
 */

import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { hashOf } from "./classindex";

/** How far apart the re-check of the documents NOT visible is spread. */
export const RECHECK_STAGGER_MS = 50;

/**
 * The delays a re-check of every open document is scheduled with: the
 * documents visible in an editor at once (they are what the user looks at),
 * the rest one after the other, `step` ms apart. Activation, a config
 * change and a class-index change all re-check what is open; with twenty
 * tabs open they used to schedule twenty gate runs for the same moment,
 * which the host ran back to back before it painted the visible one.
 */
export function recheckSchedule<T>(
  docs: readonly T[],
  isVisible: (doc: T) => boolean,
  step = RECHECK_STAGGER_MS
): Array<{ doc: T; delay: number }> {
  const visible: Array<{ doc: T; delay: number }> = [];
  const hidden: Array<{ doc: T; delay: number }> = [];
  for (const doc of docs) {
    if (isVisible(doc)) {
      visible.push({ doc, delay: 0 });
    } else {
      hidden.push({ doc, delay: step * (hidden.length + 1) });
    }
  }
  return [...visible, ...hidden];
}

/** What a workspace sweep hands `sweepInBatches`. */
export interface BatchSweep<T, S> {
  /** How many targets are staged (their I/O started) at once. */
  batch: number;
  /** One target's I/O - runs concurrently within a batch. `undefined` is a
   *  target that vanished (skipped, still handled so progress counts it). */
  stage: (target: T) => Promise<S | undefined>;
  /** One target, strictly in order. True when it did the CPU-bound work
   *  (gated the file) - the host gets a turn after every such one. */
  handle: (target: T, staged: S | undefined, index: number) => Promise<boolean> | boolean;
  cancelled: () => boolean;
  /** Replaced by the tests; a macrotask by default. */
  yieldTurn?: () => Promise<void>;
}

/**
 * A sweep's loop: the I/O of a batch ahead of the gate (`Promise.all` over
 * `batch` targets, so a 5000-file workspace does not open 5000 reads at
 * once), then each target handled in the glob's order - and a yield to the
 * host after every file that was actually gated. The gate is synchronous
 * and takes a few milliseconds per class; eight of them back to back per
 * batch, batch after batch, held the shared extension host for the whole
 * sweep, and the progress notification, the cursor and every other
 * extension waited with it. A cache hit costs nothing and gets no yield.
 *
 * Cancellation is asked before every target, as the serial loop asked it:
 * a cancelled sweep stops after the file it is on, and the caller reports
 * what it got as partial.
 */
export async function sweepInBatches<T, S>(
  targets: readonly T[],
  sweep: BatchSweep<T, S>
): Promise<void> {
  const yieldTurn = sweep.yieldTurn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  for (let base = 0; base < targets.length && !sweep.cancelled(); base += sweep.batch) {
    const batch = targets.slice(base, base + sweep.batch);
    const staged = await Promise.all(batch.map(sweep.stage));
    for (const [offset, io] of staged.entries()) {
      if (sweep.cancelled()) {
        return;
      }
      if (await sweep.handle(batch[offset], io, base + offset)) {
        await yieldTurn();
      }
    }
  }
}

/** What the sweep cache holds per file - and what it does not: the text.
 *  Until a config change dropped the cache, it kept the whole text of every
 *  file read from disk that had findings, for two uses that need less: the
 *  ranges of those findings (`placed`, computed while the text was in hand)
 *  and "is the file still what was gated" before a fix is applied to it
 *  (`fingerprint`). Both are stored, the text is let go. */
export interface SweepEntry<P> {
  /** The open document's version or the file's mtime, plus the class index's stamp. */
  stamp: string;
  /** Pre-baseline - one cache serves the check, the fix and the rebuild. */
  findings: PropertyFinding[];
  /** Nothing to gate (not checkable, or the gate found nothing to judge). */
  skip?: boolean;
  /** The findings' ranges, for a file read from disk that has findings. */
  placed?: P;
  /** `textFingerprint` of that text, for the same files. */
  fingerprint?: string;
}

/** A short identity of a text - length and two independent 32-bit hashes
 *  (`hashOf`) - that the workspace fix compares the document against before
 *  it applies offsets computed from the swept text. */
export function textFingerprint(text: string): string {
  return hashOf(text);
}

/**
 * The entry a gate result becomes. `text` is the DISK text - undefined for
 * an open document, whose version in the stamp already says whether the
 * findings still describe it. `place` runs only when there is something to
 * place: a file from disk with findings.
 */
export function sweepEntryOf<P>(
  stamp: string,
  gate: { findings: PropertyFinding[]; nothingChecked?: string },
  text: string | undefined,
  place: (text: string, findings: PropertyFinding[]) => P
): SweepEntry<P> {
  if (gate.nothingChecked) {
    return { stamp, findings: [], skip: true };
  }
  if (text === undefined || !gate.findings.length) {
    return { stamp, findings: gate.findings };
  }
  return {
    stamp,
    findings: gate.findings,
    placed: place(text, gate.findings),
    fingerprint: textFingerprint(text),
  };
}

/**
 * One gate run per document version, whoever asks first.
 *
 * The live check gates a document 400 ms after the last keystroke; the
 * lightbulb, the lens and the status bar ask `findingsNow` for the same
 * version - and VS Code refetches code lenses and code actions ~250 ms
 * after a change, so that ask came FIRST, ran the gate on a memo miss, and
 * the live check then ran it a second time over the identical text. An
 * entry is good for one document version under one config generation; the
 * callers clear the memo when something else the verdict depends on moves
 * (a baseline file, the class index).
 */
export class GateMemo<R> {
  private readonly entries = new Map<string, { version: number; configGen: number; result: R }>();

  get(key: string, version: number, configGen: number): R | undefined {
    const entry = this.entries.get(key);
    return entry && entry.version === version && entry.configGen === configGen
      ? entry.result
      : undefined;
  }

  set(key: string, version: number, configGen: number, result: R): void {
    this.entries.set(key, { version, configGen, result });
  }

  /** The memo's result for this version, or `run()`'s - stored. A `run`
   *  that throws stores nothing (the next ask runs it again). */
  once(key: string, version: number, configGen: number, run: () => R): R {
    const hit = this.get(key, version, configGen);
    if (hit !== undefined) {
      return hit;
    }
    const result = run();
    this.set(key, version, configGen, result);
    return result;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
