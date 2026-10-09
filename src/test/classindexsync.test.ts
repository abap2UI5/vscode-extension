import { test } from "node:test";
import assert from "node:assert/strict";
import { ClassIndex, ClassIndexOf, ClassIndexStore } from "../classindex";
import { ClassIndexSync, NOTIFY_DEBOUNCE_MS, SCAN_SLICE, ScannedSource } from "../classindexsync";

/*
 * When the class index is read, and when the checks hear of it - the
 * `vscode`-free half of `classindexfeed.ts`. Timers and turns are injected,
 * so nothing here waits on the clock.
 */

/** A minimal classIndexOf: the facts of every `CLASS x DEFINITION`, no reads.
 *  What the sync does with an index is the subject, not the index itself
 *  (`classindex.test.ts` holds the store to the real builder). */
const factsOnly: ClassIndexOf = (sources) => {
  const index: ClassIndex = new Map();
  for (const source of sources) {
    const m = /\bCLASS\s+(\w+)\s+DEFINITION\b([^.]*)/i.exec(source);
    if (m && !index.has(m[1].toLowerCase())) {
      index.set(m[1].toLowerCase(), {
        superclass: /INHERITING\s+FROM\s+(\w+)/i.exec(m[2])?.[1].toLowerCase() ?? null,
        csEvent: /cs_event/i.test(source),
        outsideReads: new Set(),
      });
    }
  }
  return index;
};

const cls = (name: string, extra = "") => `CLASS ${name} DEFINITION ${extra}.\nENDCLASS.\n`;

/** A deferred value - the scan resolves when the test says so. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake clock: timers run when `flush( )` says so. */
function fakeTimers() {
  let next = 1;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers.delete(h as number);
    },
    pending: () => [...timers.values()],
    flush: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) {
        t.fn();
      }
    },
  };
}

/** Lets every queued microtask (and the yields) run. */
const settle = () => new Promise((r) => setImmediate(r));

function harness(
  files: Record<string, string>,
  opts: { indexOf?: ClassIndexOf | null; yieldTurn?: () => Promise<void> } = {}
) {
  const disk = new Map(Object.entries(files));
  const editors = new Map<string, string>();
  const clock = fakeTimers();
  let scans = 0;
  let gate: ReturnType<typeof deferred<void>> | undefined;
  let failScan = false;
  const changes: number[] = [];
  const store = new ClassIndexStore(opts.indexOf === undefined ? factsOnly : opts.indexOf);
  const sync = new ClassIndexSync(store, {
    scan: async () => {
      scans++;
      if (gate) {
        await gate.promise;
      }
      if (failScan) {
        throw new Error("no workspace");
      }
      const out: ScannedSource[] = [...disk].map(([key, text]) => ({ key, text, fromEditor: false }));
      for (const [key, text] of editors) {
        if (!disk.has(key)) {
          out.push({ key, text, fromEditor: true });
        }
      }
      return out;
    },
    read: async (key) => {
      const text = disk.get(key);
      if (text === undefined) {
        throw new Error("gone");
      }
      return text;
    },
    onChange: () => changes.push(changes.length + 1),
    yieldTurn: opts.yieldTurn ?? (() => Promise.resolve()),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return {
    sync,
    store,
    disk,
    editors,
    clock,
    changes,
    scans: () => scans,
    hold: () => {
      gate = deferred<void>();
      return gate;
    },
    failNextScan: () => {
      failScan = true;
    },
  };
}

const names = (index: ClassIndex | undefined) => (index ? [...index.keys()].sort() : undefined);

test("nothing is read until a check asks for the index", async () => {
  const h = harness({ "file:///a": cls("zcl_a") });
  // the events before the first demand change nothing and read nothing
  await h.sync.fileChanged("file:///a");
  h.sync.saved("file:///a", cls("zcl_a"));
  h.sync.opened("adt://b", cls("zcl_b"));
  await settle();
  assert.equal(h.scans(), 0);
  assert.equal(h.store.size, 0);
  assert.equal(h.sync.isStarted, false);
});

test("the index is undefined until the first scan is in, then handed out - with one change notice", async () => {
  const h = harness({ "file:///a": cls("zcl_a"), "file:///b": cls("zcl_b", "INHERITING FROM zcl_a") });
  const held = h.hold();
  assert.equal(h.sync.index(), undefined, "the first call starts the scan, it does not wait for it");
  assert.equal(h.sync.stamp("file:///b"), "");
  assert.equal(h.scans(), 1);
  // a partial index is never handed out while the scan is running
  assert.equal(h.sync.index(), undefined);
  assert.equal(h.scans(), 1, "a second demand does not start a second scan");
  held.resolve();
  await settle();
  assert.deepEqual(names(h.sync.index()), ["zcl_a", "zcl_b"]);
  assert.deepEqual(h.changes, [1], "the checks hear once that the index is there");
  assert.match(h.sync.stamp("file:///b"), /zcl_a/);
  h.clock.flush();
  assert.deepEqual(h.changes, [1], "no second notice for the same content");
});

test("a linter without classIndexOf: nothing is ever read, and every answer is 'no index'", async () => {
  const h = harness({ "file:///a": cls("zcl_a") }, { indexOf: null });
  assert.equal(h.sync.enabled, false);
  assert.equal(h.sync.index(), undefined);
  assert.equal(h.sync.stamp("file:///a"), "");
  await settle();
  assert.equal(h.scans(), 0);
  assert.deepEqual(h.changes, []);
});

test("a disk change re-reads that file, debounced into one notice when the content moved", async () => {
  const h = harness({ "file:///a": cls("zcl_a"), "file:///b": cls("zcl_b") });
  h.sync.index();
  await settle();
  h.clock.flush();
  h.changes.length = 0;

  h.disk.set("file:///b", cls("zcl_b", "INHERITING FROM zcl_a"));
  await h.sync.fileChanged("file:///b");
  h.disk.set("file:///c", cls("zcl_c"));
  await h.sync.fileChanged("file:///c");
  assert.equal(h.clock.pending().length, 1, "one debounce timer for the burst");
  assert.equal(h.clock.pending()[0].ms, NOTIFY_DEBOUNCE_MS);
  h.clock.flush();
  assert.deepEqual(h.changes, [1]);
  assert.equal(h.sync.index()?.get("zcl_b")?.superclass, "zcl_a");
  assert.deepEqual(names(h.sync.index()), ["zcl_a", "zcl_b", "zcl_c"]);

  // a file deleted on disk leaves the index
  h.disk.delete("file:///c");
  await h.sync.fileChanged("file:///c");
  h.clock.flush();
  assert.deepEqual(names(h.sync.index()), ["zcl_a", "zcl_b"]);
  assert.deepEqual(h.changes, [1, 2]);

  // the same text again moves nothing, so nobody is told
  await h.sync.fileChanged("file:///a");
  h.clock.flush();
  assert.deepEqual(h.changes, [1, 2]);
});

test("a save is the file's text; an open file stays the disk's, a system class is its editor's", async () => {
  const h = harness({ "file:///a": cls("zcl_a") });
  h.sync.index();
  await settle();

  // opening a workspace file contributes nothing - its text came from disk
  h.sync.opened("file:///a", cls("zcl_unsaved_rename"));
  assert.deepEqual(names(h.sync.index()), ["zcl_a"]);
  h.sync.closed("file:///a");
  assert.deepEqual(names(h.sync.index()), ["zcl_a"], "closing it does not drop it");

  // a save is what counts
  h.sync.saved("file:///a", cls("zcl_a", "INHERITING FROM zcl_base"));
  assert.equal(h.sync.index()?.get("zcl_a")?.superclass, "zcl_base");

  // an ADT document is in while it is open, and gone when it is closed
  h.sync.opened("adt://sys/zcl_remote", cls("zcl_remote"));
  assert.deepEqual(names(h.sync.index()), ["zcl_a", "zcl_remote"]);
  h.sync.closed("adt://sys/zcl_remote");
  assert.deepEqual(names(h.sync.index()), ["zcl_a"]);
});

test("a folder change rescans, and a rescan asked for during a scan runs once after it", async () => {
  const h = harness({ "file:///a": cls("zcl_a") });
  h.sync.index();
  await settle();
  assert.equal(h.scans(), 1);

  const held = h.hold();
  h.disk.delete("file:///a");
  h.disk.set("file:///z", cls("zcl_z"));
  const first = h.sync.fileChanged(undefined);
  void h.sync.fileChanged(undefined);
  void h.sync.fileChanged(undefined);
  assert.equal(h.scans(), 2);
  held.resolve();
  await first;
  await settle();
  await settle();
  assert.equal(h.scans(), 3, "the requests during the scan fold into one more");
  assert.deepEqual(names(h.sync.index()), ["zcl_z"], "what the rescan did not find is gone");
});

test("a workspace that cannot be read still ends the wait - with what it had", async () => {
  const h = harness({ "file:///a": cls("zcl_a") });
  h.failNextScan();
  assert.equal(h.sync.index(), undefined);
  await settle();
  assert.equal(h.sync.isReady, true, "the checks are not left waiting on a scan that failed");
  assert.deepEqual(names(h.sync.index()), []);
  assert.deepEqual(h.changes, [1]);
});

test("the scan yields between slices, and dispose stops it, its timer and later rescans", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < SCAN_SLICE * 3; i++) {
    files[`file:///c${i}`] = cls(`zcl_c${i}`);
  }
  let yields = 0;
  let resume: () => void = () => undefined;
  const h = harness(files, {
    yieldTurn: () => {
      yields++;
      return new Promise<void>((r) => {
        resume = r;
      });
    },
  });
  h.sync.index();
  while (yields === 0) {
    await settle();
  }
  assert.equal(h.store.size, SCAN_SLICE, "one slice, then the host gets a turn");
  h.sync.dispose();
  resume();
  await settle();
  assert.ok(h.store.size < SCAN_SLICE * 3, "a disposed scan stops at the next slice");
  assert.equal(h.sync.isReady, false);
  assert.deepEqual(h.changes, []);
  assert.equal(h.clock.pending().length, 0, "no timer outlives dispose");
  await h.sync.fileChanged(undefined);
  h.sync.saved("file:///c0", cls("zcl_other"));
  assert.equal(h.scans(), 1);
  assert.equal(h.sync.index(), undefined);
});
