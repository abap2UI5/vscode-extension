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
    systemOrigin: "https://sys-a:44300",
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
  await until(() => h.logs.some((l) => l.includes("ADT already refused on")));
  h.watch.dispose();
  assert.ok(
    h.logs.some((l) => l.includes("ADT already refused on")),
    "the restart did not log the refusal"
  );
  assert.deepEqual(h.reloads, []);
});

/*
 * 401 is the one 4xx that says nothing about this system's ADT: it says the
 * credentials the proxy holds are wrong right now, which the user fixes by
 * re-entering them. Latching it switched reload-on-activation off for the
 * rest of the window after a single mistyped password.
 */
test("a 401 does not latch, a 403 does", async () => {
  const transient = harness([
    new AdtStatusError(401),
    { version: "inactive" },
    { version: "active" },
  ]);
  transient.watch.start();
  await until(() => transient.reloads.length > 0);
  transient.watch.dispose();
  assert.deepEqual(
    transient.reloads,
    ["Reloaded after activation"],
    "the watch bailed on a transient credential failure"
  );
  assert.ok(
    !transient.logs.some((l) => l.includes("giving up")),
    "the 401 was latched as a permanent ADT verdict"
  );

  // and a restart still works - nothing was remembered about this system
  const permanent = harness([new AdtStatusError(403)]);
  permanent.watch.start();
  await until(() => permanent.logs.some((l) => l.includes("giving up")));
  permanent.watch.start();
  await until(() => permanent.logs.some((l) => l.includes("already refused on")));
  permanent.watch.dispose();
  assert.ok(
    permanent.logs.some((l) => l.includes("already refused on")),
    "403 stopped latching - ADT that is not exposed would be polled forever"
  );
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

test("a system that refuses ADT does not disable the watch for another system", async () => {
  /*
   * As a plain flag this latched for the whole window: one launch against a
   * system whose /sap/bc/adt is closed switched reload-on-activation off for
   * every other system too, until the window was reloaded - with nothing but
   * a log line to say so.
   */
  const source = {
    isRunning: true,
    systemOrigin: "https://closed:44300",
    calls: 0,
    async fetchClassState(): Promise<AdtClassState> {
      this.calls++;
      throw new AdtStatusError(403);
    },
  };
  const logs: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current: () => ({ className: "ZCL_APP" }),
      log: (m) => logs.push(m),
      reload: () => undefined,
    },
    { firstMs: 1, pollMs: 5, timeoutMs: 500 }
  );

  watch.start();
  await until(() => logs.some((l) => l.includes("giving up on")));
  const refusedCalls = source.calls;

  // asked again on the SAME system: refused without a request
  watch.start();
  await sleep(20);
  assert.equal(source.calls, refusedCalls, "the refused system was asked again");
  assert.ok(logs.some((l) => l.includes("already refused on https://closed:44300")));

  // the user switches systems - the other one has never refused anything
  source.systemOrigin = "https://open:44300";
  watch.start();
  await until(() => source.calls > refusedCalls);
  assert.ok(
    source.calls > refusedCalls,
    "the watch stayed off after switching to a system that never refused"
  );
});

test("the poll backs off once the slow threshold is reached", async () => {
  // always active with no baseline: the watch keeps polling until disposed
  const source = scriptedSource([
    { version: "active", changedAt: "2026-01-01T00:00:00Z" },
  ]);
  const logs: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current: () => ({ className: "ZCL_APP" }),
      log: (m) => logs.push(m),
      reload: () => assert.fail("must not reload"),
    },
    { firstMs: 1, pollMs: 1, timeoutMs: 5000, slowAfterMs: 0, slowPollMs: 60 }
  );
  watch.start();
  await sleep(150);
  watch.dispose();
  // at pollMs=1 this window would hold dozens of polls; slowPollMs=60 caps it
  assert.ok(
    source.calls <= 5,
    `expected the slow cadence, saw ${source.calls} polls in 150 ms`
  );
});

test("a watch that times out tells the preview it gave up", async () => {
  const source = scriptedSource([
    { version: "active", changedAt: "2026-01-01T00:00:00Z" },
  ]);
  const logs: string[] = [];
  const gaveUp: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current: () => ({ className: "ZCL_APP" }),
      log: (m) => logs.push(m),
      reload: () => assert.fail("must not reload"),
      gaveUp: (reason) => gaveUp.push(reason),
    },
    { firstMs: 1, pollMs: 2, timeoutMs: 30 }
  );
  watch.start();
  await until(() => gaveUp.length > 0);
  watch.dispose();
  assert.equal(gaveUp.length, 1);
  assert.ok(gaveUp[0].includes("gave up"));
  assert.ok(logs.some((l) => l.includes("giving up")));
});

test("a slow baseline answer cannot resurrect itself after the next save", async () => {
  /*
   * captureBaseline is fire-and-forget. A late answer used to overwrite the
   * baseline of the state the preview had moved on from, which made the next
   * poll read "changed since shown" for an activation that never happened -
   * and that reload cleared the "not activated" badge, the one thing telling
   * the user their saved code is not live yet.
   */
  let release: (state: AdtClassState) => void = () => undefined;
  const source = {
    isRunning: true,
    systemOrigin: "https://sys-a:44300",
    calls: 0,
    async fetchClassState(): Promise<AdtClassState> {
      this.calls++;
      if (this.calls === 1) {
        return new Promise<AdtClassState>((resolve) => {
          release = resolve;
        });
      }
      return { version: "active", changedAt: "2026-01-01T00:00:00Z" };
    },
  };
  const logs: string[] = [];
  const reloads: string[] = [];
  const watch = new ActivationWatch(
    {
      source,
      current: () => ({ className: "ZCL_APP" }),
      log: (m) => logs.push(m),
      reload: (r) => reloads.push(r),
    },
    { firstMs: 10_000, pollMs: 10_000, timeoutMs: 60_000 }
  );

  watch.captureBaseline(); // hangs
  watch.start(); // the next save: stop() bumps the generation
  release({ version: "active", changedAt: "2020-01-01T00:00:00Z" });
  await sleep(20);

  assert.equal(
    logs.some((l) => l.includes("was last changed")),
    false,
    "the superseded baseline answer was still recorded"
  );
  watch.stop();
});
