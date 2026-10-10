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
