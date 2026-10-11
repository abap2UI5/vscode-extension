import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedScan, mapInPool } from "../sharedscan";

/*
 * The scan in flight that concurrent callers share (`abapsources.ts`): the
 * cold start of the app-class index, the class index and the apps tree used
 * to read every file of the workspace once EACH.
 */

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test("a caller asking while a scan runs joins it", async () => {
  const shared = new SharedScan<string>();
  let started = 0;
  const gate = deferred<string>();
  const start = () => {
    started++;
    return gate.promise;
  };
  const a = shared.run("2000", 0, start);
  const b = shared.run("2000", 0, start);
  gate.resolve("scan");
  assert.deepEqual(await Promise.all([a, b]), ["scan", "scan"]);
  assert.equal(started, 1);
});

test("a finished scan is not reused - the next caller starts its own", async () => {
  const shared = new SharedScan<number>();
  let started = 0;
  const start = async () => ++started;
  assert.equal(await shared.run("2000", 0, start), 1);
  assert.equal(await shared.run("2000", 0, start), 2);
});

test("a change since the running scan started, or another cap, is not joined", async () => {
  const shared = new SharedScan<string>();
  const first = deferred<string>();
  let started = 0;
  const a = shared.run("2000", 0, () => (started++, first.promise));
  // a file changed: the running scan may have read the old text
  const b = shared.run("2000", 1, async () => (started++, "fresh"));
  // another cap is another question
  const c = shared.run("500", 1, async () => (started++, "capped"));
  first.resolve("stale");
  assert.deepEqual(await Promise.all([a, b, c]), ["stale", "fresh", "capped"]);
  assert.equal(started, 3);
});

test("a failed scan fails its joiners and is not reused", async () => {
  const shared = new SharedScan<string>();
  const failing = deferred<string>();
  const a = shared.run("2000", 0, () => failing.promise);
  const b = shared.run("2000", 0, async () => "never");
  failing.reject(new Error("glob failed"));
  await assert.rejects(a, /glob failed/);
  await assert.rejects(b, /glob failed/);
  assert.equal(await shared.run("2000", 0, async () => "again"), "again");
});

/*
 * The bounded pool the cold scan reads files through (`abapsources.ts`).
 */

test("mapInPool keeps at most `width` calls in flight and answers in item order", async () => {
  const gates = new Map<number, ReturnType<typeof deferred<string>>>();
  let inFlight = 0;
  let peak = 0;
  const work = (n: number) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    const gate = deferred<string>();
    gates.set(n, gate);
    return gate.promise.then((v) => (inFlight--, v));
  };
  const all = mapInPool([1, 2, 3, 4, 5], 2, work);
  await Promise.resolve();
  assert.equal(gates.size, 2, "two reads dispatched, the rest wait");
  // the second finishes first - the order of the answer is the items' order
  gates.get(2)!.resolve("b");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gates.size, 3, "a slot freed starts the next item");
  gates.get(1)!.resolve("a");
  await Promise.resolve();
  await Promise.resolve();
  gates.get(3)!.resolve("c");
  gates.get(4)!.resolve("d");
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  gates.get(5)!.resolve("e");
  assert.deepEqual(await all, ["a", "b", "c", "d", "e"]);
  assert.equal(peak, 2);
});

test("mapInPool leaves out undefined answers and copes with an empty list", async () => {
  assert.deepEqual(
    await mapInPool([1, 2, 3, 4], 8, async (n) => (n % 2 ? undefined : n * 10)),
    [20, 40]
  );
  assert.deepEqual(await mapInPool([], 8, async () => 1), []);
});

test("mapInPool stops dispatching when `stop` says so", async () => {
  let stopped = false;
  const seen: number[] = [];
  const out = await mapInPool(
    [1, 2, 3, 4, 5, 6],
    2,
    async (n) => {
      seen.push(n);
      if (n === 2) {
        stopped = true;
      }
      return n;
    },
    () => stopped
  );
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(out, [1, 2]);
});
