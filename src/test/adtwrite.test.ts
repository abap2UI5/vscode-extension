import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  activationBody,
  AdtRequest,
  AdtResponse,
  classPath,
  parseLock,
  partPath,
  pushClass,
  PushRequest,
  readServerSource,
  sameSource,
} from "../adtwrite";
import {
  messagesByFile,
  parseActivationResponse,
  partFileName,
  partOfFileName,
  partOfHref,
  severityOf,
} from "../adtmessages";

/*
 * The push-and-activate sequence against a scripted system: every request
 * the client sends is recorded, every answer comes from the fixtures in
 * src/test/fixtures/adt/ (hand-written after the shapes abap-adt-api reads -
 * each fixture names the file). No network, no SAP system.
 */

const ROOT = path.join(__dirname, "..");
const FIX = path.join(ROOT, "src/test/fixtures/adt");
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), "utf8");

const BASE = "http://127.0.0.1:4711/__abap2ui5/secret";
const CLS = "ZCL_DEMO_APP";
const META = "/sap/bc/adt/oo/classes/zcl_demo_app";

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body?: string;
}

type Handler = (sent: Sent) => AdtResponse | Promise<AdtResponse>;

const answer = (status: number, body = "", headers: AdtResponse["headers"] = {}): AdtResponse => ({
  status,
  body,
  headers,
});

const SERVER_MAIN = "CLASS zcl_demo_app DEFINITION.\r\nENDCLASS.\r\nCLASS zcl_demo_app IMPLEMENTATION.\r\nENDCLASS.\r\n";
const LOCAL_MAIN_SAME = "CLASS zcl_demo_app DEFINITION.\nENDCLASS.\nCLASS zcl_demo_app IMPLEMENTATION.\nENDCLASS.\n";
const LOCAL_MAIN_NEW = "CLASS zcl_demo_app DEFINITION.\nENDCLASS.\nCLASS zcl_demo_app IMPLEMENTATION.\n* changed\nENDCLASS.\n";

/** A scripted system: the default answers plus per-test overrides keyed by
 *  "METHOD path" or "METHOD path?_action". */
function system(overrides: Record<string, Handler> = {}) {
  const sent: Sent[] = [];
  const defaults: Record<string, Handler> = {
    [`GET ${META}`]: () =>
      answer(200, fixture("class-metadata.xml"), {
        "x-csrf-token": "TOKEN123",
        "set-cookie": ["SAP_SESSIONID_A4H_001=abc; path=/", "sap-contextid=ctx1; path=/"],
      }),
    [`GET ${META}/source/main`]: () => answer(200, SERVER_MAIN),
    [`GET ${META}/includes/implementations`]: () => answer(200, "* local impl\n"),
    [`GET ${META}/includes/definitions`]: () => answer(200, ""),
    [`GET ${META}/includes/testclasses`]: () => answer(200, ""),
    [`POST ${META}?LOCK`]: () => answer(200, fixture("lock-local.xml")),
    [`PUT ${META}/source/main`]: () => answer(200),
    [`PUT ${META}/includes/implementations`]: () => answer(200),
    [`PUT ${META}/includes/testclasses`]: () => answer(200),
    [`POST ${META}?UNLOCK`]: () => answer(200),
    ["GET /sap/bc/adt/compatibility/graph"]: () => answer(200),
    ["POST /sap/bc/adt/activation"]: () => answer(200, ""),
  };
  const request: AdtRequest = async (url, init) => {
    assert.ok(url.startsWith(BASE), `sent through the proxy origin: ${url}`);
    const u = new URL(url);
    const p = u.pathname.slice(new URL(BASE).pathname.length);
    const s: Sent = { method: init.method, path: p, query: u.searchParams, headers: init.headers, body: init.body };
    sent.push(s);
    const action = u.searchParams.get("_action");
    const key = `${init.method} ${p}${action ? `?${action}` : ""}`;
    const handler = overrides[key] ?? defaults[key];
    assert.ok(handler, `unexpected request ${key}`);
    return handler(s);
  };
  const asked: string[] = [];
  return {
    sent,
    asked,
    deps: (transport?: string) => ({
      request,
      base: BASE,
      askTransport: async (q: { className: string; reason: string }) => {
        asked.push(q.reason);
        return transport;
      },
    }),
    calls: () => sent.map((s) => `${s.method} ${s.path}${s.query.get("_action") ? `?${s.query.get("_action")}` : ""}`),
  };
}

const push = (sources: PushRequest["sources"], sapClient?: string): PushRequest => ({
  className: CLS,
  sources,
  sapClient,
});

test("paths: class, source and includes, lower case and encoded", () => {
  assert.equal(classPath("ZCL_X"), "/sap/bc/adt/oo/classes/zcl_x");
  assert.equal(classPath("/NS/CL_X"), "/sap/bc/adt/oo/classes/%2Fns%2Fcl_x");
  assert.equal(partPath("ZCL_X", "main"), "/sap/bc/adt/oo/classes/zcl_x/source/main");
  assert.equal(partPath("ZCL_X", "definitions"), "/sap/bc/adt/oo/classes/zcl_x/includes/definitions");
  assert.equal(partPath("ZCL_X", "testclasses"), "/sap/bc/adt/oo/classes/zcl_x/includes/testclasses");
  const body = activationBody("zcl_x");
  assert.match(body, /<adtcore:objectReferences xmlns:adtcore="http:\/\/www.sap.com\/adt\/core">/);
  assert.match(body, /adtcore:uri="\/sap\/bc\/adt\/oo\/classes\/zcl_x" adtcore:name="ZCL_X"/);
});

test("the lock answer: handle, request, local flag", () => {
  assert.deepEqual(parseLock(fixture("lock-local.xml")), {
    lockHandle: "Q0xBU1pDTF9ERU1PX0FQUA==LOCK01",
    corrNr: "",
    isLocal: true,
  });
  assert.deepEqual(parseLock(fixture("lock-in-request.xml")), {
    lockHandle: "RQLOCK03",
    corrNr: "A4HK900123",
    isLocal: false,
  });
  assert.equal(parseLock("<asx:abap/>"), undefined);
});

test("line endings and the final newline are no difference", () => {
  assert.ok(sameSource(SERVER_MAIN, LOCAL_MAIN_SAME));
  assert.ok(!sameSource(SERVER_MAIN, LOCAL_MAIN_NEW));
});

test("success: fetch token, compare, lock, write what differs, unlock, end the session, activate", async () => {
  const sys = system();
  const result = await pushClass(
    push({ main: LOCAL_MAIN_NEW, implementations: "* local impl\n" }, "001"),
    sys.deps()
  );
  assert.equal(result.outcome, "activated");
  assert.ok("written" in result);
  assert.deepEqual(result.written, ["main"]);
  assert.deepEqual(sys.calls(), [
    `GET ${META}`,
    `GET ${META}/source/main`,
    `GET ${META}/includes/implementations`,
    `POST ${META}?LOCK`,
    `PUT ${META}/source/main`,
    `POST ${META}?UNLOCK`,
    "GET /sap/bc/adt/compatibility/graph",
    "POST /sap/bc/adt/activation",
  ]);
  const [meta, , , lock, put, unlock, drop, act] = sys.sent;
  // the token fetch and the stateful session (abap-adt-api src/AdtHTTP.ts)
  assert.equal(meta.headers["x-csrf-token"], "fetch");
  assert.equal(meta.headers["x-sap-adt-sessiontype"], "stateless");
  assert.equal(lock.headers["x-csrf-token"], "TOKEN123");
  assert.equal(lock.headers["x-sap-adt-sessiontype"], "stateful");
  assert.equal(lock.headers.cookie, "SAP_SESSIONID_A4H_001=abc; sap-contextid=ctx1");
  // lock (src/api/objectcontents.ts lock)
  assert.equal(lock.query.get("accessMode"), "MODIFY");
  assert.match(lock.headers.accept, /com\.sap\.adt\.lock\.result/);
  // the write (setObjectSource): lock handle, no corrNr for a local object
  assert.equal(put.query.get("lockHandle"), "Q0xBU1pDTF9ERU1PX0FQUA==LOCK01");
  assert.equal(put.query.has("corrNr"), false);
  assert.equal(put.headers["content-type"], "text/plain; charset=utf-8");
  assert.equal(put.body, LOCAL_MAIN_NEW);
  // sap-client on every request
  assert.ok(sys.sent.every((s) => s.query.get("sap-client") === "001"));
  assert.equal(unlock.query.get("lockHandle"), "Q0xBU1pDTF9ERU1PX0FQUA==LOCK01");
  assert.equal(drop.headers["x-sap-adt-sessiontype"], "stateless");
  assert.equal(put.headers["x-sap-adt-sessiontype"], "stateful");
  assert.equal(unlock.headers["x-sap-adt-sessiontype"], "stateful");
  assert.equal(act.headers["x-sap-adt-sessiontype"], "stateless");
  // activation (src/api/activate.ts)
  assert.equal(act.query.get("method"), "activate");
  assert.equal(act.query.get("preauditRequested"), "true");
  assert.equal(act.body, activationBody(CLS));
  assert.equal(act.headers["x-csrf-token"], "TOKEN123");
});

test("nothing differs: no lock, no write - only the activation", async () => {
  const sys = system();
  const result = await pushClass(push({ main: LOCAL_MAIN_SAME }), sys.deps());
  assert.equal(result.outcome, "activated");
  assert.ok(!sys.calls().some((c) => c.includes("LOCK") || c.startsWith("PUT")));
});

test("lock held by another user: a clear message, no PUT, no unlock of a lock never held", async () => {
  const sys = system({ [`POST ${META}?LOCK`]: () => answer(403, fixture("lock-held.xml")) });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps());
  assert.equal(result.outcome, "refused");
  assert.ok("reason" in result);
  assert.match(result.reason, /could not be locked - User OTHERUSER is currently editing ZCL_DEMO_APP/);
  assert.match(result.reason, /Nothing was written/);
  assert.ok(!sys.calls().some((c) => c.startsWith("PUT")));
  assert.ok(!sys.calls().some((c) => c.endsWith("?UNLOCK")));
  assert.ok(!sys.calls().includes("POST /sap/bc/adt/activation"));
});

test("syntax error at activation: messages mapped to the files, the lock released", async () => {
  const sys = system({
    ["POST /sap/bc/adt/activation"]: () => answer(200, fixture("activation-syntax-error.xml")),
  });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps());
  assert.equal(result.outcome, "activation-failed");
  assert.ok(sys.calls().includes(`POST ${META}?UNLOCK`));
  assert.ok(sys.calls().indexOf(`POST ${META}?UNLOCK`) < sys.calls().indexOf("POST /sap/bc/adt/activation"));
  assert.ok("activation" in result);
  const { messages } = result.activation;
  assert.deepEqual(messages, [
    { part: "main", line: 14, column: 8, severity: "error", text: 'Field "CLIENT_X" is unknown.' },
    { part: "implementations", line: 3, column: 2, severity: "warning", text: 'The variable "LV_UNUSED" is not used.' },
    { part: "main", line: 1, column: 0, severity: "error", text: "Class ZCL_DEMO_APP: Class ZCL_DEMO_APP could not be activated" },
  ]);
  const byFile = messagesByFile("/repo/src/zcl_demo_app", messages);
  assert.deepEqual([...byFile.keys()], ["/repo/src/zcl_demo_app.clas.abap", "/repo/src/zcl_demo_app.clas.locals_imp.abap"]);
  assert.equal(byFile.get("/repo/src/zcl_demo_app.clas.abap")?.length, 2);
});

test("missing class: refused before any lock", async () => {
  const sys = system({ [`GET ${META}`]: () => answer(404, "") });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps());
  assert.equal(result.outcome, "refused");
  assert.ok("reason" in result);
  assert.match(result.reason, /ZCL_DEMO_APP does not exist on the system/);
  assert.deepEqual(sys.calls(), [`GET ${META}`]);
});

test("transport required by the lock answer: asked, corrNr passed to the write", async () => {
  const sys = system({ [`POST ${META}?LOCK`]: () => answer(200, fixture("lock-transportable.xml")) });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps("A4HK900200"));
  assert.equal(result.outcome, "activated");
  assert.equal(sys.asked.length, 1);
  const put = sys.sent.find((s) => s.method === "PUT");
  assert.equal(put?.query.get("corrNr"), "A4HK900200");
  assert.equal(put?.query.get("lockHandle"), "TRLOCK02");
  assert.ok("corrNr" in result && result.corrNr === "A4HK900200");
});

test("transport required by the write: asked once, the write repeated with corrNr", async () => {
  let puts = 0;
  const sys = system({
    [`PUT ${META}/source/main`]: (s) => {
      puts++;
      return s.query.get("corrNr") ? answer(200) : answer(400, fixture("transport-required.xml"));
    },
  });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps("A4HK900201"));
  assert.equal(result.outcome, "activated");
  assert.equal(puts, 2);
  assert.match(sys.asked[0], /transport request is required/);
  assert.ok(sys.calls().includes(`POST ${META}?UNLOCK`));
});

test("transport asked and cancelled: nothing written, the lock released", async () => {
  const sys = system({ [`POST ${META}?LOCK`]: () => answer(200, fixture("lock-transportable.xml")) });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps(undefined));
  assert.equal(result.outcome, "refused");
  assert.ok(!sys.calls().some((c) => c.startsWith("PUT")));
  assert.ok(sys.calls().includes(`POST ${META}?UNLOCK`));
  assert.ok(!sys.calls().includes("POST /sap/bc/adt/activation"));
});

test("the request the lock answer names is used without asking", async () => {
  const sys = system({ [`POST ${META}?LOCK`]: () => answer(200, fixture("lock-in-request.xml")) });
  await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps(undefined));
  assert.equal(sys.asked.length, 0);
  assert.equal(sys.sent.find((s) => s.method === "PUT")?.query.get("corrNr"), "A4HK900123");
});

test("an exception between lock and unlock still unlocks, and the error leaves", async () => {
  const sys = system({
    [`PUT ${META}/source/main`]: () => {
      throw new Error("socket hang up");
    },
  });
  await assert.rejects(pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps()), /socket hang up/);
  assert.ok(sys.calls().includes(`POST ${META}?UNLOCK`));
  assert.ok(!sys.calls().includes("POST /sap/bc/adt/activation"));
});

test("a refused write fails with the system's text and still unlocks", async () => {
  const sys = system({ [`PUT ${META}/source/main`]: () => answer(500, fixture("lock-held.xml")) });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW }), sys.deps());
  assert.equal(result.outcome, "failed");
  assert.ok(sys.calls().includes(`POST ${META}?UNLOCK`));
});

test("a local test include the server lacks is created under the lock", async () => {
  const sys = system({
    [`GET ${META}/includes/testclasses`]: () => answer(404, ""),
    [`POST ${META}/includes`]: () => answer(200),
  });
  const result = await pushClass(push({ main: LOCAL_MAIN_SAME, testclasses: "CLASS ltcl DEFINITION FOR TESTING.\nENDCLASS.\n" }), sys.deps());
  assert.equal(result.outcome, "activated");
  const create = sys.sent.find((s) => s.path === `${META}/includes`);
  assert.match(create?.body ?? "", /class:includeType="testclasses"/);
  assert.equal(create?.query.get("lockHandle"), "Q0xBU1pDTF9ERU1PX0FQUA==LOCK01");
  assert.ok(sys.calls().indexOf(`POST ${META}/includes`) < sys.calls().indexOf(`PUT ${META}/includes/testclasses`));
});

test("a missing local-implementation include on the server is refused before the lock", async () => {
  const sys = system({ [`GET ${META}/includes/implementations`]: () => answer(404, "") });
  const result = await pushClass(push({ main: LOCAL_MAIN_NEW, implementations: "x" }), sys.deps());
  assert.equal(result.outcome, "refused");
  assert.ok(!sys.calls().some((c) => c.endsWith("?LOCK")));
});

test("readServerSource: the part's text, undefined for a missing include", async () => {
  const sys = system({ [`GET ${META}/includes/testclasses`]: () => answer(404, "") });
  assert.equal(await readServerSource(sys.deps(), CLS, "main"), SERVER_MAIN);
  assert.equal(await readServerSource(sys.deps(), CLS, "testclasses"), undefined);
});

// ---------------------------------------------------------------------------
// adtmessages
// ---------------------------------------------------------------------------

test("an empty activation answer is a success without messages", () => {
  assert.deepEqual(parseActivationResponse("", CLS), { success: true, messages: [], inactive: [] });
});

test("an activation that leaves the class inactive failed, even without messages", () => {
  const outcome = parseActivationResponse(fixture("activation-inactive.xml"), CLS);
  assert.equal(outcome.success, false);
  assert.deepEqual(outcome.inactive, ["ZCL_DEMO_APP"]);
});

test("warnings alone do not fail an activation", () => {
  const xml = `<chkl:messages xmlns:chkl="http://www.sap.com/abapxml/checklist"><msg type="W" href="/sap/bc/adt/oo/classes/zcl_demo_app/includes/definitions#start=2,0"><shortText><txt>w</txt></shortText></msg></chkl:messages>`;
  const outcome = parseActivationResponse(xml, CLS);
  assert.equal(outcome.success, true);
  assert.equal(outcome.messages[0].part, "definitions");
});

test("severity: E, A, X are errors, W a warning, anything else info", () => {
  assert.equal(severityOf("E"), "error");
  assert.equal(severityOf("A"), "error");
  assert.equal(severityOf("X"), "error");
  assert.equal(severityOf("W"), "warning");
  assert.equal(severityOf("I"), "info");
  assert.equal(severityOf(undefined), "info");
});

test("partOfHref: main, includes, encoded namespaces, other objects", () => {
  assert.equal(partOfHref("/sap/bc/adt/oo/classes/zcl_demo_app/source/main#start=1,0", CLS), "main");
  assert.equal(partOfHref("/sap/bc/adt/oo/classes/zcl_demo_app/includes/testclasses#start=1,0", CLS), "testclasses");
  assert.equal(partOfHref("/sap/bc/adt/oo/classes/zcl_demo_app", CLS), "main");
  assert.equal(partOfHref("/sap/bc/adt/oo/classes/%2fns%2fcl_x/includes/definitions", "/NS/CL_X"), "definitions");
  assert.equal(partOfHref("/sap/bc/adt/oo/classes/zcl_other/source/main#start=1,0", CLS), undefined);
  assert.equal(partOfHref("/sap/bc/adt/oo/classes/zcl_demo_app/includes/macros", CLS), undefined);
});

test("a position with a line only, and the line attribute as a fallback", () => {
  const xml =
    `<msg type="E" href="/sap/bc/adt/oo/classes/zcl_demo_app/source/main#start=7"><shortText><txt>a</txt></shortText></msg>` +
    `<msg type="E" line="9" href="/sap/bc/adt/oo/classes/zcl_demo_app/source/main"><shortText><txt>b</txt></shortText></msg>` +
    `<msg type="E" href="/sap/bc/adt/oo/classes/zcl_demo_app/source/main#start=3,1"/>`;
  const [a, b, c] = parseActivationResponse(xml, CLS).messages;
  assert.deepEqual([a.line, a.column], [7, 0]);
  assert.deepEqual([b.line, b.column], [9, 0]);
  assert.equal(c.text, "Syntax error");
});

test("the abapGit file of each part, and the part of each file", () => {
  assert.equal(partFileName("/r/src/zcl_a", "main"), "/r/src/zcl_a.clas.abap");
  assert.equal(partFileName("/r/src/zcl_a", "definitions"), "/r/src/zcl_a.clas.locals_def.abap");
  assert.equal(partFileName("/r/src/zcl_a", "implementations"), "/r/src/zcl_a.clas.locals_imp.abap");
  assert.equal(partFileName("/r/src/zcl_a", "testclasses"), "/r/src/zcl_a.clas.testclasses.abap");
  assert.deepEqual(partOfFileName("/r/src/zcl_a.clas.abap"), { base: "/r/src/zcl_a", part: "main" });
  assert.deepEqual(partOfFileName("/r/src/ZCL_A.CLAS.LOCALS_IMP.ABAP"), { base: "/r/src/ZCL_A", part: "implementations" });
  assert.deepEqual(partOfFileName("/r/src/zcl_a.clas.testclasses.abap"), { base: "/r/src/zcl_a", part: "testclasses" });
  assert.equal(partOfFileName("/r/src/zcl_a.clas.macros.abap"), undefined);
  assert.equal(partOfFileName("/r/src/z.prog.abap"), undefined);
});
