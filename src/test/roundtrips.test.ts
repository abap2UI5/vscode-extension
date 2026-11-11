import { test } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "zlib";
import * as http from "http";
import { AddressInfo } from "net";
import { inspect } from "util";
import {
  applyDelta,
  BODY_CAP_BYTES,
  BodyTap,
  decodeContent,
  deltaPaths,
  diffModels,
  formatChange,
  parseRequest,
  parseResponse,
  replayQuestion,
  replayRoundtrip,
  ReplayDeps,
  ROUNDTRIP_CAP,
  RoundtripBuffer,
  RoundtripCapture,
  roundtripDescription,
  roundtripDetail,
  roundtripHeader,
  roundtripLabel,
} from "../roundtrips";
import { SapProxy } from "../proxy";
import { nodeRequest } from "../agentapps";

/*
 * The roundtrip ring: what is kept, what is not, what "the model before and
 * after" means, and that a replay never leaves without a yes.
 */

const start = (cls: string) =>
  JSON.stringify({ value: { S_FRONT: { ORIGIN: "https://h", PATHNAME: "/sap/bc/z2ui5", SEARCH: `?app_start=${cls}` } } });
const event = (id: string, name: string, args: unknown[] = [], model?: unknown) =>
  JSON.stringify({ value: { S_FRONT: { ID: id, EVENT: name, T_EVENT_ARG: args }, ...(model ? { MODEL: model } : {}) } });
const answer = (id: string, model?: unknown, app = "Z_APP") =>
  JSON.stringify({ S_FRONT: { ID: id, APP: app, S_ACTION: {} }, ...(model !== undefined ? { MODEL: model } : {}) });

function capture(request: string | undefined, response: string | undefined, more: Partial<RoundtripCapture> = {}): RoundtripCapture {
  return {
    at: Date.UTC(2026, 0, 1, 12, 0, 0),
    path: "/sap/bc/z2ui5?sap-client=100",
    status: 200,
    durationMs: 42,
    requestHeaders: { "content-type": "application/json", cookie: "sap-usercontext=x", "user-agent": "browser" },
    requestBody: request === undefined ? undefined : Buffer.from(request),
    requestBytes: request?.length ?? BODY_CAP_BYTES + 1,
    responseBody: response === undefined ? undefined : Buffer.from(response),
    responseBytes: response?.length ?? BODY_CAP_BYTES + 1,
    responseEncoding: "",
    ...more,
  };
}

// ---------------------------------------------------------------------------
// the protocol's bodies
// ---------------------------------------------------------------------------

test("an event request yields the event, its arguments, the draft id and the delta", () => {
  const parsed = parseRequest(event("D1", "SAVE", ["7", "x"], { MV_NAME: "typed" }));
  assert.deepEqual(parsed, { draftId: "D1", event: "SAVE", args: ["7", "x"], delta: { MV_NAME: "typed" } });
});

test("an app start names the class and has no event", () => {
  const parsed = parseRequest(start("z_my_app"));
  assert.equal(parsed?.startClass, "Z_MY_APP");
  assert.equal(parsed?.event, undefined);
  assert.deepEqual(parsed?.args, []);
});

test("a body that is not an abap2UI5 request is not one", () => {
  assert.equal(parseRequest("--batch_1\r\nGET Items"), undefined);
  assert.equal(parseRequest(`{"d": {"results": []}}`), undefined);
  assert.equal(parseRequest(`[1]`), undefined);
  assert.equal(parseResponse(`<html>logon</html>`), undefined);
});

test("a request without the value wrapper is read too", () => {
  assert.equal(parseRequest(JSON.stringify({ S_FRONT: { ID: "A", EVENT: "GO" } }))?.event, "GO");
});

test("an answer yields the next draft id, the class and the model", () => {
  assert.deepEqual(parseResponse(answer("D2", { A: 1 })), { draftId: "D2", app: "Z_APP", model: { A: 1 } });
  assert.equal("model" in (parseResponse(answer("D2")) ?? {}), false);
});

test("a delta replaces a top-level attribute and patches table cells", () => {
  const model = { MV_NAME: "old", MT_ROWS: [{ QTY: 1, T: [{ X: "a" }] }, { QTY: 2 }] };
  const next = applyDelta(model, {
    MV_NAME: "new",
    MT_ROWS: { __delta: { "1": { QTY: 5 }, "0": { T: { __delta: { "0": { X: "b" } } } } } },
  });
  assert.deepEqual(next, { MV_NAME: "new", MT_ROWS: [{ QTY: 1, T: [{ X: "b" }] }, { QTY: 5 }] });
  assert.equal(model.MV_NAME, "old", "the input is not modified");
  assert.equal(model.MT_ROWS[1].QTY, 2);
});

test("the paths a delta carries are named as binding paths", () => {
  assert.deepEqual(
    deltaPaths({ MV_NAME: "n", MT_ROWS: { __delta: { "1": { QTY: 5, T: { __delta: { "0": { X: 1 } } } } } } }),
    ["/MV_NAME", "/MT_ROWS/1/QTY", "/MT_ROWS/1/T/0/X"]
  );
});

// ---------------------------------------------------------------------------
// the diff
// ---------------------------------------------------------------------------

test("the diff names exactly the paths that changed", () => {
  const before = { MV_TITLE: "a", MV_SAME: 1, MS_HEAD: { CITY: "x", ZIP: "1" }, MT_ROWS: [{ N: 1 }, { N: 2 }], MV_GONE: true };
  const after = { MV_TITLE: "b", MV_SAME: 1, MS_HEAD: { CITY: "x", ZIP: "2" }, MT_ROWS: [{ N: 1 }, { N: 3 }, { N: 4 }], MV_NEW: "!" };
  assert.deepEqual(diffModels(before, after), [
    { path: "/MV_TITLE", kind: "changed", before: "a", after: "b" },
    { path: "/MS_HEAD/ZIP", kind: "changed", before: "1", after: "2" },
    { path: "/MT_ROWS/1/N", kind: "changed", before: 2, after: 3 },
    { path: "/MT_ROWS/2", kind: "added", after: { N: 4 } },
    { path: "/MV_GONE", kind: "removed", before: true },
    { path: "/MV_NEW", kind: "added", after: "!" },
  ]);
});

test("identical models differ nowhere, and a changed kind is one change", () => {
  assert.deepEqual(diffModels({ A: [1, { B: null }] }, { A: [1, { B: null }] }), []);
  assert.deepEqual(diffModels({ A: [1] }, { A: "1" }), [
    { path: "/A", kind: "changed", before: [1], after: "1" },
  ]);
  assert.deepEqual(diffModels({ A: [2, 1] }, { A: [2] }), [{ path: "/A/1", kind: "removed", before: 1 }]);
});

test("a change is one readable line, long values cut", () => {
  assert.equal(formatChange({ path: "/A", kind: "changed", before: "x", after: 2 }), `~ /A: "x" -> 2`);
  assert.equal(formatChange({ path: "/B/0", kind: "added", after: { N: 1 } }), `+ /B/0: {"N":1}`);
  assert.equal(formatChange({ path: "/C", kind: "removed", before: null }), `- /C: null`);
  assert.ok(formatChange({ path: "/L", kind: "added", after: "y".repeat(500) }).length < 80);
});

// ---------------------------------------------------------------------------
// the ring
// ---------------------------------------------------------------------------

test("the ring keeps the last 20 roundtrips, newest first", () => {
  const ring = new RoundtripBuffer();
  for (let i = 1; i <= ROUNDTRIP_CAP + 5; i++) {
    ring.add(capture(event(`D${i}`, `E${i}`), answer(`D${i + 1}`)));
  }
  assert.equal(ROUNDTRIP_CAP, 20);
  assert.equal(ring.size, 20);
  assert.equal(ring.list()[0].summary().event, "E25");
  assert.equal(ring.list()[19].summary().event, "E6");
  assert.equal(ring.get(1), undefined);
});

test("a POST that is not an abap2UI5 roundtrip is not kept", () => {
  const ring = new RoundtripBuffer();
  assert.equal(ring.add(capture("--batch\r\n", "ok")), undefined);
  assert.equal(ring.size, 0);
});

test("a body over the cap is not stored, and the entry says so", () => {
  const ring = new RoundtripBuffer();
  const big = ring.add(capture(event("D1", "LOAD"), undefined))!;
  assert.equal(big.responseText(), undefined);
  assert.match(big.summary().notes.join(), /response body larger than 512\.0 kB - not stored/);
  assert.equal(big.summary().replayable, true);

  const upload = ring.add(capture(undefined, answer("D2")))!;
  assert.equal(upload.requestText(), undefined);
  assert.equal(upload.summary().replayable, false);
  assert.equal(upload.summary().event, "(request not stored)");
  assert.match(roundtripDetail(upload.summary()), /request body larger than/);
});

test("the tap drops everything the moment the cap is passed", () => {
  const tap = new BodyTap(10);
  tap.push(Buffer.alloc(6));
  assert.equal(tap.take()?.length, 6);
  tap.push(Buffer.alloc(6));
  tap.push(Buffer.alloc(1));
  assert.equal(tap.take(), undefined);
  assert.equal(tap.bytes, 13);
});

test("a compressed answer is stored decoded, and capped by its decoded size", () => {
  const text = answer("D2", { MV: "ä" });
  for (const [coding, packed] of [
    ["gzip", zlib.gzipSync(text)],
    ["deflate", zlib.deflateSync(text)],
    ["deflate", zlib.deflateRawSync(text)],
    ["br", zlib.brotliCompressSync(text)],
    ["identity", Buffer.from(text)],
  ] as const) {
    const stored = decodeContent(packed, coding);
    assert.ok("bytes" in stored, coding);
    assert.equal(stored.bytes.toString("utf8"), text);
  }
  // 2 MB of zeros is a few kB of gzip: the cap is about what would be held
  const bomb = decodeContent(zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024)), "gzip");
  assert.deepEqual(bomb, { omitted: "larger than 512.0 kB - not stored" });
  assert.match(String((decodeContent(Buffer.from("x"), "zstd") as { omitted: string }).omitted), /not understood/);
  assert.match(String((decodeContent(Buffer.from("not gzip"), "gzip") as { omitted: string }).omitted), /could not be decompressed/);
});

test("only the roundtrip's own headers are kept for a replay", () => {
  const ring = new RoundtripBuffer();
  const entry = ring.add(
    capture(event("D1", "GO"), answer("D2"), {
      requestHeaders: {
        "content-type": "application/json",
        cookie: "a=1",
        "sap-contextid": "SID:1",
        "x-csrf-token": "tok",
        authorization: "Basic never",
        "user-agent": "browser",
        referer: "http://127.0.0.1:1/__abap2ui5/secret/x",
      },
    })
  )!;
  assert.deepEqual(entry.replayHeaders(), {
    "content-type": "application/json",
    cookie: "a=1",
    "x-csrf-token": "tok",
    "sap-contextid": "SID:1",
  });
});

test("clearing empties the ring and tells whoever shows a body", () => {
  const ring = new RoundtripBuffer();
  let cleared = 0;
  ring.onClear = () => cleared++;
  ring.clear();
  assert.equal(cleared, 0, "nothing to drop, nothing to tell");
  ring.add(capture(start("Z_APP"), answer("D1", {})));
  ring.clear();
  assert.equal(ring.size, 0);
  assert.equal(cleared, 1);
});

test("a roundtrip under another system's name empties the ring first", () => {
  const ring = new RoundtripBuffer();
  ring.add(capture(start("Z_APP"), answer("D1", {}), { scope: "DEV 100" }));
  ring.add(capture(event("D1", "A"), answer("D2"), { scope: "DEV 100" }));
  assert.equal(ring.size, 2);
  ring.add(capture(start("Z_APP"), answer("X1", {}), { scope: "DEV 200" }));
  assert.equal(ring.size, 1);
  assert.equal(ring.list()[0].summary().event, "app start");
});

// ---------------------------------------------------------------------------
// what counts as the model
// ---------------------------------------------------------------------------

test("show roundtrip: exactly the attributes the backend changed", () => {
  const ring = new RoundtripBuffer();
  ring.add(capture(start("Z_APP"), answer("D1", { MV_NAME: "", MV_COUNT: 0, MT_ROWS: [{ N: 1 }] })));
  // the user typed a name, then pressed the button
  const pressed = ring.add(
    capture(
      event("D1", "COUNT", ["1"], { MV_NAME: "typed" }),
      answer("D2", { MV_NAME: "typed", MV_COUNT: 1, MT_ROWS: [{ N: 1 }] })
    )
  )!;
  const models = ring.models(pressed);
  assert.deepEqual(models.before, { MV_NAME: "typed", MV_COUNT: 0, MT_ROWS: [{ N: 1 }] });
  assert.deepEqual(models.changes, [{ path: "/MV_COUNT", kind: "changed", before: 0, after: 1 }]);
  assert.deepEqual(models.sent, ["/MV_NAME"], "what was typed is named, not blamed on the backend");
  assert.deepEqual(models.notes, []);

  const header = roundtripHeader(pressed, models).join("\n");
  assert.match(header, /event COUNT, arguments: \["1"\]/);
  assert.match(header, /the backend changed 1, added 0, removed 0:\n {2}~ \/MV_COUNT: 0 -> 1/);
  assert.match(header, /sent with the request \(edited in the browser\): \/MV_NAME/);
});

test("an app start begins with an empty model", () => {
  const ring = new RoundtripBuffer();
  const first = ring.add(capture(start("Z_APP"), answer("D1", { MV: 1 })))!;
  const models = ring.models(first);
  assert.deepEqual(models.before, {});
  assert.deepEqual(models.changes, [{ path: "/MV", kind: "added", after: 1 }]);
});

test("an answer without a model changed nothing - through a chain of them", () => {
  const ring = new RoundtripBuffer();
  ring.add(capture(start("Z_APP"), answer("D1", { MV: 1 })));
  ring.add(capture(event("D1", "TOAST"), answer("D2")));
  const third = ring.add(capture(event("D2", "TOAST"), answer("D3")))!;
  const quiet = ring.models(third);
  assert.deepEqual(quiet.before, { MV: 1 });
  assert.deepEqual(quiet.changes, []);
  assert.match(roundtripHeader(third, quiet).join("\n"), /the backend changed nothing in the model/);

  const fourth = ring.add(capture(event("D3", "SET"), answer("D4", { MV: 2 })))!;
  assert.deepEqual(ring.models(fourth).changes, [{ path: "/MV", kind: "changed", before: 1, after: 2 }]);
});

test("without the roundtrip before it, 'before' is unknown - not guessed", () => {
  const ring = new RoundtripBuffer();
  const orphan = ring.add(capture(event("GONE", "SAVE"), answer("D9", { MV: 2 })))!;
  const models = ring.models(orphan);
  assert.equal(models.before, undefined);
  assert.deepEqual(models.after, { MV: 2 });
  assert.deepEqual(models.changes, []);
  assert.match(models.notes.join(), /no longer stored/);
  assert.doesNotMatch(roundtripHeader(orphan, models).join("\n"), /the backend changed/);
});

test("a predecessor whose answer was too large leaves 'before' unknown too", () => {
  const ring = new RoundtripBuffer();
  ring.add(capture(start("Z_APP"), undefined));
  const next = ring.add(capture(event("D1", "GO"), answer("D2", { A: 1 })))!;
  // the start's draft id is unknown with its body, so the chain ends there
  assert.equal(ring.models(next).before, undefined);
});

test("a hop to another app is said, since the two sides are different models", () => {
  const ring = new RoundtripBuffer();
  ring.add(capture(start("Z_APP"), answer("D1", { A: 1 })));
  const hop = ring.add(capture(event("D1", "NAV"), answer("D2", { B: 1 }, "Z_OTHER")))!;
  assert.match(ring.models(hop).notes.join(), /Z_APP -> Z_OTHER/);
});

test("the picker line carries time, event, class, duration and size", () => {
  const ring = new RoundtripBuffer();
  const entry = ring.add(capture(event("D1", "SAVE", ["a"]), answer("D2", {})))!;
  const summary = entry.summary();
  assert.match(roundtripLabel(summary), /^#1 {2}\d\d:\d\d:\d\d {2}SAVE$/);
  assert.equal(roundtripDescription(summary), `Z_APP · 42 ms · ${answer("D2", {}).length} B`);
  assert.equal(roundtripDetail(summary), `arguments: ["a"]`);
});

test("a path's logon parameters do not reach the header", () => {
  const ring = new RoundtripBuffer();
  const entry = ring.add(
    capture(start("Z_APP"), answer("D1", {}), { path: "/sap/bc/z2ui5?sap-user=me&sap-password=hunter2" })
  )!;
  const header = roundtripHeader(entry, ring.models(entry)).join("\n");
  assert.doesNotMatch(header, /hunter2/);
});

// ---------------------------------------------------------------------------
// a roundtrip never prints its bodies
// ---------------------------------------------------------------------------

test("serialising or printing a roundtrip shows no body, header or argument", () => {
  const ring = new RoundtripBuffer();
  const entry = ring.add(
    capture(event("D1", "SAVE", ["ARG-SECRET"], { MV: "REQ-SECRET" }), answer("D2", { MV: "RES-SECRET" }), {
      requestHeaders: { cookie: "COOKIE-SECRET" },
    })
  )!;
  for (const text of [
    JSON.stringify(entry),
    JSON.stringify(ring),
    JSON.stringify(ring.list()),
    String(entry),
    `${entry}`,
    inspect(entry, { depth: 10, showHidden: true }),
    inspect(ring, { depth: 10, showHidden: true }),
    JSON.stringify(Object.entries(entry)),
  ]) {
    assert.doesNotMatch(text, /SECRET/, text);
  }
  assert.match(entry.requestText() ?? "", /REQ-SECRET/, "asked for by name, it is there");
});

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

function replayable() {
  const ring = new RoundtripBuffer();
  const entry = ring.add(capture(event("D1", "SAVE", ["7"]), answer("D2", { A: 1 })))!;
  const sent: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const asked: string[] = [];
  const deps: ReplayDeps = {
    isTrusted: () => true,
    isProduction: () => false,
    confirm: async (q) => {
      asked.push(`${q.message}\n${q.detail}`);
      return true;
    },
    proxyBase: () => "http://127.0.0.1:5000/__abap2ui5/tok",
    isStored: (e) => ring.get(e.seq) === e,
    request: async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { status: 200, body: answer("D3", { A: 2 }) };
    },
  };
  return { ring, entry, sent, asked, deps };
}
const target = { system: "DEV (dev.example:44300)", className: "Z_FALLBACK" };

test("a confirmed replay sends the stored request to the proxy's own origin", async () => {
  const { entry, sent, asked, deps } = replayable();
  const result = await replayRoundtrip(entry, target, deps);
  assert.ok("status" in result);
  assert.equal(result.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://127.0.0.1:5000/__abap2ui5/tok/sap/bc/z2ui5?sap-client=100");
  assert.equal(sent[0].body, entry.requestText());
  assert.equal(sent[0].headers["content-type"], "application/json");
  assert.equal(sent[0].headers["accept-encoding"], "identity");
  assert.equal(asked.length, 1, "asked exactly once");
});

test("the question names system, class and event, and says it runs for real", () => {
  const { entry } = replayable();
  const q = replayQuestion(entry, target);
  assert.equal(q.message, `Replay the event "SAVE" of Z_APP on DEV (dev.example:44300)?`);
  assert.match(q.detail, /runs again for real/);
  assert.match(q.detail, /arguments: \["7"\]/);
  assert.deepEqual([q.system, q.className, q.event], [target.system, "Z_APP", "SAVE"]);
});

test("without a yes nothing is sent", async () => {
  for (const no of [false, undefined]) {
    const { entry, sent, deps } = replayable();
    const result = await replayRoundtrip(entry, target, { ...deps, confirm: async () => no });
    assert.deepEqual(result, { cancelled: true });
    assert.equal(sent.length, 0);
  }
});

test("Restricted Mode refuses before anything is asked", async () => {
  const { entry, sent, asked, deps } = replayable();
  const result = await replayRoundtrip(entry, target, { ...deps, isTrusted: () => false });
  assert.match((result as { refused: string }).refused, /Restricted Mode/);
  assert.equal(asked.length, 0);
  assert.equal(sent.length, 0);
});

test("a production system refuses before anything is asked", async () => {
  const { entry, sent, asked, deps } = replayable();
  const result = await replayRoundtrip(entry, target, { ...deps, isProduction: () => true });
  assert.match((result as { refused: string }).refused, /production system/);
  assert.equal(asked.length, 0);
  assert.equal(sent.length, 0);
});

test("a request that was not stored cannot be replayed", async () => {
  const { ring, sent, asked, deps } = replayable();
  const entry = ring.add(capture(undefined, answer("D5")))!;
  const result = await replayRoundtrip(entry, target, deps);
  assert.match((result as { refused: string }).refused, /was not stored/);
  assert.equal(asked.length + sent.length, 0);
});

test("a ring emptied while the question was open sends nothing", async () => {
  const { ring, entry, sent, deps } = replayable();
  const result = await replayRoundtrip(entry, target, {
    ...deps,
    confirm: async () => {
      ring.clear(); // the system was switched behind the dialog
      return true;
    },
  });
  assert.match((result as { refused: string }).refused, /nothing was sent/);
  assert.equal(sent.length, 0);

  const stopped = replayable();
  const refused = await replayRoundtrip(stopped.entry, target, { ...stopped.deps, proxyBase: () => undefined });
  assert.ok("refused" in refused);
});

// ---------------------------------------------------------------------------
// through the real proxy
// ---------------------------------------------------------------------------

/** A system that answers every POST with a gzip-compressed abap2UI5 answer
 *  and remembers what it was sent. */
function roundtripSystem(): Promise<{ origin: string; bodies: string[]; close(): void }> {
  const bodies: string[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(200, { "content-type": "text/plain" }).end("page");
        return;
      }
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      const wantsPlain = req.headers["accept-encoding"] === "identity";
      const text = answer(`D${++n}`, { MV_COUNT: n });
      res.writeHead(200, {
        "content-type": "application/json",
        ...(wantsPlain ? {} : { "content-encoding": "gzip" }),
      });
      res.end(wantsPlain ? text : zlib.gzipSync(text));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        bodies,
        close: () => server.close(),
      })
    );
  });
}

const post = (proxy: SapProxy, body: string) =>
  nodeRequest(`${proxy.origin}/sap/bc/z2ui5?sap-client=100`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

/** The ring is filled on the response's "end", which the client may see first. */
async function settled(proxy: SapProxy, size: number): Promise<void> {
  for (let i = 0; i < 200 && proxy.roundtrips.size < size; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(proxy.roundtrips.size, size);
}

test("the proxy keeps a roundtrip's bodies, decoded, and only POSTs", async () => {
  const system = await roundtripSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    await new Promise<void>((resolve, reject) =>
      http.get(`${proxy.origin}/sap/bc/z2ui5`, (res) => res.resume().on("end", resolve)).on("error", reject)
    );
    await post(proxy, start("Z_APP"));
    await post(proxy, event("D1", "COUNT", ["x"]));
    await settled(proxy, 2);

    const [pressed, started] = proxy.roundtrips.list();
    assert.equal(started.summary().event, "app start");
    assert.equal(pressed.summary().event, "COUNT");
    assert.equal(pressed.path, "/sap/bc/z2ui5?sap-client=100", "the system's path, never the token");
    assert.equal(pressed.requestText(), event("D1", "COUNT", ["x"]));
    assert.deepEqual(JSON.parse(pressed.responseText()!).MODEL, { MV_COUNT: 2 });
    assert.deepEqual(proxy.roundtrips.models(pressed).changes, [
      { path: "/MV_COUNT", kind: "changed", before: 1, after: 2 },
    ]);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a replay goes through the proxy and reaches the system a second time", async () => {
  const system = await roundtripSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    await post(proxy, event("D0", "SAVE", ["1"]));
    await settled(proxy, 1);
    const entry = proxy.roundtrips.list()[0];
    const result = await replayRoundtrip(entry, target, {
      isTrusted: () => true,
      isProduction: () => false,
      confirm: async () => true,
      proxyBase: () => (proxy.isRunning ? proxy.origin : undefined),
      isStored: (e) => proxy.roundtrips.get(e.seq) === e,
      request: (url, init) => nodeRequest(url, init),
    });
    assert.ok("status" in result);
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body).MODEL, { MV_COUNT: 2 });
    assert.deepEqual(system.bodies, [event("D0", "SAVE", ["1"]), event("D0", "SAVE", ["1"])]);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("the bodies are gone when the proxy stops or the system changes", async () => {
  const one = await roundtripSystem();
  const two = await roundtripSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(one.origin, "user", "pass");
    await post(proxy, start("Z_APP"));
    await settled(proxy, 1);
    let cleared = 0;
    proxy.roundtrips.onClear = () => cleared++;

    // the same system again (new credentials): the session goes on
    await proxy.start(one.origin, "user", "other");
    assert.equal(proxy.roundtrips.size, 1);

    await proxy.start(two.origin, "user", "pass");
    assert.equal(proxy.roundtrips.size, 0, "a system change empties the ring");
    assert.equal(cleared, 1);

    await post(proxy, start("Z_APP"));
    await settled(proxy, 1);
    await proxy.stop();
    assert.equal(proxy.roundtrips.size, 0, "a stop empties the ring");
  } finally {
    await proxy.stop();
    one.close();
    two.close();
  }
});

test("two profiles on one origin do not share the ring", async () => {
  const system = await roundtripSystem();
  const proxy = new SapProxy();
  let profile = "DEV client 100";
  proxy.roundtripScope = () => profile;
  try {
    await proxy.start(system.origin, "user", "pass");
    await post(proxy, start("Z_APP"));
    await post(proxy, event("D1", "A"));
    await settled(proxy, 2);
    profile = "DEV client 200";
    await post(proxy, start("Z_APP"));
    for (let i = 0; i < 200 && proxy.roundtrips.size !== 1; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(proxy.roundtrips.size, 1);
  } finally {
    await proxy.stop();
    system.close();
  }
});

test("a body larger than the cap passes through but is not kept", async () => {
  const system = await roundtripSystem();
  const proxy = new SapProxy();
  try {
    await proxy.start(system.origin, "user", "pass");
    const huge = event("D1", "UPLOAD", [], { MV_FILE: "x".repeat(BODY_CAP_BYTES + 10) });
    const res = await post(proxy, huge);
    assert.equal(res.status, 200);
    await settled(proxy, 1);
    assert.equal(system.bodies[0].length, huge.length, "the system got all of it");
    const entry = proxy.roundtrips.list()[0];
    assert.equal(entry.requestText(), undefined);
    assert.match(entry.summary().notes.join(), /not stored/);
  } finally {
    await proxy.stop();
    system.close();
  }
});
