import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedScan } from "../sharedscan";

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
