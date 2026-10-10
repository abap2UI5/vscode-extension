/*
 * The cross-file class index the linter's class-level rules read - kept
 * incrementally for an editor that sees one class change at a time.
 *
 * The linter judges some rules against the OTHER classes of a run:
 * `frontend-action-as-backend-event` walks the superclass chain (a class that
 * inherits a `cs_event` constant is not naming the client's), and the
 * public-attribute rules read which attributes another class reaches through
 * a typed reference (`outsideReads` - a caller taking a popup's `ms_result`
 * back). `checkFiles( )` builds that index over the files it is handed, so CI
 * judges every class with it; the editor checks one document at a time and
 * passed none, so it reported what CI silences.
 *
 * The index comes from the linter's own `classIndexOf( sources )` - never a
 * second reading of ABAP here. What this module adds is incrementality.
 * `classIndexOf` is all-or-nothing, and over a workspace the size of the
 * sample repositories (~1000 classes, 16 MB) one build costs a quarter of a
 * second - per save, that is not a price an editor pays. So the index is
 * assembled from per-file contributions, each computed by `classIndexOf`
 * itself:
 *
 *   - a file's FACTS (its class, superclass, whether it declares a
 *     `cs_event`) are `classIndexOf([ text ])` - the file alone;
 *   - a file's READS of the other classes are `classIndexOf([ text, ...stubs
 *     ])`, one `CLASS x DEFINITION.` stub per known class the file names.
 *     The reads `classIndexOf` records are filtered by the classes it knows,
 *     and every class a read can be attributed to is spelt out in the file
 *     (`TYPE REF TO x`, `CAST x(`, `NEW x(`, `x=>`) - so the stubs for the
 *     known names among the file's words are exactly the classes the full
 *     build would have attributed its reads to.
 *
 * A changed file recomputes its own two contributions; the merge is a pass
 * over the per-file results. Only a change to the SET of known classes (a
 * class added, removed or renamed) re-reads other files - those that name
 * one of the classes that came or went. `classindex.test.ts` pins the
 * assembled index to a full `classIndexOf` over the same sources.
 *
 * The pinned linter may not export `classIndexOf` at all (0.8.5 does not):
 * then the store is disabled, nothing is computed, and the gate passes no
 * index - exactly what it did before.
 */

import * as abapRules from "@abap2ui5/linter/abap-rules";
import { linterExport } from "./gate";

/** One class's entry - the shape `classIndexOf` returns. */
export interface ClassFacts {
  superclass: string | null;
  csEvent: boolean;
  outsideReads: Set<string>;
}

/** Class name (lower case) -> its facts. */
export type ClassIndex = Map<string, ClassFacts>;

export type ClassIndexOf = (sources: string[]) => ClassIndex;

/** The linter's builder, or undefined on a release that has none. */
export const LINTER_CLASS_INDEX_OF = linterExport<ClassIndexOf>(abapRules, "classIndexOf");

/** The words of a source a class name can be - the same character class the
 *  linter reads class names with (`[\w/]+`), lower-cased as it folds them. */
function wordsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w/]+/g)) {
    out.add(m[0].toLowerCase());
  }
  return out;
}

/*
 * What is kept per file. The TEXT is needed again only by `readsOf`, and
 * only for a file that reads something through a reference (`->`): every
 * other file's contribution is its facts, computed once. So the text and
 * the word set stay only for the `->` files - the others keep a content hash
 * (`hashOf`), which is all `set` needs to tell an unchanged file from an
 * edited one. Over samples-controls that is ~16 MB of source the store no
 * longer holds for the session.
 */
interface Entry {
  /** The source, for a file that reads through a reference; undefined for
   *  one that does not (nothing re-reads it). */
  text: string | undefined;
  /** `hashOf(text)` - how `set` recognises an unchanged file. */
  hash: string;
  /** The class the file defines (lower case), or null. */
  name: string | null;
  facts: { superclass: string | null; csEvent: boolean } | null;
  /** The words a class name can be - only for a file with `text`. */
  words: Set<string> | undefined;
  /** Class -> attribute names this file reads of it; null when stale. */
  reads: Map<string, Set<string>> | null;
  /** The known classes `reads` was computed against (sorted, joined). */
  readsAgainst: string;
}

/** Whether a file reads anything through a reference - the one case
 *  `readsOf` needs its text again. */
function readsThroughReference(text: string): boolean {
  return text.includes("->");
}

/** Two FNV-1a 32-bit hashes (different offset bases) plus the length - 64
 *  bits of content identity, cheap over megabytes. */
export function hashOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
  }
  return `${text.length}:${a.toString(16)}:${b.toString(16)}`;
}

export class ClassIndexStore {
  private readonly entries = new Map<string, Entry>();
  private merged: ClassIndex | undefined;
  private dirty = true;
  /** The known class names the last merge saw. */
  private known = new Set<string>();
  private generationValue = 0;
  private signature = "";

  private readonly indexOf: ClassIndexOf | null;

  /** `null` is "no builder" - the store keeps nothing (an omitted argument
   *  is the linter's own, which may be absent too). */
  constructor(indexOf: ClassIndexOf | null = LINTER_CLASS_INDEX_OF ?? null) {
    this.indexOf = indexOf;
  }

  /** False when the linter has no `classIndexOf` - nothing is kept then. */
  get enabled(): boolean {
    return this.indexOf !== null;
  }

  /** Bumped whenever the assembled index changed in content - what a memo of
   *  findings computed with it has to be keyed on. */
  get generation(): number {
    this.index();
    return this.generationValue;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** A file's current text. A text equal to the one held changes nothing. */
  set(key: string, text: string): void {
    if (!this.indexOf) {
      return;
    }
    const previous = this.entries.get(key);
    const hash = hashOf(text);
    if (previous && (previous.text !== undefined ? previous.text === text : previous.hash === hash)) {
      return;
    }
    const own = this.indexOf([text]);
    const first = own.entries().next();
    const [name, facts] = first.done ? [null, null] : first.value;
    const keepText = readsThroughReference(text);
    this.entries.set(key, {
      text: keepText ? text : undefined,
      hash,
      name,
      facts: facts ? { superclass: facts.superclass ?? null, csEvent: Boolean(facts.csEvent) } : null,
      words: keepText ? wordsOf(text) : undefined,
      reads: null,
      readsAgainst: "",
    });
    this.dirty = true;
  }

  delete(key: string): void {
    if (this.entries.delete(key)) {
      this.dirty = true;
    }
  }

  /** Drops every file not in `keys` - what a full rescan learned is gone. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of [...this.entries.keys()]) {
      if (!keys.has(key)) {
        this.delete(key);
      }
    }
  }

  /**
   * The assembled index, or undefined when the linter has none to offer.
   * Recomputed only after a change, and then only for the files the change
   * concerns.
   */
  index(): ClassIndex | undefined {
    if (!this.indexOf) {
      return undefined;
    }
    if (!this.dirty && this.merged) {
      return this.merged;
    }
    // facts first: the first file to define a name wins, as in classIndexOf
    const facts = new Map<string, { superclass: string | null; csEvent: boolean }>();
    for (const entry of this.entries.values()) {
      if (entry.name !== null && entry.facts && !facts.has(entry.name)) {
        facts.set(entry.name, entry.facts);
      }
    }
    const known = new Set(facts.keys());
    const sameKnown = known.size === this.known.size && [...known].every((n) => this.known.has(n));
    this.known = known;
    const merged: ClassIndex = new Map();
    for (const [name, f] of facts) {
      merged.set(name, { superclass: f.superclass, csEvent: f.csEvent, outsideReads: new Set() });
    }
    for (const entry of this.entries.values()) {
      if (entry.text === undefined || entry.words === undefined) {
        continue; // reads nothing through a reference
      }
      if (entry.reads === null || !sameKnown) {
        const against = [...entry.words].filter((w) => known.has(w) && w !== entry.name).sort();
        const key = against.join(" ");
        if (entry.reads === null || key !== entry.readsAgainst) {
          entry.reads = this.readsOf(entry.text, against);
          entry.readsAgainst = key;
        }
      }
      for (const [cls, names] of entry.reads ?? []) {
        const target = merged.get(cls);
        if (target) {
          for (const n of names) {
            target.outsideReads.add(n);
          }
        }
      }
    }
    this.merged = merged;
    this.dirty = false;
    const signature = signatureOf(merged);
    if (signature !== this.signature) {
      this.signature = signature;
      this.generationValue++;
    }
    return merged;
  }

  /**
   * What a check of the class `name` reads out of the index, as a string: the
   * names other classes read of it and its superclass chain as far as the
   * index knows it. Two checks with the same string judge the class the same
   * way - the key a cache of findings computed with the index adds to its
   * stamp, so editing a superclass re-judges exactly its subclasses.
   */
  depsOf(name: string | null | undefined): string {
    const index = this.index();
    if (!index || !name) {
      return "";
    }
    const own = name.toLowerCase();
    const chain: unknown[] = [[...(index.get(own)?.outsideReads ?? [])].sort()];
    const seen = new Set<string>();
    for (let cls = index.get(own)?.superclass; cls && cls !== "object" && !seen.has(cls); ) {
      seen.add(cls);
      const f = index.get(cls);
      chain.push(f ? [cls, f.superclass, f.csEvent] : [cls]);
      if (!f) {
        break;
      }
      cls = f.superclass;
    }
    return JSON.stringify(chain);
  }

  /** The class a held file defines (lower case), if any. */
  nameOf(key: string): string | null {
    return this.entries.get(key)?.name ?? null;
  }

  /** How much source text the store holds - the `->` files' only. */
  get retainedTextLength(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      n += entry.text?.length ?? 0;
    }
    return n;
  }

  private readsOf(text: string, against: string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (!this.indexOf || !against.length) {
      return out;
    }
    const stubs = against.map((name) => `CLASS ${name} DEFINITION.\nENDCLASS.\n`);
    const index = this.indexOf([text, ...stubs]);
    for (const name of against) {
      const reads = index.get(name)?.outsideReads;
      if (reads?.size) {
        out.set(name, new Set(reads));
      }
    }
    return out;
  }
}

/** A stable string of an index's content - what decides whether it changed. */
function signatureOf(index: ClassIndex): string {
  const rows: string[] = [];
  for (const [name, f] of index) {
    rows.push(`${name}|${f.superclass ?? ""}|${f.csEvent ? 1 : 0}|${[...f.outsideReads].sort().join(",")}`);
  }
  return rows.sort().join("\n");
}
