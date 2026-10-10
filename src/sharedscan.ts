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

/**
 * `items` mapped through `work` with at most `width` calls in flight, the
 * results in the items' order - what the cold scan reads the workspace's
 * files with. Each read is a round trip to the extension host's file
 * service, and one after the other left that latency unoverlapped: 644
 * files were 644 serial round trips. `work` may answer undefined to leave
 * the item out; a `stop` that answers true before an item is dispatched
 * ends the walk there (the reads in flight still finish), which is how a
 * cancellation token reaches it.
 */
export async function mapInPool<T, R>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<R | undefined>,
  stop?: () => boolean
): Promise<R[]> {
  const slots = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !stop?.()) {
      const index = next++;
      slots[index] = await work(items[index]);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.max(1, Math.min(width, items.length)); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return slots.filter((r): r is R => r !== undefined);
}
