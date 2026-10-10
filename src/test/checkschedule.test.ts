import { test } from "node:test";
import assert from "node:assert/strict";
import { RECHECK_STAGGER_MS, recheckSchedule } from "../checkschedule";

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
