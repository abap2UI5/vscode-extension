import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GateMemo,
  RECHECK_STAGGER_MS,
  recheckSchedule,
  sweepEntryOf,
  sweepInBatches,
  textFingerprint,
} from "../checkschedule";
import type { PropertyFinding } from "@abap2ui5/linter/properties";

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

test("a sweep leaves no text in its cache - the ranges and a fingerprint instead", () => {
  const finding = { type: "unknown-property", control: "sap.m.Button", member: "nosuch", line: 2, column: 3 } as PropertyFinding;
  const text = "<mvc:View>\n  <Button nosuch=\"x\"/>\n</mvc:View>\n";
  const placed: string[] = [];
  const entry = sweepEntryOf("m1|", { findings: [finding] }, text, (t, findings) => {
    placed.push(t);
    return findings.map((f) => `${f.line}:${f.column}`);
  });
  assert.ok(!("text" in entry), "the text is not kept");
  assert.deepEqual(entry.placed, ["2:3"], "the ranges were placed while the text was in hand");
  assert.deepEqual(placed, [text]);
  assert.equal(entry.fingerprint, textFingerprint(text));
  assert.notEqual(textFingerprint(text), textFingerprint(text + " "), "an edit since the sweep is told");
  assert.equal(textFingerprint(text), textFingerprint(String(text)), "stable");
  assert.equal(entry.findings[0], finding, "the finding objects are the gate's own - a baseline applied to a copy keeps the rest placed");

  // an open document: its version is the stamp, nothing is placed or fingerprinted
  const open = sweepEntryOf("v3|", { findings: [finding] }, undefined, () => {
    throw new Error("not for an open document");
  });
  assert.deepEqual(open, { stamp: "v3|", findings: [finding] });
  // a clean file from disk: nothing to place either
  assert.deepEqual(sweepEntryOf("m1|", { findings: [] }, text, () => []), { stamp: "m1|", findings: [] });
  // nothing checked: remembered as a skip
  assert.deepEqual(
    sweepEntryOf("m1|", { findings: [finding], nothingChecked: "no view" }, text, () => []),
    { stamp: "m1|", findings: [], skip: true }
  );
});

test("one gate run per document version, whichever of findingsNow and checkDocument asks first", () => {
  // the lens/code-action refetch (~250 ms after a change) reaches
  // findingsNow before the live check (400 ms) reaches checkDocument - both
  // go through the memo, so the second reads what the first ran
  let gates = 0;
  const runGate = () => ({ gate: { findings: [`run ${++gates}`] }, baselined: 0 });
  const memos = new GateMemo<ReturnType<typeof runGate>>();
  const key = "file:///zcl_app.clas.abap";

  // findingsNow at version 7, then checkDocument at version 7
  const first = memos.once(key, 7, 1, runGate);
  const check = memos.get(key, 7, 1) ?? memos.once(key, 7, 1, runGate);
  assert.equal(gates, 1, "the check reads the gate run the refetch did");
  assert.equal(check, first);

  // the other order: checkDocument seeds, findingsNow reads
  const seeded = runGate();
  memos.set(key, 8, 1, seeded);
  assert.equal(memos.once(key, 8, 1, runGate), seeded);
  assert.equal(gates, 2, "no second run for version 8");

  // a new version, a new config generation, another document: each its own run
  memos.once(key, 9, 1, runGate);
  memos.once(key, 9, 2, runGate);
  memos.once("file:///other.clas.abap", 9, 2, runGate);
  assert.equal(gates, 5);
  assert.equal(memos.get(key, 9, 1), undefined, "the slot per URI holds the latest only");
  assert.ok(memos.get(key, 9, 2));

  // clear (baseline file, class index) and delete (closed) forget
  memos.delete("file:///other.clas.abap");
  assert.equal(memos.size, 1);
  memos.clear();
  assert.equal(memos.get(key, 9, 2), undefined);

  // a gate that throws stores nothing
  assert.throws(() =>
    memos.once(key, 10, 2, () => {
      throw new Error("mid-edit");
    })
  );
  assert.equal(memos.get(key, 10, 2), undefined);
});
