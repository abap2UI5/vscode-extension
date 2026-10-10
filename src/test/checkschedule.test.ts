import { test } from "node:test";
import assert from "node:assert/strict";
import { RECHECK_STAGGER_MS, recheckSchedule, sweepInBatches } from "../checkschedule";

/*
 * The view check's scheduling decisions (checkschedule.ts) - what the
 * desktop and the web check share without an editor.
 */

/** A fake clock: `setTimeout` stand-in whose timers run in time order on
 *  `run( )`, recording the order. */
function fakeTimers() {
  const timers: Array<{ at: number; fn: () => void; seq: number }> = [];
  let seq = 0;
  return {
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: ms, fn, seq: seq++ });
    },
    run: () => {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      for (const t of timers.splice(0)) {
        t.fn();
      }
    },
  };
}

test("a re-check of everything open runs the visible editors first, the rest staggered", () => {
  const docs = ["bg1", "visible-a", "bg2", "visible-b", "bg3"];
  const visible = new Set(["visible-a", "visible-b"]);
  const plan = recheckSchedule(docs, (d) => visible.has(d));
  assert.deepEqual(plan, [
    { doc: "visible-a", delay: 0 },
    { doc: "visible-b", delay: 0 },
    { doc: "bg1", delay: RECHECK_STAGGER_MS },
    { doc: "bg2", delay: 2 * RECHECK_STAGGER_MS },
    { doc: "bg3", delay: 3 * RECHECK_STAGGER_MS },
  ]);
  // scheduled through a clock, the checks run in that order and never two
  // background documents at the same moment
  const clock = fakeTimers();
  const ran: string[] = [];
  for (const { doc, delay } of plan) {
    clock.setTimeout(() => ran.push(doc), delay);
  }
  clock.run();
  assert.deepEqual(ran, ["visible-a", "visible-b", "bg1", "bg2", "bg3"]);
  const delays = plan.filter((p) => p.delay > 0).map((p) => p.delay);
  assert.equal(new Set(delays).size, delays.length, "each background document its own moment");
});

test("nothing visible: every document is staggered; nothing open: nothing scheduled", () => {
  assert.deepEqual(recheckSchedule(["a", "b"], () => false, 10), [
    { doc: "a", delay: 10 },
    { doc: "b", delay: 20 },
  ]);
  assert.deepEqual(recheckSchedule([], () => true), []);
  assert.deepEqual(recheckSchedule(["a"], () => true), [{ doc: "a", delay: 0 }]);
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("the sweep stages a batch concurrently, gates in order and yields after every gated file", async () => {
  const targets = ["a", "b", "c", "d", "e"];
  let inFlight = 0;
  let widest = 0;
  const staged: string[] = [];
  const handled: string[] = [];
  const yields: string[] = [];
  let last = "";
  await sweepInBatches(targets, {
    batch: 2,
    stage: async (t) => {
      inFlight++;
      widest = Math.max(widest, inFlight);
      await new Promise((r) => setTimeout(r, t === "a" ? 5 : 0)); // the first lands last
      inFlight--;
      staged.push(t);
      return t === "c" ? undefined : { text: t.toUpperCase() };
    },
    handle: (t, io) => {
      handled.push(t);
      last = t;
      // a cache hit ("d") and a vanished file ("c") do no gating
      return io !== undefined && t !== "d";
    },
    cancelled: () => false,
    yieldTurn: async () => {
      yields.push(last);
    },
  });
  assert.equal(widest, 2, "a batch's I/O runs together, never more than the batch");
  assert.deepEqual(handled, targets, "handled in the glob's order whatever landed first");
  assert.deepEqual(staged.slice(0, 2), ["b", "a"], "the fake I/O did land out of order");
  assert.deepEqual(yields, ["a", "b", "e"], "a turn after each gated file, none for a hit or a miss");
});

test("a cancelled sweep stops after the file it is on, mid-batch too", async () => {
  const handled: string[] = [];
  let cancelled = false;
  let staged = 0;
  await sweepInBatches(["a", "b", "c", "d"], {
    batch: 4,
    stage: async (t) => {
      staged++;
      return t;
    },
    handle: (t) => {
      handled.push(t);
      if (t === "b") {
        cancelled = true;
      }
      return true;
    },
    cancelled: () => cancelled,
    yieldTurn: async () => {},
  });
  assert.deepEqual(handled, ["a", "b"]);
  assert.equal(staged, 4, "the batch in flight is awaited, not abandoned");
});

test("the yield really gives the host a turn between gated files", async () => {
  // with the default yield (a macrotask), work queued by the host runs
  // between two gated files - it used to wait for the whole batch
  const gate = deferred();
  const order: string[] = [];
  setTimeout(() => {
    order.push("host");
    gate.resolve();
  }, 0);
  await sweepInBatches(["a", "b"], {
    batch: 8,
    stage: async (t) => t,
    handle: (t) => {
      order.push(t);
      return true;
    },
    cancelled: () => false,
  });
  await gate.promise;
  assert.deepEqual(order, ["a", "host", "b"]);
});
