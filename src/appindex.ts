import type { AppClassInfo } from "./abap";

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
export class AppClassIndex {
  private byName = new Map<string, AppClassInfo>();
  /** Document key -> the upper-cased class name it last contributed. */
  private contributed = new Map<string, string>();

  /** Wholesale rebuild: the fresh name map, plus which open document
   *  contributed which name - so a later in-place update still knows what
   *  each document owns. Stale names vanish here by construction. */
  replace(
    byName: Map<string, AppClassInfo>,
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
  update(docKey: string, name: string, info: AppClassInfo): string | undefined {
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
  restore(name: string, info: AppClassInfo): void {
    this.byName.set(name, info);
  }

  /** A closed document no longer contributes; its entry stays until the
   *  rebuild the caller schedules (a file on disk is picked up again). */
  forget(docKey: string): void {
    this.contributed.delete(docKey);
  }

  get(name: string): AppClassInfo | undefined {
    return this.byName.get(name);
  }
}
