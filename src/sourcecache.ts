/*
 * The shared text cache behind `abapsources.ts`, `vscode`-free so its two
 * clocks - the TTL past which an entry is validated, the idle time after
 * which the cache is dropped - can be tested against a fake file system.
 *
 * What it promises, and why each (the longer story is in abapsources.ts):
 *
 *   - a text is trusted on the watcher's word alone for `ttlMs`; past that
 *     the next read VALIDATES it with a stat and keeps the text when the
 *     file's mtime and size are what they were;
 *   - a cold read stats the file in the same step as it reads it
 *     (`Promise.all`), so the stamp is known from the first read on. It used
 *     not to be: the first read recorded no stamp, so the first validation
 *     past the TTL stat AND re-read every file of the workspace - and the
 *     idle eviction usually came before a second validation could pay off,
 *     which left the stat-validation path doing nothing but a stat;
 *   - `idleMs` after the last sweep the whole cache is dropped - it is a
 *     working set, not a session-long copy of the workspace - unless a
 *     sweep is in flight by then;
 *   - a read that was in flight while an invalidation landed answers but
 *     stores nothing: it may hold the text from before the change.
 */

/** The two calls the cache makes, over whatever names the caller uses. */
export interface SourceFs<U> {
  stat(ref: U): Promise<{ mtime: number; size: number }>;
  read(ref: U): Promise<string>;
}

export interface SourceCacheOptions {
  /** How long a text is trusted without a stat. */
  ttlMs: number;
  /** How long after the last sweep the cache is dropped whole. */
  idleMs: number;
  /** Above this many entries the cache is dropped rather than grown. */
  maxFiles: number;
  /** The clock, replaceable by the tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Entry {
  /** When the text was last read or validated. */
  at: number;
  text: string;
  /** The file's mtime and size at the stat that read or validated it. */
  stamp?: string;
}

export class SourceTextCache<U> {
  private readonly entries = new Map<string, Entry>();
  private idleEviction: unknown;
  private sweepsInFlight = 0;
  /** Bumped by every invalidation (`forget`, `forgetAll`). */
  private invalidationCount = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly fs: SourceFs<U>,
    private readonly options: SourceCacheOptions
  ) {
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  get invalidations(): number {
    return this.invalidationCount;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** This file's text is no longer what was read. */
  forget(key: string): void {
    this.invalidationCount++;
    this.entries.delete(key);
  }

  /** Everything is suspect. */
  forgetAll(): void {
    this.invalidationCount++;
    this.entries.clear();
  }

  /** Drops what an uncapped sweep did not see - a file the glob no longer
   *  finds has no business in the cache. */
  pruneTo(seen: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) {
      if (!seen.has(key)) {
        this.entries.delete(key);
      }
    }
  }

  /** Brackets a sweep: the idle eviction waits for the last one to end. */
  sweepStarted(): void {
    this.sweepsInFlight++;
  }

  sweepEnded(): void {
    this.sweepsInFlight--;
    this.scheduleIdleEviction();
  }

  dispose(): void {
    this.entries.clear();
    if (this.idleEviction !== undefined) {
      this.clearTimer(this.idleEviction);
      this.idleEviction = undefined;
    }
  }

  /**
   * One file's text: from the cache while fresh, validated by a stat past
   * the TTL, read (and stat'ed alongside) when cold or changed. Undefined
   * when the file is gone or unreadable.
   */
  async read(key: string, ref: U, now: number): Promise<string | undefined> {
    const cached = this.entries.get(key);
    if (cached && now - cached.at < this.options.ttlMs) {
      return cached.text;
    }
    const before = this.invalidationCount;
    let stamp: string | undefined;
    let text: string;
    try {
      if (cached) {
        // stat BEFORE the read: a change landing between the two makes the
        // next validation differ and re-read, never the other way round
        stamp = stampOf(await this.fs.stat(ref));
        if (cached.stamp !== undefined && cached.stamp === stamp && before === this.invalidationCount) {
          cached.at = now;
          return cached.text;
        }
        text = await this.fs.read(ref);
      } else {
        // cold: the stat in the same step as the read, so the first
        // validation past the TTL is a stat and not a second read
        const [stat, read] = await Promise.all([
          this.fs.stat(ref).then(stampOf, () => undefined),
          this.fs.read(ref),
        ]);
        stamp = stat;
        text = read;
      }
    } catch {
      // deleted between the glob and the read, or unreadable - not our
      // business to report, the next sweep will not find it either
      this.entries.delete(key);
      return undefined;
    }
    if (before !== this.invalidationCount) {
      return text; // possibly older than the change - answer, do not keep
    }
    if (this.entries.size >= this.options.maxFiles) {
      this.entries.clear();
    }
    this.entries.set(key, { at: now, text, stamp });
    return text;
  }

  /** Arms (or re-arms) the drop of the whole cache `idleMs` after the sweep
   *  that just ended - a sweep in flight by then keeps it. */
  private scheduleIdleEviction(): void {
    if (this.idleEviction !== undefined) {
      this.clearTimer(this.idleEviction);
    }
    this.idleEviction = this.setTimer(() => {
      this.idleEviction = undefined;
      if (this.sweepsInFlight === 0) {
        this.entries.clear();
      }
    }, this.options.idleMs);
  }
}

/** The file's mtime and size as one comparable string. */
function stampOf(stat: { mtime: number; size: number }): string {
  return `${stat.mtime}:${stat.size}`;
}
