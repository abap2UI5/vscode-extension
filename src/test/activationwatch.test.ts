import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivationWatch, ClassStateSource } from "../activationwatch";
import { AdtClassState, AdtStatusError } from "../proxy";

/*
 * The activation watch, driven with a scripted stand-in for the proxy: the
 * inactive→active flip, the newer-changedAt shortcut, the 4xx give-up and
 * the generation handling are the exact behaviours a stale preview depends
 * on - and none of them needs VS Code to be proven.
 */

const TIMING = { firstMs: 1, pollMs: 2, timeoutMs: 5000 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until `probe` is true (or the deadline passes). */
async function until(probe: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!probe() && Date.now() < deadline) {
    await sleep(5);
  }
}

/** A proxy stand-in answering from a script, one answer per poll. */
function scriptedSource(
  answers: Array<AdtClassState | Error>
): ClassStateSource & { calls: number } {
  return {
    isRunning: true,
    calls: 0,
    async fetchClassState() {
      this.calls++;
      const next = answers[Math.min(this.calls - 1, answers.length - 1)];
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

interface Harness {
  watch: ActivationWatch;
  source: ClassStateSource & { calls: number };
  reloads: string[];
  logs: string[];
}

function harness(
  answers: Array<AdtClassState | Error>,
  current: () => { className: string; sapClient?: string } | undefined = () => ({
    className: "ZCL_APP",
  })
): Harness {
  const source = scriptedSource(answers);
  const reloads: string[] = [];
  const logs: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current,
      log: (m) => logs.push(m),
      reload: (reason) => reloads.push(reason),
    },
    TIMING
  );
  return { watch, source, reloads, logs };
}

test("an observed inactive→active flip reloads the preview", async () => {
  const h = harness([
    { version: "inactive" },
    { version: "inactive" },
    { version: "active", changedAt: "2026-01-01T00:00:00Z" },
  ]);
  h.watch.start();
  await until(() => h.reloads.length > 0);
  h.watch.dispose();
  assert.deepEqual(h.reloads, ["Reloaded after activation"]);
  assert.ok(h.logs.some((l) => l.includes("is inactive on the server")));
  assert.ok(h.logs.some((l) => l.includes("is active again")));
});

test("a newer changedAt than the baseline reloads even without a seen flip", async () => {
  // save+activate finished before the first poll: the class is already
  // active again, only the timestamp says something happened
  const h = harness([
    { version: "active", changedAt: "2026-01-01T00:00:00Z" }, // baseline
    { version: "active", changedAt: "2026-01-01T00:00:05Z" },
  ]);
  h.watch.captureBaseline();
  await until(() => h.source.calls >= 1);
  h.watch.start();
  await until(() => h.reloads.length > 0);
  h.watch.dispose();
  assert.deepEqual(h.reloads, ["Reloaded after activation"]);
  assert.ok(h.logs.some((l) => l.includes("newer change")));
});

test("active with no change since the baseline keeps waiting", async () => {
  const h = harness([{ version: "active", changedAt: "2026-01-01T00:00:00Z" }]);
  h.watch.captureBaseline();
  await until(() => h.source.calls >= 1);
  h.watch.start();
  await until(() => h.source.calls >= 4);
  h.watch.dispose();
  assert.deepEqual(h.reloads, []);
  assert.ok(h.logs.some((l) => l.includes("still shows no change")));
});

test("a 4xx from ADT gives up for the session", async () => {
  const h = harness([new AdtStatusError(403)]);
  h.watch.start();
  await until(() => h.logs.some((l) => l.includes("giving up")));
  const callsAfterGiveUp = h.source.calls;
  await sleep(20);
  assert.equal(h.source.calls, callsAfterGiveUp, "no more polls after a 4xx");
  // and a restart refuses outright
  h.watch.start();
  await until(() =>
    h.logs.some((l) => l.includes("ADT already refused earlier this session"))
  );
  h.watch.dispose();
  assert.deepEqual(h.reloads, []);
});

test("a network error is retried, not fatal", async () => {
  const h = harness([
    new Error("socket hang up"),
    { version: "inactive" },
    { version: "active" },
  ]);
  h.watch.start();
  await until(() => h.reloads.length > 0);
  h.watch.dispose();
  assert.deepEqual(h.reloads, ["Reloaded after activation"]);
  assert.ok(h.logs.some((l) => l.includes("request failed (socket hang up)")));
});

/** A source whose answers the test releases by hand - for the tests that
 *  must act while a poll is still in flight. */
function manualSource(): ClassStateSource & {
  calls: number;
  answer: (state: AdtClassState) => void;
} {
  const pending: Array<(state: AdtClassState) => void> = [];
  return {
    isRunning: true,
    calls: 0,
    fetchClassState() {
      this.calls++;
      return new Promise((resolve) => pending.push(resolve));
    },
    answer(state: AdtClassState) {
      pending.shift()?.(state);
    },
  };
}

test("stop() makes an in-flight watch stale", async () => {
  const source = manualSource();
  const reloads: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current: () => ({ className: "ZCL_APP" }),
      log: () => {},
      reload: (reason) => reloads.push(reason),
    },
    TIMING
  );
  watch.start();
  await until(() => source.calls >= 1);
  watch.stop(); // the first poll is still waiting for its answer
  source.answer({ version: "active", changedAt: "2026-01-01T00:00:01Z" });
  await sleep(20);
  watch.dispose();
  assert.deepEqual(reloads, [], "a stopped watch never reloads");
});

test("the watch ends when the preview shows another app", async () => {
  let shown: { className: string } | undefined = { className: "ZCL_APP" };
  const source = manualSource();
  const reloads: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current: () => shown,
      log: () => {},
      reload: (reason) => reloads.push(reason),
    },
    TIMING
  );
  watch.start();
  await until(() => source.calls >= 1);
  shown = { className: "ZCL_OTHER" }; // the preview moved on mid-poll
  source.answer({ version: "inactive" });
  await sleep(20);
  watch.dispose();
  assert.equal(source.calls, 1, "the next tick sees the other app and ends");
  assert.deepEqual(reloads, []);
});

test("an answer without a version stops the watch", async () => {
  const h = harness([{}]);
  h.watch.start();
  await until(() => h.logs.some((l) => l.includes("contained no version")));
  const calls = h.source.calls;
  await sleep(20);
  h.watch.dispose();
  assert.equal(h.source.calls, calls);
  assert.deepEqual(h.reloads, []);
});

test("without a running proxy the watch does not start", async () => {
  const source: ClassStateSource & { calls: number } = {
    isRunning: false,
    calls: 0,
    async fetchClassState() {
      this.calls++;
      return {};
    },
  };
  const logs: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current: () => ({ className: "ZCL_APP" }),
      log: (m) => logs.push(m),
      reload: () => assert.fail("must not reload"),
    },
    TIMING
  );
  watch.start();
  await sleep(15);
  watch.dispose();
  assert.equal(source.calls, 0);
  assert.ok(logs.some((l) => l.includes("no auth proxy")));
});
