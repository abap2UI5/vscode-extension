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
}

/** Poll timing, injectable so the tests do not wait wall-clock seconds. */
export interface ActivationWatchTiming {
  firstMs: number;
  pollMs: number;
  timeoutMs: number;
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
};

export class ActivationWatch {
  private timer: NodeJS.Timeout | undefined;
  /** Bumped on every stop, so an in-flight poll of an old watch goes stale. */
  private generation = 0;
  /** ADT answered 4xx: this system will not tell us, stop asking for good. */
  private adtUnavailable = false;
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
  captureBaseline(): void {
    const { source, current, log } = this.deps;
    const target = current();
    if (!target || !source.isRunning || this.adtUnavailable) {
      return;
    }
    const className = target.className;
    void source.fetchClassState(className, target.sapClient).then(
      (state) => {
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
    if (this.adtUnavailable) {
      log("activation watch: not started - ADT already refused earlier this session");
      return;
    }
    if (!source.isRunning) {
      log("activation watch: not started - no auth proxy (openMode external?)");
      return;
    }
    const gen = this.generation;
    const className = target.className;
    const deadline = Date.now() + this.timing.timeoutMs;
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
          this.adtUnavailable = true;
          log(
            `activation watch: ADT answered ${err.status} - giving up for this ` +
              "session (is /sap/bc/adt active on the launch-URL host?)"
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
      if (Date.now() < deadline) {
        this.timer = setTimeout(() => void tick(), this.timing.pollMs);
      } else {
        log(
          "activation watch: no activation within 10 minutes - giving up, reload manually"
        );
      }
    };
    this.timer = setTimeout(() => void tick(), this.timing.firstMs);
  }

  dispose(): void {
    this.stop();
  }
}
