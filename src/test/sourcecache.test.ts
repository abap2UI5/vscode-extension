import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceTextCache } from "../sourcecache";

/*
 * The shared text cache's two clocks (sourcecache.ts, behind abapsources.ts)
 * against a fake file system: the TTL past which an entry is validated by a
 * stat, and the idle time after which the cache is dropped. The regression
 * pinned here: a cold read recorded no stamp, so the first validation past
 * the TTL stat AND re-read every file - and the idle eviction usually came
 * before a second validation, so the stat path never paid off.
 */

function fakeFs(files: Record<string, string>) {
  const disk = new Map(Object.entries(files).map(([k, v]) => [k, { text: v, mtime: 1000 }]));
  const stats: string[] = [];
  const reads: string[] = [];
  /** Calls in flight per file - to see a stat and a read overlap. */
  const inFlight = new Map<string, number>();
  let overlapped = 0;
  const track = async <T>(key: string, log: string[], answer: () => T): Promise<T> => {
    log.push(key);
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    if ((inFlight.get(key) ?? 0) > 1) {
      overlapped++;
    }
    await new Promise((r) => setImmediate(r));
    inFlight.set(key, (inFlight.get(key) ?? 0) - 1);
    return answer();
  };
  const gone = (key: string) => new Error(`ENOENT ${key}`);
  return {
    disk,
    stats,
    reads,
    get overlapped() {
      return overlapped;
    },
    fs: {
      stat: (key: string) =>
        track(key, stats, () => {
          const f = disk.get(key);
          if (!f) {
            throw gone(key);
          }
          return { mtime: f.mtime, size: f.text.length };
        }),
      read: (key: string) =>
        track(key, reads, () => {
          const f = disk.get(key);
          if (!f) {
            throw gone(key);
          }
          return f.text;
        }),
    },
    write: (key: string, text: string) => {
      disk.set(key, { text, mtime: (disk.get(key)?.mtime ?? 1000) + 1 });
    },
  };
}

function timers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    pending: () => [...pending.values()],
    fire: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) {
        t.fn();
      }
    },
  };
}

const KEYS = ["a.clas.abap", "b.clas.abap", "c.clas.abap"];

function cacheOver(fake: ReturnType<typeof fakeFs>, clock = timers()) {
  return new SourceTextCache<string>(fake.fs, {
    ttlMs: 30000,
    idleMs: 300000,
    maxFiles: 4000,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
}

async function sweep(cache: SourceTextCache<string>, now: number) {
  cache.sweepStarted();
  try {
    return await Promise.all(KEYS.map((k) => cache.read(k, k, now)));
  } finally {
    cache.sweepEnded();
  }
}

test("the cold sweep stats alongside the read; the validation sweep past the TTL stats only", async () => {
  const fake = fakeFs({ "a.clas.abap": "A", "b.clas.abap": "B", "c.clas.abap": "C" });
  const cache = cacheOver(fake);

  assert.deepEqual(await sweep(cache, 0), ["A", "B", "C"]);
  assert.deepEqual(fake.reads.sort(), KEYS, "every file read once");
  assert.deepEqual(fake.stats.sort(), KEYS, "and stat'ed in the same step");
  assert.equal(fake.overlapped, 3, "the stat and the read of a file are in flight together");

  // inside the TTL: nothing touches the disk
  fake.reads.length = fake.stats.length = 0;
  assert.deepEqual(await sweep(cache, 20000), ["A", "B", "C"]);
  assert.deepEqual(fake.reads, []);
  assert.deepEqual(fake.stats, []);

  // past the TTL: a stat per file validates the text - NO read, which is
  // what the cold read's stamp buys (it used to re-read every file here)
  assert.deepEqual(await sweep(cache, 40000), ["A", "B", "C"]);
  assert.deepEqual(fake.stats.sort(), KEYS);
  assert.deepEqual(fake.reads, [], "the first validation is stat-only");

  // and the validation refreshed the clock: the next sweep inside the TTL
  // of it is free again
  fake.stats.length = 0;
  await sweep(cache, 50000);
  assert.deepEqual(fake.stats, []);
});

test("a validation re-reads exactly the file whose stamp moved", async () => {
  const fake = fakeFs({ "a.clas.abap": "A", "b.clas.abap": "B", "c.clas.abap": "C" });
  const cache = cacheOver(fake);
  await sweep(cache, 0);
  fake.write("b.clas.abap", "B2"); // behind the watcher's back (a network share)
  fake.reads.length = fake.stats.length = 0;
  assert.deepEqual(await sweep(cache, 40000), ["A", "B2", "C"]);
  assert.deepEqual(fake.reads, ["b.clas.abap"]);
  assert.deepEqual(fake.stats.sort(), KEYS);
  // a file gone from disk is gone from the cache
  fake.disk.delete("c.clas.abap");
  assert.deepEqual(await sweep(cache, 80000), ["A", "B2", undefined]);
  assert.ok(!cache.has("c.clas.abap"));
});

test("the idle eviction drops the cache after the last sweep - unless one is in flight", async () => {
  const fake = fakeFs({ "a.clas.abap": "A", "b.clas.abap": "B", "c.clas.abap": "C" });
  const clock = timers();
  const cache = cacheOver(fake, clock);
  await sweep(cache, 0);
  assert.equal(cache.size, 3);
  assert.equal(clock.pending().length, 1, "one eviction armed by the sweep's end");
  assert.equal(clock.pending()[0].ms, 300000);

  // a sweep in flight when the timer fires keeps the cache
  cache.sweepStarted();
  clock.fire();
  assert.equal(cache.size, 3, "kept for the sweep in flight");
  cache.sweepEnded();
  assert.equal(clock.pending().length, 1, "re-armed by that sweep's end");

  // idle: dropped whole, and the next sweep is cold again (read AND stat)
  clock.fire();
  assert.equal(cache.size, 0);
  fake.reads.length = fake.stats.length = 0;
  await sweep(cache, 400000);
  assert.deepEqual(fake.reads.sort(), KEYS);
  assert.deepEqual(fake.stats.sort(), KEYS);
  cache.dispose();
  assert.equal(clock.pending().length, 0, "dispose disarms the eviction");
});

test("an invalidation while a read is in flight answers but stores nothing", async () => {
  const fake = fakeFs({ "a.clas.abap": "A" });
  const cache = cacheOver(fake);
  const reading = cache.read("a.clas.abap", "a.clas.abap", 0);
  cache.forget("a.clas.abap"); // the watcher: the file changed
  assert.equal(await reading, "A");
  assert.ok(!cache.has("a.clas.abap"), "possibly the text from before the change - not kept");
  assert.equal(cache.invalidations, 1);
  // a forgotten file is read cold again (stat and read)
  fake.reads.length = fake.stats.length = 0;
  await cache.read("a.clas.abap", "a.clas.abap", 1);
  assert.deepEqual(fake.reads, ["a.clas.abap"]);
  assert.deepEqual(fake.stats, ["a.clas.abap"]);
  assert.ok(cache.has("a.clas.abap"));
});

test("the cache is a working set: pruned to what the sweep saw, dropped above maxFiles", async () => {
  const fake = fakeFs({ "a.clas.abap": "A", "b.clas.abap": "B", "c.clas.abap": "C" });
  const cache = new SourceTextCache<string>(fake.fs, {
    ttlMs: 30000,
    idleMs: 300000,
    maxFiles: 2,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  await cache.read("a.clas.abap", "a.clas.abap", 0);
  await cache.read("b.clas.abap", "b.clas.abap", 0);
  assert.equal(cache.size, 2);
  await cache.read("c.clas.abap", "c.clas.abap", 0);
  assert.equal(cache.size, 1, "at the cap the cache is dropped rather than grown");
  await cache.read("a.clas.abap", "a.clas.abap", 0);
  cache.pruneTo(new Set(["a.clas.abap"]));
  assert.ok(cache.has("a.clas.abap"));
  assert.ok(!cache.has("c.clas.abap"));
  cache.forgetAll();
  assert.equal(cache.size, 0);
});
