import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  AgentError,
  buildDelta,
  createAppClient,
  errorText,
  headerOf,
  PROTOCOL,
  validContextId,
  type FetchLike,
} from "../vendor/agent/appclient";
import {
  applyResponse,
  buildSnapshot,
  emptyState,
  nameOfPath,
  type AgentSnapshot,
  type ScreenState,
} from "../vendor/agent/snapshot";
import {
  controlName,
  describeArg,
  evalExpression,
  parseBinding,
  parseViewXml,
  parseWire,
} from "../vendor/agent/viewxml";

/*
 * The agent-snapshot code vendored from abap2UI5/mcp-server
 * (scripts/vendor-agent.mjs -> src/vendor/agent/, fixtures ->
 * src/test/fixtures/agent/).
 *
 * Two halves. The first holds the COPIES to their record: every vendored file
 * matches the sha256 `source.json` recorded when it was copied, and every
 * module's header names that commit - so a hand edit fails here, offline, in
 * CI. (Whether the record still matches upstream is
 * `npm run agent-vendor:check`, which needs the source.) The second runs the
 * vendored modules the way mcp-server's own tests do - its recorded backend
 * sessions replayed through the protocol client - so a re-vendor that breaks
 * the behaviour the extension relies on fails here too, and every
 * declaration in the hand-written `.d.ts` files is exercised against the
 * real module.
 */

const ROOT = path.join(__dirname, "..");
const RECORD = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src/vendor/agent/source.json"), "utf8")
) as {
  repository: string;
  commit: string;
  files: Record<string, { from: string; sha256: string }>;
};
const FIX = path.join(ROOT, "src/test/fixtures/agent");

interface Exchange {
  request: { S_FRONT: Record<string, unknown>; MODEL?: unknown };
  response: { S_FRONT: Record<string, unknown>; MODEL?: unknown };
}
interface Step {
  op: "start" | "act";
  arg: unknown;
  exchange?: Exchange;
}
const fixture = (name: string): { steps: Step[] } =>
  JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), "utf8"));
const FIXTURES = fs
  .readdirSync(FIX)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

// ------------------------------------------------------- the copies ----

test("every vendored file matches the hash its record holds - no hand edits", () => {
  assert.equal(RECORD.repository, "abap2UI5/mcp-server");
  assert.match(RECORD.commit, /^[0-9a-f]{40}$/);
  const files = Object.keys(RECORD.files);
  assert.ok(files.length >= 4, "three modules and at least one fixture");
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.equal(
      createHash("sha256").update(text, "utf8").digest("hex"),
      RECORD.files[file].sha256,
      `${file} was edited after vendoring - change it in ${RECORD.repository} and run ` +
        "`npm run agent-vendor` instead"
    );
  }
});

test("every vendored module names its source and commit in its header", () => {
  for (const [file, { from }] of Object.entries(RECORD.files)) {
    if (!file.endsWith(".js")) {
      continue;
    }
    const head = fs.readFileSync(path.join(ROOT, file), "utf8").slice(0, 400);
    assert.match(head, /VENDORED - do not edit/);
    assert.ok(head.includes(`${RECORD.repository} ${from}`), file);
    assert.ok(head.includes(`at commit ${RECORD.commit}`), file);
  }
});

test("the vendored folders hold nothing the record does not know", () => {
  const listed = new Set(Object.keys(RECORD.files));
  for (const dir of ["src/vendor/agent", "src/test/fixtures/agent"]) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      if (f.endsWith(".d.ts") || f === "source.json") {
        continue; // ours: the typings and the record itself
      }
      assert.ok(listed.has(`${dir}/${f}`), `${dir}/${f} is not vendored`);
    }
  }
});

// ------------------------------------------------------- the parsers ----

test("viewxml: namespaces, bindings, expressions and wires", () => {
  const root = parseViewXml(
    '<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc"><Input value="{/S/NAME}"/></mvc:View>'
  );
  const view = root.children[0];
  assert.equal(controlName(view), "sap.ui.core.mvc.View");
  assert.equal(controlName(view.children[0]), "sap.m.Input");
  assert.deepEqual(parseBinding("{/S/NAME}"), {
    kind: "path",
    path: "/S/NAME",
    model: "",
    relative: false,
  });
  assert.equal(parseBinding("{= ${/X} > 1 }").kind, "expression");
  assert.equal(
    evalExpression(
      "${/N} > 2 && ${/M} === 'A'",
      (p) => ({ "/N": 3, "/M": "A" } as Record<string, unknown>)[p]
    ),
    true
  );
  assert.equal(evalExpression("${/N}.toFixed(2)", () => 1), undefined, "no calls, no eval");
  const wire = parseWire(".eB(['SAVE'], ${NAME}, 'x')");
  assert.ok(wire && wire.fn === "eB");
  assert.equal(wire.event, "SAVE");
  assert.deepEqual(
    wire.args.map((a) => a.describe ?? a.value),
    ["$row:NAME", "x"]
  );
  assert.equal(describeArg("${$source>/text}").describe, "$source:text");
  assert.equal(nameOfPath("/XX/S_SCREEN/NAME"), "S_SCREEN-NAME");
  assert.deepEqual(buildDelta(["/T/1/Q"], { T: [{ Q: 1 }, { Q: 2 }] }), {
    T: { __delta: { 1: { Q: 2 } } },
  });
  // verbatim: the body is text/plain, a tag in it is text (protocol spec/errors.md)
  assert.equal(errorText(500, "<pre>boom</pre>"), "HTTP 500: <pre>boom</pre>");
  assert.equal(PROTOCOL, 2);
  assert.equal(headerOf({ "SAP-ContextId": ["c1"] }, "sap-contextid"), "c1");
  assert.equal(validContextId("undefined"), false);
});

// ----------------------------------------------------- the snapshot ----

const KEYS = [
  "snapshotVersion",
  "session",
  "app",
  "title",
  "layer",
  "fields",
  "actions",
  "tables",
  "messages",
  "texts",
  "unsupported",
];

function stateOf(name: string): ScreenState {
  let st = emptyState();
  for (const s of fixture(name).steps) {
    if (s.exchange) {
      st = applyResponse(st, s.exchange.response);
    }
  }
  return st;
}

test("every fixture's last screen is a snapshot v1 in the documented key order", () => {
  for (const name of FIXTURES) {
    const snap = buildSnapshot({ state: stateOf(name) });
    assert.deepEqual(Object.keys(snap), KEYS, name);
    assert.equal(snap.snapshotVersion, 1);
    assert.match(snap.session, /^[0-9A-F]{32}$/, name);
    for (const f of snap.fields) {
      assert.match(f.id, /^f\d+$/);
      assert.ok(["main", "popup", "popover"].includes(f.layer));
    }
    for (const a of snap.actions) {
      assert.match(a.id, /^a\d+$/);
      assert.ok(["screen", "row"].includes(a.scope));
    }
  }
});

// ---------------------------------------- the client, replayed sessions ----

const BASE = "http://127.0.0.1:4471/";

/** mcp-server's own replay: the fixture's exchanges answered in order, and
 *  any request that differs from the recorded one fails the test. */
function replay(name: string) {
  const exchanges = fixture(name)
    .steps.filter((s) => s.exchange)
    .map((s) => s.exchange as Exchange);
  const sent: Array<Exchange["request"]> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, BASE);
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body ?? "").value;
    sent.push(body);
    const next = exchanges[sent.length - 1];
    assert.ok(next, `request ${sent.length} was not in the recording`);
    assert.deepEqual(body, next.request, `request ${sent.length} differs from the recorded one`);
    const text = JSON.stringify(next.response);
    return { ok: true, status: 200, text: async () => text };
  };
  return { fetchImpl, sent, exchanges };
}

async function run(name: string) {
  const r = replay(name);
  const client = createAppClient({ baseUrl: BASE, fetchImpl: r.fetchImpl });
  const snaps: AgentSnapshot[] = [];
  let snap: AgentSnapshot | undefined;
  for (const step of fixture(name).steps) {
    snap =
      step.op === "start"
        ? await client.start(String(step.arg))
        : await client.act(snap!.session, step.arg as object);
    snaps.push(snap);
  }
  assert.equal(r.sent.length, r.exchanges.length, `${name}: every recorded request was sent`);
  return { client, snaps, sent: r.sent };
}

test("every recorded session replays request for request through the vendored client", async () => {
  for (const name of FIXTURES) {
    await run(name);
  }
});

test("values travel as the model delta, the popup's model with the popup's event", async () => {
  const form = await run("form-381");
  assert.deepEqual(form.sent[1].MODEL, {
    MESSAGE: "hello agent",
    DOCK_TO_ANCHOR: true,
    MY: "left top",
  });
  const table = await run("table-011");
  assert.deepEqual(table.sent[2].MODEL, {
    T_TAB: { __delta: { 0: { TITLE: "changed" }, 1: { SELKZ: true } } },
  });
  const popup = await run("popup-009");
  assert.equal(popup.snaps[1].layer, "popup");
  assert.deepEqual(popup.sent[2].MODEL, {
    T_SUGGESTION_SEL: { __delta: { 2: { SELKZ: true } } },
  });
  const closed = await run("popup-012");
  assert.equal(closed.sent.length, 4, "@CLOSE_POPUP is performed locally");
  assert.equal(closed.snaps[2].session, closed.snaps[1].session);
});

test("a selection dialog is a table and its confirm is the pick, row-valued parameters filled from `row`", async () => {
  const select = await run("select-623");
  assert.deepEqual(select.sent[3].S_FRONT.T_EVENT_ARG, ["Notebook Basic 17"]);
  const f4 = await run("cgui-f4-06");
  const dialog = f4.snaps[3].tables[0];
  assert.equal(dialog.control, "sap.m.TableSelectDialog");
  assert.equal(dialog.selectionMode, "Single");
  assert.equal(dialog.selectionField, "ZZSELKZ");
  // selectedContexts[0]/sPath is undefined in UI5's JSONModel - sent as null
  assert.deepEqual(f4.sent[4].S_FRONT.T_EVENT_ARG, [null]);
  assert.deepEqual(f4.sent[4].MODEL, {
    MR_TAB_POPUP: { "*": [{ NAME: "Berlin", WERKS: "3000", ZZSELKZ: true }] },
  });
});

test("MessagePopover and MessageView items are messages with their own source", () => {
  const popover = buildSnapshot({ state: stateOf("cgui-popover-07") });
  assert.ok(
    popover.messages.some((m) => m.source === "popover" && m.type === "warning"),
    "the popover's item"
  );
  const view = buildSnapshot({ state: stateOf("messages-452") });
  const item = view.messages.find((m) => m.source === "messageview" && m.subtitle);
  assert.ok(item, "a MessageView item with its subtitle");
  assert.equal(typeof item.description, "string");
});

test("refusals name what is allowed, and nothing goes over the wire", async () => {
  const r = replay("popup-009");
  const client = createAppClient({ baseUrl: BASE, fetchImpl: r.fetchImpl });
  const s = (await client.start("z2ui5_cl_smp_app_009")).session;
  const rejects = (p: Promise<unknown>, re: RegExp) =>
    assert.rejects(p, (e: unknown) => e instanceof AgentError && re.test(e.message));
  await rejects(client.act(s, { event: "NOPE" }), /no action 'NOPE' on this screen - allowed events: /);
  await rejects(client.act(s, { values: { NOPE: 1 } }), /no field 'NOPE' on this screen - fields you can fill: /);
  await rejects(client.act(s, { row: 1 }), /`row` belongs to an event/);
  assert.equal(r.sent.length, 1, "only the start");
  assert.throws(() => client.describe("nope"), /unknown session 'nope'/);
});
