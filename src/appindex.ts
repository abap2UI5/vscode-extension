import { AppClassInfo, appClassInfoOf, classNameOf, usesBuilder } from "./abap";

/*
 * The app-class index's bookkeeping, `vscode`-free so the rename handling is
 * testable (appclasses.ts wires it to the editor's events).
 *
 * The one interesting decision in here is what a RENAME drops. A document
 * that used to define ZCL_OLD and now defines ZCL_NEW must take the old
 * entry with it, or `isAppSource` keeps following `INHERITING FROM` to a
 * base class the window no longer has. The first implementation keyed that
 * on object identity against the per-version parse memo
 * (`index.get(previousName) === previousInfo`) - and that memo is refreshed
 * as a SIDE EFFECT by every lookup and every background rebuild, so a
 * rebuild landing between the rename keystroke and the save (the disk scan
 * still yields the old name; the open-documents pass already records the
 * new one) left the identity mismatched and the stale name in place. For a
 * file-backed class the save's watcher event heals that on the next
 * rebuild; a class with no file behind it (ADT) kept answering for the old
 * name indefinitely.
 *
 * So the contribution is tracked here, by document key: which name each
 * document last put into the index. That record moves only when the
 * document's contribution moves - never as a side effect of a lookup - and
 * a rename deletes exactly the name this document owned, whatever object a
 * rebuild has since stored under it. If something ELSE also defines the old
 * name (a file on disk not yet rescanned), the entry is gone until the next
 * rebuild re-adds it - "not an app" for a moment, which is the index's
 * documented safe answer, where the stale entry was a wrong one.
 */
/**
 * What the index remembers per class beyond the two walk answers: what the
 * apps tree shows. The tree used to re-read and re-parse every class of the
 * workspace on every save, open and close to find out which are apps - the
 * index already knew, and a save already updated its one entry in place.
 */
export interface AppClassEntry extends AppClassInfo {
  /** Upper-cased class name, as `classNameOf` reads it. */
  name: string;
  /** The document's uri, as a string. */
  key: string;
  /** Builds views of its own (previewable without a system). */
  usesBuilder: boolean;
  /** Came from an open editor with no file behind it (ADT). */
  fromEditor: boolean;
}

/**
 * Whether two entries say the same about a class - everything the walk and
 * the apps tree read. A save or an open of an ABAP document updates its
 * entry in place, and the index used to announce a change for every one of
 * them: the tree then dropped its list and re-rendered whole for a save that
 * changed nothing it shows (the usual save). Only an entry that differs
 * here is worth telling the tree about.
 */
export function sameAppClassEntry(
  a: AppClassEntry | undefined,
  b: AppClassEntry | undefined
): boolean {
  if (!a || !b) {
    return a === b;
  }
  return (
    a.name === b.name &&
    a.key === b.key &&
    a.isApp === b.isApp &&
    a.superclass === b.superclass &&
    a.usesBuilder === b.usesBuilder &&
    a.fromEditor === b.fromEditor
  );
}

/** A class the scan found, as `abapsources.ts` lists them. */
export interface AppSource {
  key: string;
  path: string;
  text: string;
  fromEditor: boolean;
}

export function appClassEntryOf(source: AppSource): AppClassEntry {
  return {
    ...appClassInfoOf(source.text),
    name: classNameOf(source.text, source.path),
    key: source.key,
    usesBuilder: usesBuilder(source.text),
    fromEditor: source.fromEditor,
  };
}

/** Classes parsed per slice of a rebuild before the host gets a turn - the
 *  extension host is shared, and 644 classes parsed in one synchronous loop
 *  (at activation, and after every watcher burst) held it for a while. */
export const BUILD_SLICE = 50;

/**
 * The name map of a rebuild, parsed in slices of `BUILD_SLICE` with a yield
 * between them. `superseded` is asked at every slice boundary: a newer
 * rebuild asked for meanwhile wins, and this one answers undefined without
 * finishing - the caller starts the newer one, which reads what changed.
 * Later sources win over earlier ones under the same name (the caller puts
 * the open documents last, so the buffer being edited beats the disk).
 */
export async function buildAppIndex(
  sources: readonly AppSource[],
  opts: {
    superseded?: () => boolean;
    yieldTurn?: () => Promise<void>;
    slice?: number;
  } = {}
): Promise<Map<string, AppClassEntry> | undefined> {
  const slice = opts.slice ?? BUILD_SLICE;
  const next = new Map<string, AppClassEntry>();
  let n = 0;
  for (const source of sources) {
    const entry = appClassEntryOf(source);
    next.set(entry.name, entry);
    if (++n % slice === 0) {
      await (opts.yieldTurn?.() ?? new Promise<void>((r) => setTimeout(r, 0)));
      if (opts.superseded?.()) {
        return undefined;
      }
    }
  }
  return opts.superseded?.() ? undefined : next;
}

/**
 * Whether an indexed class is an app: it writes the interface, or a class
 * up its `INHERITING FROM` chain does - `isAppInfoDeep`'s walk over
 * entries instead of a source text, with the same guards (an unknown parent
 * is "not an app", a cycle terminates).
 */
export function isAppEntry(
  entry: AppClassInfo,
  infoOf: (className: string) => AppClassInfo | undefined,
  maxDepth = 16
): boolean {
  if (entry.isApp) {
    return true;
  }
  let parent = entry.superclass;
  const seen = new Set<string>();
  for (let depth = 0; depth < maxDepth && parent !== undefined; depth++) {
    if (seen.has(parent)) {
      return false;
    }
    seen.add(parent);
    const info = infoOf(parent);
    if (!info) {
      return false;
    }
    if (info.isApp) {
      return true;
    }
    parent = info.superclass;
  }
  return false;
}

export class AppClassIndex<T extends AppClassInfo = AppClassInfo> {
  private byName = new Map<string, T>();
  /** Document key -> the upper-cased class name it last contributed. */
  private contributed = new Map<string, string>();

  /** Wholesale rebuild: the fresh name map, plus which open document
   *  contributed which name - so a later in-place update still knows what
   *  each document owns. Stale names vanish here by construction. */
  replace(
    byName: Map<string, T>,
    contributed: Map<string, string>
  ): void {
    this.byName = byName;
    this.contributed = contributed;
  }

  /**
   * One document's entry, updated in place (a save or an open). Returns the
   * name the document contributed BEFORE when this update renamed it away -
   * already deleted from the index; the caller may know of another owner to
   * restore (`restore`).
   */
  update(docKey: string, name: string, info: T): string | undefined {
    const previous = this.contributed.get(docKey);
    const renamed = previous !== undefined && previous !== name;
    if (renamed) {
      this.byName.delete(previous);
    }
    this.byName.set(name, info);
    this.contributed.set(docKey, name);
    return renamed ? previous : undefined;
  }

  /** Re-adds an entry a rename deleted, for a caller that knows another open
   *  document still defines that name - without recording a contribution,
   *  which stays the other document's own. */
  restore(name: string, info: T): void {
    this.byName.set(name, info);
  }

  /** A closed document no longer contributes; its entry stays until the
   *  rebuild the caller schedules (a file on disk is picked up again). */
  forget(docKey: string): void {
    this.contributed.delete(docKey);
  }

  /**
   * A file gone from disk: its contribution AND its entry go, when the entry
   * under that name is this file's (`keyOf`) - another file defining the
   * same name keeps its answer. Returns the name dropped.
   */
  remove(docKey: string, keyOf: (entry: T) => string | undefined): string | undefined {
    const name = this.contributed.get(docKey);
    this.contributed.delete(docKey);
    if (name === undefined) {
      return undefined;
    }
    const entry = this.byName.get(name);
    if (entry && keyOf(entry) === docKey) {
      this.byName.delete(name);
      return name;
    }
    return undefined;
  }

  get(name: string): T | undefined {
    return this.byName.get(name);
  }

  /** Every entry, in no particular order. */
  entries(): IterableIterator<T> {
    return this.byName.values();
  }

  get size(): number {
    return this.byName.size;
  }
}
