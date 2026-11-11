import { checkTargetGeneration } from "./checktarget";
import { GateResult } from "./gate";
import { PlacedFindings } from "./diagnostics";
import { GateMemo, SweepEntry } from "./checkschedule";
import { configGeneration } from "./lintconfig";

/*
 * viewcheckcaches - the desktop view check's two result caches and the one
 * rule that empties both: the per-document gate memo (`memos`, read and
 * seeded by `findingsNow` and `checkDocument` in viewcheck.ts) and the
 * workspace sweep's per-file cache (`sweepCache`, filled by
 * viewchecksweep.ts). They sit in one module because
 * `dropCachesIfConfigChanged` drops them together, and the generations they
 * were filled under are assigned here and nowhere else - the other modules
 * import `cachedUnderConfig` as a read-only live binding.
 */

/**
 * The gate result of a document as it stands right now, memoised per
 * document on its version and the config generation - one slot per URI, so
 * two checkable editors side by side do not evict each other. `findingsNow`
 * and `checkDocument` both read and seed it (`GateMemo`), so whichever asks
 * first for a version runs the gate and the other reads the result: the
 * lens and code-action refetch ~250 ms after a change used to gate first,
 * and the live check 400 ms after it gated the identical text again.
 * `baselined` rides along so the check's log line is what it was.
 *
 * The quick-fix provider needs the findings, and it must not work off the
 * findings behind the diagnostics currently shown: a fix carries character
 * offsets into the source it was computed from, and between the last check
 * and the moment the lightbulb is opened the buffer may have moved.
 * Recomputing is a few milliseconds - applying a stale offset would corrupt
 * the file.
 */
export const memos = new GateMemo<{ gate: GateResult; baselined: number }>();

/** The config generation the memos and the sweep cache were filled under -
 *  see `configGeneration`. */
export let cachedUnderConfig = configGeneration();

/** The same for the active system: what its profile contributes to the
 *  options (`checkTargetGeneration`). */
let cachedUnderTarget = checkTargetGeneration();

/** Drops both result caches when a config changed under them - called right
 *  after options were resolved, which is when a changed chain is noticed. */
export function dropCachesIfConfigChanged(): void {
  const now = configGeneration();
  const target = checkTargetGeneration();
  if (now !== cachedUnderConfig || target !== cachedUnderTarget) {
    cachedUnderConfig = now;
    cachedUnderTarget = target;
    memos.clear();
    sweepCache.clear();
  }
}

/** Gate results per file, keyed on what the text was when it was gated - the
 *  open document's version, or the file's mtime. Pre-baseline, so one cache
 *  serves the check, the fix and the baseline rebuild alike; dropped whenever
 *  a config or a setting changes the answer. Never the text: the ranges and
 *  a fingerprint of it (`SweepEntry`). */
export const sweepCache = new Map<string, SweepEntry<PlacedFindings>>();

export function clearSweepCache(): void {
  sweepCache.clear();
}
