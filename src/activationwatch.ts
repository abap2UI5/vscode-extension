import { AdtClassState, AdtStatusError } from "./proxy";
import { isNewer } from "./previewcore";

/*
 * Watch the server for the activation - `vscode`-free.
 *
 * Ctrl+F3 reloads by itself, but an activation done any other way — the ABAP
 * extension's own button or shortcut, even Eclipse — is invisible here:
 * VS Code has no event for it and the ABAP extensions expose none. So while
 * the preview is stale, the class is watched on the server instead. Two
 * signals say the activation happened:
 *
 * - the ADT metadata's version flips from "inactive" back to "active", or
 * - the class is "active" with a change timestamp NEWER than the version the
 *   preview shows. This is what catches a save+activate done as one action:
 *   on a fast system that can be finished before the first poll ever sees
 *   the inactive state, so waiting for the flip alone would wait forever.
 *
 * The timestamp of the shown version (the baseline) is captured whenever the
 * preview (re)loads. A source that never reaches the server changes neither
 * signal, so nothing reloads for purely local files.
 */

/** What the watch needs from the proxy - the real `SapProxy` satisfies it,
 *  and a test can hand in a scripted stand-in. */
export interface ClassStateSource {
  readonly isRunning: boolean;
  /** The system being forwarded to. What "ADT does not answer here" is a
   *  statement ABOUT, so the watch remembers that verdict per system rather
   *  than per session. */
  readonly systemOrigin?: string;
  fetchClassState(className: string, sapClient?: string): Promise<AdtClassState>;
}

/** What the watch polls for, and what it does once it sees the activation. */
export interface ActivationWatchDeps {
  source: ClassStateSource;
  /** The app the preview currently shows - undefined once it is gone. */
  current: () => { className: string; sapClient?: string } | undefined;
  log: (message: string) => void;
  /** Called when the activation was observed - reloads the preview. */
  reload: (reason: string) => void;
  /** Called when the watch times out without seeing an activation - the
   *  preview UI says so instead of leaving only a log line. */
  gaveUp?: (reason: string) => void;
}

/** Poll timing, injectable so the tests do not wait wall-clock seconds. */
export interface ActivationWatchTiming {
  firstMs: number;
  pollMs: number;
  timeoutMs: number;
  /** After this long the poll backs off to `slowPollMs` - the fast cadence
   *  serves the save-activate loop, not a watch left running for minutes. */
  slowAfterMs?: number;
  slowPollMs?: number;
}

// The first look happens right after the save: the saved source is already
// on the server as an inactive version at that point (the save event fires
// once the filesystem write went through), while the activation - even one
// kicked off together with the save - still takes its server roundtrips.
// Looking early is what guarantees the inactive state is seen at all; an
// activation that finishes before the first look would otherwise be waited
// for forever.
export const DEFAULT_TIMING: ActivationWatchTiming = {
  firstMs: 250,
  pollMs: 1500,
  timeoutMs: 10 * 60 * 1000,
  slowAfterMs: 60 * 1000,
  slowPollMs: 6000,
};

export class ActivationWatch {
  private timer: NodeJS.Timeout | undefined;
  /** Bumped on every stop, so an in-flight poll of an old watch goes stale. */
  private generation = 0;
  /**
   * Systems whose ADT answered 4xx: they will not start answering later, so
   * they are not asked again.
   *
   * Keyed by system origin, not a plain flag. As a flag it latched for the
   * whole window: one launch against a system where `/sap/bc/adt` is closed
   * (or the user lacks the authorization) switched reload-on-activation off
   * for every OTHER system too, until the window was reloaded - the feature
   * silently gone with only a log line to say so.
   */
  private adtUnavailable = new Set<string>();
  /** Server changedAt of the version the preview currently shows. */
  private baselineClass: string | undefined;
  private baselineChangedAt: string | undefined;

  constructor(
    private readonly deps: ActivationWatchDeps,
    private readonly timing: ActivationWatchTiming = DEFAULT_TIMING
  ) {}

  /**
   * Remembers the server's change timestamp of the class the preview shows
   * right now. Fire-and-forget: without a baseline the watch still reloads on
   * an observed inactive→active flip, just not on a too-fast-to-see one.
   */
  /** Whether this system has already refused the ADT lookup. */
  private refused(): boolean {
    const origin = this.deps.source.systemOrigin;
    return origin !== undefined && this.adtUnavailable.has(origin);
  }

  captureBaseline(): void {
    const { source, current, log } = this.deps;
    const target = current();
    if (!target || !source.isRunning || this.refused()) {
      return;
    }
    const className = target.className;
    /*
     * The answer belongs to the state the preview is in NOW. `stop()` bumps
     * the generation on every save and every reload, and this fetch is
     * fire-and-forget - so a slow answer could land after the next save had
     * already started a watch, overwrite the baseline with the OLDER
     * timestamp, and make the first poll read "changed since shown" for an
     * activation that never happened. That reload cleared the
     * "not activated" badge, which is precisely the thing the badge is there
     * to keep on the screen.
     */
    const gen = this.generation;
    void source.fetchClassState(className, target.sapClient).then(
      (state) => {
        if (gen !== this.generation) {
          return; // superseded: a newer capture or watch owns the baseline
        }
        this.baselineClass = className;
        this.baselineChangedAt = state.changedAt;
        log(
          `activation watch: shown ${className} was last changed ` +
            `${state.changedAt ?? "at an unknown time"}`
        );
      },
      () => {
        // No baseline; the inactive→active flip still triggers the reload.
      }
    );
  }

  stop(): void {
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  start(): void {
    this.stop();
    const { source, current, log } = this.deps;
    const target = current();
    if (!target) {
      return;
    }
    if (this.refused()) {
      log(
        `activation watch: not started - ADT already refused on ${source.systemOrigin}`
      );
      return;
    }
    if (!source.isRunning) {
      log("activation watch: not started - no auth proxy (openMode external?)");
      return;
    }
    const gen = this.generation;
    const className = target.className;
    const startedAt = Date.now();
    const deadline = startedAt + this.timing.timeoutMs;
    const sapClient = target.sapClient;
    log(
      `activation watch: started for ${className}` +
        (sapClient ? ` (client ${sapClient})` : "")
    );
    let sawInactive = false;
    let lastSeen: string | undefined; // last logged answer, to log changes only

    const tick = async (): Promise<void> => {
      this.timer = undefined;
      if (gen !== this.generation) {
        return;
      }
      const shown = current();
      if (!shown || shown.className !== className) {
        return; // preview gone or showing another app
      }
      let state: AdtClassState | undefined;
      try {
        state = await source.fetchClassState(className, sapClient);
      } catch (err) {
        if (err instanceof AdtStatusError && err.status >= 400 && err.status < 500) {
          // Not authorized / not exposed: it will not start answering later.
          const origin = source.systemOrigin;
          if (origin) {
            this.adtUnavailable.add(origin);
          }
          log(
            `activation watch: ADT answered ${err.status} - giving up on ` +
              `${origin ?? "this system"} (is /sap/bc/adt active on the ` +
              "launch-URL host?)"
          );
          return;
        }
        // network hiccup or 5xx: try again
        const reason = err instanceof Error ? err.message : String(err);
        if (lastSeen !== `error:${reason}`) {
          lastSeen = `error:${reason}`;
          log(`activation watch: request failed (${reason}) - retrying`);
        }
      }
      if (gen !== this.generation) {
        return;
      }
      if (state) {
        const version = state.version;
        if (version === undefined) {
          log(
            "activation watch: the ADT answer contained no version - stopping " +
              "(unexpected service behind /sap/bc/adt?)"
          );
          return;
        }
        if (version === "inactive" && !sawInactive) {
          sawInactive = true;
          log(`activation watch: ${className} is inactive on the server`);
        }
        if (version === "active") {
          // Newer change timestamp than the shown version = the save arrived
          // AND was activated, even when both were too fast to ever observe
          // the inactive state.
          const baseline =
            this.baselineClass === className ? this.baselineChangedAt : undefined;
          const changedSinceShown =
            !!state.changedAt && !!baseline && isNewer(state.changedAt, baseline);
          if (sawInactive || changedSinceShown) {
            log(
              `activation watch: ${className} is active ` +
                (sawInactive
                  ? "again"
                  : `with a newer change (${state.changedAt})`) +
                " - reloading"
            );
            this.deps.reload("Reloaded after activation");
            return;
          }
          if (lastSeen !== "active") {
            log(
              `activation watch: ${className} still shows no change on the ` +
                "server - waiting" +
                (baseline ? ` (shown state: ${baseline})` : " (no baseline)")
            );
          }
        }
        lastSeen = version;
      }
      const now = Date.now();
      if (now < deadline) {
        const { slowAfterMs, slowPollMs } = this.timing;
        const pollMs =
          slowAfterMs !== undefined &&
          slowPollMs !== undefined &&
          now - startedAt >= slowAfterMs
            ? slowPollMs
            : this.timing.pollMs;
        this.timer = setTimeout(() => void tick(), pollMs);
      } else {
        const minutes = Math.max(1, Math.round(this.timing.timeoutMs / 60_000));
        log(
          `activation watch: no activation within ${minutes} minute` +
            `${minutes === 1 ? "" : "s"} - giving up, reload manually`
        );
        this.deps.gaveUp?.("No activation seen - the watch gave up, reload manually");
      }
    };
    this.timer = setTimeout(() => void tick(), this.timing.firstMs);
  }

  dispose(): void {
    this.stop();
  }
}
