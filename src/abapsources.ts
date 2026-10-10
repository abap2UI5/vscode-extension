import * as vscode from "vscode";
import { isAbapSourceDocument } from "./abap";
import { sourceLabel } from "./checkcore";
import { SharedScan, mapInPool } from "./sharedscan";

/*
 * "Which ABAP does this window know about?" - the one answer four features
 * used to give differently.
 *
 * The apps tree, the navigation map, the workspace sweep and the method
 * index all reached for `workspace.findFiles`, which sees exactly one kind of
 * source: files in an open folder. That is the whole picture when a
 * repository is checked out, and it is EMPTY for the other way abap2UI5 is
 * worked on - straight against the system through ADT, where a class is a
 * virtual document with a scheme of its own (`adt:`, `abapfs:`, …), no path
 * on disk, and often no workspace folder at all.
 *
 * Nothing about those features needs a path. They need the source text and
 * something to open afterwards, and an open editor supplies both. So this
 * module answers with both kinds at once: the files of the workspace, plus
 * every ABAP document the window currently has open, whatever its scheme.
 *
 * What that cannot be is a complete inventory of a system: ADT has no glob,
 * so the classes it contributes are the ones somebody opened. That is a
 * smaller promise than the file case makes, and the callers say so in their
 * own words rather than pretending the list is exhaustive.
 */

/** A class this window can read, wherever it came from. */
export interface AbapSource {
  uri: vscode.Uri;
  text: string;
  /** True when it came from an open editor rather than from disk - the
   *  callers that want to say "of the ones you have open" ask this. */
  fromEditor: boolean;
}

const ABAP_SOURCE_GLOB = "**/*.clas.abap";
const EXCLUDE = "**/{node_modules,.git,dist,out}/**";

/** One decoder for every read - the sweep runs per picker keystroke over up
 *  to `limit` files, and a fresh TextDecoder per file was pure overhead. */
const DECODER = new TextDecoder();

/** Whether a document is ABAP source this window should know about - the
 *  decision lives `vscode`-free in `abap.ts`: language id first (an ADT
 *  document's path may carry no extension worth testing), and never for a
 *  scheme that only shows a COPY of a class, such as the revision side of a
 *  `git:` diff - that one used to enter the scan as a second class of the
 *  same name. */
export function isAbapDocument(doc: vscode.TextDocument): boolean {
  return isAbapSourceDocument({
    languageId: doc.languageId,
    scheme: doc.uri.scheme,
    path: doc.uri.path,
  });
}

// ---------------------------------------------------------------------------
// The shared cache: read a class from disk once, not once per consumer
// ---------------------------------------------------------------------------

/*
 * Four features sweep the window's ABAP: the apps tree, the app-class index,
 * the navigation map and the workspace symbol search. Each of them used to
 * read every file of the workspace from disk on every refresh - and the apps
 * tree refreshes on every watcher event AND on every ABAP document open,
 * INCLUDING the `openTextDocument` a click on one of its own items performs.
 * Using the tree rescanned the tree.
 *
 * So the texts are kept, keyed by uri, and dropped again when the file they
 * came from changes. What invalidates them is one shared FileSystemWatcher
 * over the same glob the sweep uses (`watchAbapSources`), so a `git pull` or
 * a branch switch costs a re-read of exactly the files it touched.
 *
 * Two deliberate limits:
 *
 *   - the GLOB still runs every sweep. It is one native call that hands back
 *     uris; the per-file `readFile` + decode was the cost worth removing, and
 *     re-globbing keeps a file the watcher never told us about from being
 *     invisible forever.
 *   - an entry is not trusted beyond `CACHE_TTL_MS` on the watcher's word
 *     alone. A FileSystemWatcher can miss a change (`files.watcherExclude`,
 *     a network share), and an extension that then shows a stale class
 *     until the window is reloaded would be worse than the sweep it
 *     replaced. The bursts this exists for - a debounced refresh, a picker
 *     being typed into - all happen inside that window. Past it the entry is
 *     VALIDATED rather than re-read: a `stat`, and the text is kept when the
 *     file's mtime and size are what they were (it used to be re-read and
 *     decoded whole - every file of the workspace, on the first sweep after
 *     half a minute of quiet, which the apps tree ran per save).
 *   - and the cache is a working set, not a session-long copy of the
 *     workspace: `CACHE_IDLE_MS` after the last sweep it is dropped whole
 *     (`scheduleIdleEviction`). The consumers that read through it - the
 *     app-class index's rebuild, the class index's first scan, the
 *     navigation map, the symbol search - all run rarely once a window is
 *     up; what they left behind was every class's text, retained for as
 *     long as the window lived.
 */

/** How long a cached text is trusted on the watcher's word alone - past it
 *  the next read validates the entry with a stat. */
const CACHE_TTL_MS = 30000;

/** How long after the last sweep the cache is dropped whole. */
const CACHE_IDLE_MS = 5 * 60 * 1000;

/** How many file reads the cold scan keeps in flight at once. */
const READ_POOL_WIDTH = 12;

/** Above this many remembered files the cache is dropped whole rather than
 *  grown - it is a working set, not an index. */
const CACHE_MAX_FILES = 4000;

/** `at`: when the text was last read or validated. `stamp`: the file's
 *  mtime and size at the stat that validated it, once one has - the first
 *  read records none (one round trip per file on the cold sweep, not two),
 *  so the first validation stats AND reads, every later one only stats. */
const fileCache = new Map<string, { at: number; text: string; stamp?: string }>();
let idleEviction: NodeJS.Timeout | undefined;

/** Arms (or re-arms) the drop of the whole cache `CACHE_IDLE_MS` after the
 *  sweep that just ran - a sweep in flight by then keeps it. */
function scheduleIdleEviction(): void {
  if (idleEviction) {
    clearTimeout(idleEviction);
  }
  idleEviction = setTimeout(() => {
    idleEviction = undefined;
    if (sweepsInFlight === 0) {
      fileCache.clear();
    }
  }, CACHE_IDLE_MS);
  idleEviction.unref?.();
}
let sweepsInFlight = 0;
/** Bumped by every invalidation. A read that was in flight while one landed
 *  may hold the text from BEFORE the change - stored, it was trusted for the
 *  whole TTL, and the rescan the same change scheduled read it back. */
let invalidations = 0;

/** Called by the shared watcher: this file's text is no longer what we read. */
function forgetFile(uri: vscode.Uri): void {
  invalidations++;
  fileCache.delete(uri.toString());
}

/** Everything is suspect - a folder came or went. */
function forgetAllFiles(): void {
  invalidations++;
  fileCache.clear();
}

let watching = false;

/**
 * Starts the ONE FileSystemWatcher over the window's ABAP files.
 *
 * Idempotent: every consumer that wants fresh answers calls it, and the first
 * call is the one that creates the watcher (and registers its disposal on that
 * caller's context). Consumers hang their own refresh off
 * {@link onDidChangeAbapSources} rather than opening a watcher each.
 */
export function watchAbapSources(context: vscode.ExtensionContext): void {
  if (watching) {
    return;
  }
  watching = true;
  const watcher = vscode.workspace.createFileSystemWatcher(ABAP_SOURCE_GLOB);
  const changed = (uri: vscode.Uri) => {
    forgetFile(uri);
    for (const listener of listeners) {
      listener(uri);
    }
  };
  context.subscriptions.push(
    watcher,
    new vscode.Disposable(() => {
      watching = false;
      listeners.clear();
      forgetAllFiles();
      if (idleEviction) {
        clearTimeout(idleEviction);
        idleEviction = undefined;
      }
    }),
    watcher.onDidCreate(changed),
    // content changes from outside the editor too - a git pull can turn an
    // existing, unopened class into an app without any create or save event
    watcher.onDidChange(changed),
    watcher.onDidDelete(changed),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      forgetAllFiles();
      for (const listener of listeners) {
        listener(undefined);
      }
    })
  );
}

type SourceListener = (uri: vscode.Uri | undefined) => void;
const listeners = new Set<SourceListener>();

/**
 * Fires when a file behind {@link abapSources} was created, changed or
 * deleted on disk - with the uri, or undefined when the workspace folders
 * themselves changed. The cache entry is already dropped when a listener
 * runs.
 */
export function onDidChangeAbapSources(
  listener: SourceListener
): vscode.Disposable {
  listeners.add(listener);
  return new vscode.Disposable(() => listeners.delete(listener));
}

/** Drops a file's remembered text - what a save of an open document means for
 *  the copy on disk. */
export function invalidateAbapSource(uri: vscode.Uri): void {
  forgetFile(uri);
}

/** The file's mtime and size as one comparable string. */
function stampOf(stat: vscode.FileStat): string {
  return `${stat.mtime}:${stat.size}`;
}

/** One file's text, from the cache when it is still fresh - or validated by
 *  a stat when it is past the TTL and the file has not moved. */
async function readFile(uri: vscode.Uri, now: number): Promise<string | undefined> {
  const key = uri.toString();
  const cached = fileCache.get(key);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.text;
  }
  const before = invalidations;
  let stamp: string | undefined;
  if (cached) {
    try {
      // stat BEFORE the read: a change landing between the two makes the
      // next validation differ and re-read, never the other way round
      stamp = stampOf(await vscode.workspace.fs.stat(uri));
    } catch {
      fileCache.delete(key);
      return undefined; // gone
    }
    if (cached.stamp !== undefined && cached.stamp === stamp && before === invalidations) {
      cached.at = now;
      return cached.text;
    }
  }
  try {
    const text = DECODER.decode(await vscode.workspace.fs.readFile(uri));
    if (before !== invalidations) {
      return text; // possibly older than the change - answer, do not keep
    }
    if (fileCache.size >= CACHE_MAX_FILES) {
      fileCache.clear();
    }
    fileCache.set(key, { at: now, text, stamp });
    return text;
  } catch {
    // deleted between the glob and the read, or unreadable - not our
    // business to report, the next sweep will not find it either
    fileCache.delete(key);
    return undefined;
  }
}

/** One file's text on disk, through the shared cache - what a consumer that
 *  updates one entry on a watcher event reads with. Undefined when the file
 *  is gone or unreadable. */
export function readAbapSource(uri: vscode.Uri): Promise<string | undefined> {
  return readFile(uri, Date.now());
}

/** What one sweep found - see {@link scanAbapSources}. */
export interface AbapSourceScan {
  sources: AbapSource[];
  /**
   * True when the FILE glob came back with as many files as it was allowed to
   * return, so there may be classes beyond it.
   *
   * Deliberately about the glob alone: the open documents are added on top of
   * the cap, and counting them against it made 490 files plus 15 open ADT
   * documents report "cap reached" over a workspace that was scanned whole.
   */
  cappedFiles: boolean;
}

/**
 * Every ABAP source the window can see: the workspace's files, then the open
 * documents that are not among them. Reading the open ones costs nothing -
 * they are already in memory - and it is what makes the ADT case work at all.
 *
 * A file that is ALSO open keeps the text on disk, as it always has: the
 * consumers of this list act on saved classes, and the `fromEditor` flag says
 * which entries have no file behind them at all.
 */
async function scanOnce(
  limit: number,
  token: vscode.CancellationToken | undefined
): Promise<AbapSourceScan> {
  const seen = new Set<string>();
  const out: AbapSource[] = [];
  const now = Date.now();
  sweepsInFlight++;
  try {
    return await sweep(seen, out, now, limit, token);
  } finally {
    sweepsInFlight--;
    scheduleIdleEviction();
  }
}

async function sweep(
  seen: Set<string>,
  out: AbapSource[],
  now: number,
  limit: number,
  token: vscode.CancellationToken | undefined
): Promise<AbapSourceScan> {
  const files = await vscode.workspace.findFiles(ABAP_SOURCE_GLOB, EXCLUDE, limit);
  // The reads go out `READ_POOL_WIDTH` at a time: each is a round trip to
  // the file service, and one after the other left 644 classes as 644
  // serial round trips. The answer keeps the glob's order regardless of
  // which read lands first (the index and the tree are built from it).
  const read = await mapInPool(
    files,
    READ_POOL_WIDTH,
    async (uri) => {
      const text = await readFile(uri, now);
      return text === undefined ? undefined : { uri, text, fromEditor: false };
    },
    () => token?.isCancellationRequested === true
  );
  for (const source of read) {
    const key = source.uri.toString();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(source);
  }
  // a file the glob no longer finds (deleted, now excluded) has no business
  // in the cache - an uncapped sweep saw the whole workspace
  if (!token && files.length < limit) {
    for (const key of [...fileCache.keys()]) {
      if (!seen.has(key)) {
        fileCache.delete(key);
      }
    }
  }

  for (const doc of vscode.workspace.textDocuments) {
    const key = doc.uri.toString();
    if (seen.has(key) || !isAbapDocument(doc)) {
      continue;
    }
    seen.add(key);
    out.push({ uri: doc.uri, text: doc.getText(), fromEditor: true });
  }

  return { sources: out, cappedFiles: files.length >= limit };
}

/** The scan in flight that a token-less caller joins - see
 *  {@link scanAbapSources}. */
const shared = new SharedScan<AbapSourceScan>();

/**
 * {@link scanOnce}, shared: a caller that asks while a scan with the same cap
 * is running - and no file changed since it started - gets that scan's answer
 * instead of starting its own (`sharedscan.ts`).
 *
 * The text cache above spares a SECOND scan the reads, not a concurrent one:
 * at activation the app-class index starts its scan, a class open in the
 * editor is checked and starts the class index's, and the apps tree asks
 * for its first children - three cold scans of the same files at once,
 * each reading every one of them because none had landed in the cache yet.
 * Measured over samples-controls' 644 classes with a stand-in host (real
 * disk, `findFiles`/`readFile` mocked): three concurrent cold scans took
 * 3 globs and 1914 reads in ~535 ms (median of 7), joined 1 glob and 644
 * reads in ~235 ms; a lone scan is unchanged (~155 ms). In VS Code each read
 * is a round trip to the file service, so the saving there is larger.
 *
 * Only a token-less caller joins or is joined - a cancellation must not end
 * somebody else's scan - and each caller gets its own copy of the list.
 */
export function scanAbapSources(
  limit = 2000,
  token?: vscode.CancellationToken
): Promise<AbapSourceScan> {
  if (token) {
    return scanOnce(limit, token);
  }
  return shared
    .run(String(limit), invalidations, () => scanOnce(limit, undefined))
    .then((scan) => ({ ...scan, sources: [...scan.sources] }));
}

/** The sources alone - what every caller but the navigation map needs. */
export async function abapSources(
  limit = 2000,
  token?: vscode.CancellationToken
): Promise<AbapSource[]> {
  return (await scanAbapSources(limit, token)).sources;
}

/** True when the workspace has no folder to glob - then everything on offer
 *  came from open editors, and a list saying "none found" would be a lie
 *  about the system rather than about the workspace. */
export function noWorkspaceFolders(): boolean {
  return !vscode.workspace.workspaceFolders?.length;
}

/** How a source is named in a list - see `sourceLabel`, which is where the
 *  decision lives so the test suite can reach it. */
export function labelOf(uri: vscode.Uri, className?: string): string {
  return sourceLabel(uri.path, className) || uri.toString();
}
