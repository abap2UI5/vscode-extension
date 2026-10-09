/*
 * One scan in flight, shared - `vscode`-free so the suite can pin it.
 *
 * `abapsources.ts` answers "which ABAP does this window know about" for the
 * app-class index, the class index, the apps tree and the symbol search, and
 * at activation several of them ask at once - before the text cache behind
 * the answer holds anything, so each of them read every file. A caller that
 * asks for the same thing while a scan is running, and nothing it depends on
 * changed since that scan STARTED, gets that scan's answer instead.
 */

export class SharedScan<T> {
  private inflight: { key: string; generation: number; promise: Promise<T> } | undefined;

  /**
   * `start( )`'s answer, or that of the scan already running under the same
   * `key` and `generation` - a generation bumped since (a file changed) means
   * the running scan may have read the old text, and a new one starts.
   */
  run(key: string, generation: number, start: () => Promise<T>): Promise<T> {
    const current = this.inflight;
    if (current && current.key === key && current.generation === generation) {
      return current.promise;
    }
    const entry = { key, generation, promise: start() };
    this.inflight = entry;
    const clear = (): void => {
      if (this.inflight === entry) {
        this.inflight = undefined;
      }
    };
    entry.promise.then(clear, clear);
    return entry.promise;
  }
}
