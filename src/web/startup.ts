/*
 * The web activation's order, `vscode`-free so it can be tested without a
 * browser host (the in-host smoke test, `npm run test:web`, cannot run in a
 * restricted environment).
 *
 * The web entry has to READ its data - the UI5 snapshot (~575 KB), the
 * client API, the linter's icon data - through `workspace.fs`, and it used
 * to await all three before registering a single feature: every command,
 * provider and view waited on the slowest read. Now the registrations come
 * first and the reads after; what cannot run without the data - the gate -
 * is HELD on a `DataGate` until the reads are in, because a check that ran
 * before them would cache an empty icon registry in the linter for the
 * rest of the session (its `loadIcons` memoises per file, a failed read
 * included). Completion and hover need no holding: an unloaded snapshot
 * answers with no offers, and `setSnapshotText` replaces it.
 */

/** Work that must not run before the data is in: queued until `release`,
 *  then run in the order it was asked, and run at once afterwards. */
export class DataGate {
  private opened = false;
  private readonly waiting: Array<() => void> = [];

  get isOpen(): boolean {
    return this.opened;
  }

  /** Runs `fn` now when the gate is open, else once it opens. */
  whenOpen(fn: () => void): void {
    if (this.opened) {
      fn();
    } else {
      this.waiting.push(fn);
    }
  }

  /** Opens the gate and runs what waited, in order. A second call is a
   *  no-op. */
  release(): void {
    if (this.opened) {
      return;
    }
    this.opened = true;
    for (const fn of this.waiting.splice(0)) {
      fn();
    }
  }
}

export interface WebStartup {
  /** Every registration - runs first, synchronously. */
  register(): void;
  /** The data reads, concurrently; each answers a failure to log, or
   *  undefined. Never rejects: a read that can fail answers a message. */
  load(): Promise<ReadonlyArray<string | undefined>>;
  log(message: string): void;
  /** Released when the reads are in - whatever they answered: a snapshot
   *  that could not be read is logged, and the gate then runs with what
   *  there is, as it did before. */
  gate: DataGate;
}

/**
 * Register, then read, then release. The registrations are done before
 * the first `await`, so nothing the host asks for right after activation
 * waits on a read; the promise resolves once the reads are in and the
 * held checks have run.
 */
export async function startWeb(steps: WebStartup): Promise<void> {
  steps.register();
  let failures: ReadonlyArray<string | undefined> = [];
  try {
    failures = await steps.load();
  } catch (err) {
    // `load` is meant never to reject; if it does, the features run on
    // what was set before the throw rather than never at all
    failures = [`web: the data reads failed - ${err instanceof Error ? err.message : String(err)}`];
  }
  for (const failure of failures) {
    if (failure) {
      steps.log(failure);
    }
  }
  steps.gate.release();
}
