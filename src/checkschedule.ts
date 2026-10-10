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
