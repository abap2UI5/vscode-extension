import { test } from "node:test";
import assert from "node:assert/strict";
import { DataGate, startWeb } from "../web/startup";

/*
 * The web activation's order (src/web/startup.ts): the registrations before
 * the reads, the checks held until the reads are in. The in-host smoke test
 * cannot run in a restricted environment, so the ordering lives here.
 */

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("the features are registered before the data reads resolve; held checks run once they are in", async () => {
  const gate = new DataGate();
  const reads = deferred<Array<string | undefined>>();
  const order: string[] = [];
  const logged: string[] = [];
  const started = startWeb({
    register: () => {
      order.push("registered");
      // a check scheduled right after activation (an open document) waits
      gate.whenOpen(() => order.push("check zcl_app"));
      gate.whenOpen(() => order.push("check zcl_other"));
    },
    load: () => {
      order.push("reads started");
      return reads.promise;
    },
    log: (m) => logged.push(m),
    gate,
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["registered", "reads started"], "nothing checked before the data is in");
  assert.equal(gate.isOpen, false);

  reads.resolve([undefined, "web: dist/client-api.json could not be read", undefined]);
  await started;
  assert.deepEqual(order, ["registered", "reads started", "check zcl_app", "check zcl_other"]);
  assert.deepEqual(logged, ["web: dist/client-api.json could not be read"], "a failed read is logged, not fatal");
  assert.equal(gate.isOpen, true);

  // after the release a check runs at once
  gate.whenOpen(() => order.push("check later"));
  assert.equal(order[order.length - 1], "check later");
  gate.release();
  assert.equal(order.length, 5, "a second release runs nothing twice");
});

test("a load that throws still releases the gate - the features run on what there is", async () => {
  const gate = new DataGate();
  const logged: string[] = [];
  let ran = false;
  gate.whenOpen(() => {
    ran = true;
  });
  await startWeb({
    register: () => {},
    load: async () => {
      throw new Error("no workspace.fs");
    },
    log: (m) => logged.push(m),
    gate,
  });
  assert.ok(ran);
  assert.match(logged[0], /no workspace\.fs/);
});
