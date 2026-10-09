import { ClassIndex, ClassIndexStore } from "./classindex";

/*
 * What keeps the window's class index (`classindex.ts`) in step with the
 * workspace - the decisions, `vscode`-free; `classindexfeed.ts` wires them to
 * the watcher, the document events and `workspace.fs`.
 *
 * What goes in is the SAVED state of the workspace's classes, the state CI
 * judges: the files on disk, plus the open documents that have no file behind
 * them (ADT), whose editor text is all there is. A keystroke changes nothing
 * here - the document being typed in is judged against the OTHER classes,
 * and those only change when they are saved.
 *
 * LAZY. Nothing is read until a check first asks for the index: the
 * extension activates on `workspaceContains:**\/*.clas.abap`, and reading and
 * indexing every class of a sample repository (644 classes, ~0.7 s of the
 * shared extension host) on startup is a price a window that never checks a
 * builder class must not pay. Until that first scan has finished the index
 * is `undefined` - exactly what the gate was given before the index existed -
 * and when it lands, `onChange` says so once, so what was checked without it
 * is checked again. A partial index is never handed out: judged against half
 * the workspace, a class could be told what CI silences.
 */

/** A class the scan found: its key (the uri as a string), its text, and
 *  whether it came from an open editor rather than from disk. */
export interface ScannedSource {
  key: string;
  text: string;
  fromEditor: boolean;
}

export interface ClassIndexSyncDeps {
  /** Every ABAP class the window can see (the workspace's files plus the
   *  open documents without one). Throws when the workspace cannot be read. */
  scan(): Promise<ScannedSource[]>;
  /** One file's text on disk; throws when it is gone. */
  read(key: string): Promise<string>;
  /** The content of the index moved - debounced, and only after the first
   *  scan. */
  onChange(): void;
  /** Gives the host a turn between slices of the initial scan. */
  yieldTurn?(): Promise<void>;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

/** Files indexed per slice of a scan - the extension host is shared, and one
 *  `classIndexOf` per file over a large workspace blocks it for a while. */
export const SCAN_SLICE = 50;

/** How long the index has to be quiet before `onChange` fires. */
export const NOTIFY_DEBOUNCE_MS = 300;

export class ClassIndexSync {
  /** The keys the last scan found on disk (whatever their scheme - on
   *  vscode.dev a workspace file is `vscode-vfs:`). An open document that is
   *  not among them is a class from a system, contributed by its editor. */
  private readonly onDisk = new Set<string>();
  private scanning: Promise<void> | undefined;
  private rescan = false;
  private started = false;
  private ready = false;
  private disposed = false;
  private notifyTimer: unknown;
  private lastGeneration: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly store: ClassIndexStore,
    private readonly deps: ClassIndexSyncDeps
  ) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.lastGeneration = store.generation;
  }

  /** False while the linter has no `classIndexOf` - then nothing is ever
   *  read, and every answer is "no index". */
  get enabled(): boolean {
    return this.store.enabled;
  }

  /** True once the first scan has finished. */
  get isReady(): boolean {
    return this.ready;
  }

  /** True once something asked for the index (and the first scan started). */
  get isStarted(): boolean {
    return this.started;
  }

  /**
   * The index for the gate: undefined while the linter takes none, and until
   * the first scan has finished - the call that finds it not started starts
   * it.
   */
  index(): ClassIndex | undefined {
    if (!this.demand()) {
      return undefined;
    }
    try {
      return this.store.index();
    } catch {
      return undefined; // the linter choked on a class: judged without, as before
    }
  }

  /** What a check of the file behind `key` reads out of the index - for a
   *  cache of findings to add to its stamp (`ClassIndexStore.depsOf`). "" in
   *  every state `index( )` answers undefined in. */
  stamp(key: string): string {
    if (!this.demand()) {
      return "";
    }
    try {
      return this.store.depsOf(this.store.nameOf(key));
    } catch {
      return "";
    }
  }

  /** A file was created, changed or deleted on disk (`key`), or - undefined -
   *  the workspace folders themselves changed. */
  fileChanged(key: string | undefined): Promise<void> {
    if (!this.started || this.disposed) {
      return Promise.resolve(); // the first scan reads it when it is asked for
    }
    return key === undefined ? this.fullScan() : this.readOne(key);
  }

  /** A document was saved: its text is the file's now. */
  saved(key: string, text: string): void {
    if (!this.started || this.disposed) {
      return;
    }
    this.put(key, text);
    this.settle();
  }

  /** A document was opened. A file the scan found is in already, from disk;
   *  anything else (a class from a system) is contributed by its editor. */
  opened(key: string, text: string): void {
    if (!this.started || this.disposed || this.onDisk.has(key)) {
      return;
    }
    this.put(key, text);
    this.settle();
  }

  /** A document was closed: a class only its editor contributed is gone. */
  closed(key: string): void {
    if (!this.started || this.disposed || this.onDisk.has(key)) {
      return;
    }
    this.store.delete(key);
    this.settle();
  }

  dispose(): void {
    this.disposed = true;
    this.rescan = false;
    if (this.notifyTimer !== undefined) {
      this.clearTimer(this.notifyTimer);
      this.notifyTimer = undefined;
    }
  }

  /** Starts the first scan when nothing has yet; true once it has finished. */
  private demand(): boolean {
    if (!this.store.enabled || this.disposed) {
      return false;
    }
    if (!this.started) {
      this.started = true;
      void this.fullScan();
    }
    return this.ready;
  }

  private fullScan(): Promise<void> {
    if (this.scanning) {
      this.rescan = true;
      return this.scanning;
    }
    const run = this.scanOnce().finally(() => {
      this.scanning = undefined;
      if (this.rescan && !this.disposed) {
        this.rescan = false;
        void this.fullScan();
      }
    });
    this.scanning = run;
    return run;
  }

  private async scanOnce(): Promise<void> {
    let sources: ScannedSource[];
    try {
      sources = await this.deps.scan();
    } catch {
      // a workspace that cannot be read keeps what it had - and the first
      // scan still counts as done, or every check would wait on it forever
      this.finishFirstScan();
      return;
    }
    const seen = new Set<string>();
    this.onDisk.clear();
    let n = 0;
    for (const source of sources) {
      if (this.disposed) {
        return;
      }
      seen.add(source.key);
      if (!source.fromEditor) {
        this.onDisk.add(source.key);
      }
      this.put(source.key, source.text);
      if (++n % SCAN_SLICE === 0) {
        await (this.deps.yieldTurn?.() ?? new Promise((r) => setTimeout(r, 0)));
      }
    }
    this.store.retain(seen);
    this.finishFirstScan();
    this.settle();
  }

  /** The first scan is in: from now on the index is handed out, and what
   *  was checked without it has to be checked again - said once, whether or
   *  not the content differs from the empty index the store started with. */
  private finishFirstScan(): void {
    if (this.ready || this.disposed) {
      return;
    }
    this.ready = true;
    this.lastGeneration = this.store.generation;
    this.deps.onChange();
  }

  /** One file's text into the store. A class the linter's builder throws
   *  over is left out rather than ending the scan (or, from an event
   *  handler, surfacing as an error nobody can act on). */
  private put(key: string, text: string): void {
    try {
      this.store.set(key, text);
    } catch {
      this.store.delete(key);
    }
  }

  private async readOne(key: string): Promise<void> {
    try {
      const text = await this.deps.read(key);
      if (this.disposed) {
        return;
      }
      this.store.set(key, text);
      this.onDisk.add(key);
    } catch {
      this.store.delete(key);
      this.onDisk.delete(key);
    }
    this.settle();
  }

  /** Debounced: fires `onChange` when the index's CONTENT moved since the
   *  last time it did. */
  private settle(): void {
    if (this.disposed) {
      return;
    }
    if (this.notifyTimer !== undefined) {
      this.clearTimer(this.notifyTimer);
    }
    this.notifyTimer = this.setTimer(() => {
      this.notifyTimer = undefined;
      if (this.disposed || !this.ready) {
        return;
      }
      const now = this.store.generation;
      if (now !== this.lastGeneration) {
        this.lastGeneration = now;
        this.deps.onChange();
      }
    }, NOTIFY_DEBOUNCE_MS);
  }
}
