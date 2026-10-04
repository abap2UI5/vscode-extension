import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  agentEndpoint,
  boundedInt,
  classNameOf,
  createAgentAppTools,
  createSystemTransport,
  DISABLED_MESSAGE,
  ENABLE_APP_TOOLS_KEY,
  SYSTEM_HINT,
  systemLocation,
  type AgentAppsDeps,
  type SystemRequest,
  type SystemResponse,
} from "../agentapps";
import { handleMcpMessage, type McpTool, type McpToolResult } from "../mcprpc";
import type { AgentSnapshot } from "../vendor/agent/snapshot";

/*
 * The app_* tools on a real system (agentapps.ts): the transport through the
 * auth proxy, the system selection, the safety gate - against a scripted
 * system that answers with mcp-server's recorded backend sessions (the
 * vendored src/test/fixtures/agent/). The snapshot and the client's own
 * validation are mcp-server's and tested in agentvendor.test.ts; this file
 * pins what the extension adds around them, and that a session replays here
 * with exactly the bodies the recording has - save for the start request's
 * location, which must name the SYSTEM, never the proxy.
 */

const ROOT = path.join(__dirname, "..");
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

const TEMPLATE = "https://dev.example:44300/sap/bc/z2ui5?app_start={class}&sap-client=100";
const PROXY = "http://127.0.0.1:50123/__abap2ui5/SECRETTOKEN";
const ENDPOINT_VIA_PROXY = `${PROXY}/sap/bc/z2ui5?sap-client=100`;
const LOCATION = {
  ORIGIN: "https://dev.example:44300",
  PATHNAME: "/sap/bc/z2ui5",
};

const system = (name: string, template = TEMPLATE) => ({
  name,
  launchUrlFor: (cls: string) =>
    template.replace("{class}", encodeURIComponent(cls.toUpperCase())),
});

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: { value: Exchange["request"] };
}

const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}): SystemResponse => ({
  status,
  headers,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

/** A system that answers a fixture's exchanges in order: every request has
 *  to be the recorded one, the start's location rewritten to the system's. */
function scriptedSystem(name: string) {
  const exchanges = fixture(name)
    .steps.filter((s) => s.exchange)
    .map((s) => s.exchange as Exchange);
  const sent: Sent[] = [];
  const request: SystemRequest = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ url, method: init.method, headers: init.headers, body });
    const next = exchanges[sent.length - 1];
    assert.ok(next, `request ${sent.length} was not in the recording`);
    const want = structuredClone(next.request);
    if (want.S_FRONT.ORIGIN !== undefined) {
      const cls = new URLSearchParams(String(want.S_FRONT.SEARCH)).get("app_start");
      Object.assign(want.S_FRONT, LOCATION, {
        SEARCH: `?sap-client=100&app_start=${cls}`,
      });
    }
    assert.deepEqual(body?.value, want, `request ${sent.length} differs from the recorded one`);
    return json(200, next.response);
  };
  return { request, sent, exchanges };
}

function harness(over: Partial<AgentAppsDeps> = {}) {
  const calls = { connect: 0, search: [] as string[] };
  let active: ReturnType<typeof system> | undefined = system("DEV");
  let proxyUp = true;
  const deps: AgentAppsDeps = {
    enabled: () => true,
    activeSystem: () => active,
    systemNames: () => ["DEV", "QAS"],
    connect: async () => {
      calls.connect++;
      proxyUp = true;
      return { sapClient: "100" };
    },
    proxyBase: (origin) =>
      proxyUp && origin === "https://dev.example:44300" ? PROXY : undefined,
    searchClasses: async (query) => {
      calls.search.push(query);
      return [
        { name: "Z2UI5_CL_SMP_APP_009", description: "Value help", packageName: "Z2UI5_SMP" },
        { name: "ZCL_OTHER" },
      ];
    },
    request: async () => {
      throw new Error("no request expected");
    },
    log: () => undefined,
    ...over,
  };
  const tools = createAgentAppTools(deps);
  const call = (name: string, args: Record<string, unknown>): Promise<McpToolResult> =>
    tools.find((t) => t.name === name)!.handler(args);
  return {
    tools,
    call,
    calls,
    setActive: (s: ReturnType<typeof system> | undefined) => (active = s),
    setProxy: (up: boolean) => (proxyUp = up),
  };
}

const textOf = (r: McpToolResult) => r.content[0].text ?? "";
const snapOf = (r: McpToolResult): AgentSnapshot => {
  assert.ok(!r.isError, textOf(r));
  return JSON.parse(textOf(r));
};

// ------------------------------------------------------------ the gate ----

test("switched off, every tool refuses with how to allow it - and touches nothing", async () => {
  let requested = false;
  const h = harness({
    enabled: () => false,
    request: async () => {
      requested = true;
      return json(200, {});
    },
  });
  assert.deepEqual(
    h.tools.map((t) => t.name),
    ["app_list", "app_start", "app_describe", "app_act"],
    "listed even while off - a client reads the list once per server start"
  );
  for (const [name, args] of [
    ["app_list", {}],
    ["app_start", { app: "z2ui5_cl_smp_app_009" }],
    ["app_describe", { session: "X" }],
    ["app_act", { session: "X", event: "SAVE" }],
  ] as const) {
    const r = await h.call(name, args);
    assert.equal(r.isError, true, name);
    assert.equal(textOf(r), DISABLED_MESSAGE);
  }
  assert.match(DISABLED_MESSAGE, /abap2ui5\.agent\.enableAppTools/);
  assert.equal(h.calls.connect, 0, "no credential prompt");
  assert.equal(requested, false, "nothing sent");
});

test("the setting is off by default, user/machine scope, and restricted in untrusted workspaces", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const key = `abap2ui5.${ENABLE_APP_TOOLS_KEY}`;
  const setting = pkg.contributes.configuration.properties[key];
  assert.ok(setting, key);
  assert.equal(setting.default, false);
  assert.equal(setting.scope, "machine", "a cloned repository must not be able to switch it on");
  assert.ok(
    pkg.capabilities.untrustedWorkspaces.restrictedConfigurations.includes(key)
  );
});

test("every tool that acts says that it acts for real", () => {
  const h = harness();
  for (const name of ["app_list", "app_start", "app_act"]) {
    const description = h.tools.find((t) => t.name === name)!.description;
    assert.match(description, /FOR REAL on the active SAP system as the configured user/, name);
  }
});

// ------------------------------------------------------ the protocol ----

test("a recorded session replays through the proxy, with the system's location in the start", async () => {
  const sys = scriptedSystem("popup-009");
  const h = harness({ request: sys.request });
  const steps = fixture("popup-009").steps;
  let snap = snapOf(await h.call("app_start", { app: steps[0].arg }));
  for (const step of steps.slice(1)) {
    snap = snapOf(await h.call("app_act", { session: snap.session, ...(step.arg as object) }));
  }
  assert.equal(sys.sent.length, sys.exchanges.length, "every recorded request was sent");
  for (const s of sys.sent) {
    assert.equal(s.url, ENDPOINT_VIA_PROXY, "the endpoint, through the proxy, no class");
    assert.equal(s.method, "POST");
    assert.equal(s.headers["content-type"], "application/json");
    assert.equal(s.headers["sap-contextid-accept"], "header");
    assert.equal(s.headers.authorization, undefined, "the proxy injects credentials, not this");
  }
  const start = sys.sent[0].body!.value.S_FRONT;
  assert.equal(start.ORIGIN, "https://dev.example:44300");
  assert.ok(
    sys.sent.every((s) => !JSON.stringify(s.body).includes("SECRETTOKEN")),
    "the proxy token never reaches the backend"
  );
  assert.equal(snap.snapshotVersion, 1);
  assert.equal(h.calls.connect, 0, "the proxy already forwarded to DEV - no connect");
  // app_describe answers from memory
  const described = snapOf(await h.call("app_describe", { session: snap.session }));
  assert.equal(described.session, snap.session);
  assert.equal(sys.sent.length, sys.exchanges.length, "describe sends nothing");
});

test("refusals are the client's, and nothing is sent", async () => {
  const sys = scriptedSystem("popup-009");
  const h = harness({ request: sys.request });
  const start = snapOf(await h.call("app_start", { app: "z2ui5_cl_smp_app_009" }));
  const r = await h.call("app_act", { session: start.session, event: "NOPE" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /no action 'NOPE' on this screen - allowed events: /);
  const unknown = await h.call("app_describe", { session: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown session 'nope' - start one with app_start/);
  const unknownAct = await h.call("app_act", { session: "nope", event: "X" });
  assert.match(textOf(unknownAct), /unknown session 'nope'/);
  assert.equal(sys.sent.length, 1, "only the start went out");
});

test("a fresh server with no session at all still answers in the client's words", async () => {
  const h = harness();
  const r = await h.call("app_describe", { session: "ABC" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /unknown session 'ABC' - start one with app_start/);
  assert.equal(h.calls.connect, 0);
});

test("argument checks are mcp-server's: class name, max_rows", async () => {
  const h = harness();
  const answer = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "app_start", arguments: { app: "../src/x" } } },
    h.tools as McpTool[],
    { name: "t", version: "0" }
  )) as { result: McpToolResult };
  assert.equal(answer.result.isError, true);
  assert.match(textOf(answer.result), /invalid class name '\.\.\/src\/x'/);
  assert.equal(classNameOf("Z2UI5_CL_SMP_APP_009"), "z2ui5_cl_smp_app_009");
  assert.equal(classNameOf("/ABC/CL_APP"), "/abc/cl_app", "a namespaced class - only a real system has one");
  assert.throws(() => classNameOf("cl_app"), /customer namespace/);
  assert.throws(() => classNameOf(`z${"x".repeat(30)}`), /<= 30 chars/);
  assert.equal(boundedInt(undefined, { name: "max_rows", dflt: 20, min: 0, max: 200 }), 20);
  assert.equal(boundedInt("500", { name: "max_rows", dflt: 20, min: 0, max: 200 }), 200);
  assert.throws(
    () => boundedInt("lots", { name: "max_rows", dflt: 20, min: 0, max: 200 }),
    /max_rows must be a number, not 'lots' — leaving it out means 20/
  );
  assert.equal(h.calls.connect, 0, "refused before any system contact");
});

test("a system that cannot be reached is said in the extension's words", async () => {
  const h = harness({
    request: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:50123");
    },
  });
  const r = await h.call("app_start", { app: "zcl_app" });
  assert.equal(r.isError, true);
  assert.match(
    textOf(r),
    /the backend did not answer \(connect ECONNREFUSED 127\.0\.0\.1:50123\) - is the system reachable\? "abap2UI5: Check System Connection" says/
  );
  assert.doesNotMatch(textOf(r), /backend \{ action/);
  assert.equal(SYSTEM_HINT, 'is the system reachable? "abap2UI5: Check System Connection" says');
});

test("a backend error is the refusal, with the backend's text verbatim", async () => {
  const h = harness({
    request: async () => json(500, "Class ZCL_APP does not implement z2ui5_if_app\nurl /sap/bc/z2ui5?app_start=<b>x</b>"),
  });
  const r = await h.call("app_start", { app: "zcl_app" });
  assert.equal(r.isError, true);
  assert.match(
    textOf(r),
    /the backend refused the roundtrip - HTTP 500: Class ZCL_APP does not implement z2ui5_if_app\nurl \/sap\/bc\/z2ui5\?app_start=<b>x<\/b>/,
    "a tag in the text/plain body is text (protocol spec/errors.md)"
  );
});

// ----------------------------------------------------- the system ----

test("`system` must name the active system - the tools never switch", async () => {
  const h = harness();
  const unknown = await h.call("app_start", { app: "zcl_app", system: "PRD" });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /no configured system 'PRD' - configured: 'DEV', 'QAS'/);
  const other = await h.call("app_list", { system: "QAS" });
  assert.equal(other.isError, true);
  assert.match(textOf(other), /system 'QAS' is not the active system \('DEV'\) - the app tools act on the active system only/);
  assert.equal(h.calls.connect, 0, "refused before any prompt");
});

test("the user backing out of the picker is an error result, not a hang", async () => {
  const h = harness({ connect: async () => undefined });
  h.setProxy(false);
  const r = await h.call("app_list", {});
  assert.equal(r.isError, true);
  assert.match(textOf(r), /cancelled the system\/credential picker/);
});

test("a session started on DEV is refused once the active system is another", async () => {
  const sys = scriptedSystem("table-011");
  const h = harness({ request: sys.request });
  const start = snapOf(await h.call("app_start", { app: "z2ui5_cl_smp_app_011" }));
  h.setActive(system("QAS", "https://qas.example/sap/bc/z2ui5?app_start={class}"));
  const r = await h.call("app_act", { session: start.session, event: "BUTTON_EDIT" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), new RegExp(`session '${start.session}' runs on system 'DEV', but the active system is 'QAS'`));
  assert.equal(sys.sent.length, 1, "nothing sent to QAS - or to DEV");
  // describing is memory only, and stays possible
  assert.equal(snapOf(await h.call("app_describe", { session: start.session })).session, start.session);
  // back on DEV the session continues
  h.setActive(system("DEV"));
  snapOf(await h.call("app_act", { session: start.session, event: "BUTTON_EDIT" }));
  assert.equal(sys.sent.length, 2);
});

test("an act connects first only when the proxy does not forward to the session's system", async () => {
  const sys = scriptedSystem("table-011");
  const h = harness({ request: sys.request });
  const start = snapOf(await h.call("app_start", { app: "z2ui5_cl_smp_app_011" }));
  h.setProxy(false);
  snapOf(await h.call("app_act", { session: start.session, event: "BUTTON_EDIT" }));
  assert.equal(h.calls.connect, 1);
});

test("app_list: the ADT name search, in app_list's shape", async () => {
  const h = harness();
  const r = await h.call("app_list", { filter: "z2ui5_cl_smp" });
  const list = JSON.parse(textOf(r));
  assert.equal(list.system, "DEV");
  assert.equal(list.count, 2);
  assert.deepEqual(list.apps[0], {
    app: "Z2UI5_CL_SMP_APP_009",
    source: "system",
    description: "Value help",
    package: "Z2UI5_SMP",
  });
  assert.deepEqual(list.apps[1], { app: "ZCL_OTHER", source: "system" });
  assert.match(list.hint, /app_start \{ app \}/);
  await h.call("app_list", {});
  assert.deepEqual(h.calls.search, ["z2ui5_cl_smp", "Z"], "no filter searches the customer namespace");
});

// --------------------------------------------------- the endpoint ----

test("agentEndpoint: the launch URL minus the class parameter and the hash", () => {
  assert.deepEqual(
    agentEndpoint("https://h:44300/sap/bc/z2ui5?app_start=Z2UI5_AGENT_PROBE&sap-client=100&sap-language=EN#/x"),
    { endpoint: "https://h:44300/sap/bc/z2ui5?sap-client=100&sap-language=EN" }
  );
  assert.deepEqual(agentEndpoint("https://h/sap/bc/z2ui5?app_start=zcl_x", "ZCL_X"), {
    endpoint: "https://h/sap/bc/z2ui5",
  });
  const inPath = agentEndpoint("https://h/sap/bc/Z2UI5_AGENT_PROBE/index.html");
  assert.ok("problem" in inPath);
  assert.match(inPath.problem, /puts \{class\} into the path/);
  assert.ok("problem" in agentEndpoint("not a url"));
});

test("a launch URL with the class in its path is refused by the start's location, before anything is sent", async () => {
  const h = harness();
  h.setActive(system("DEV", "https://dev.example:44300/sap/bc/{class}/index.html?sap-client=100"));
  const r = await h.call("app_start", { app: "zcl_app" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^the launch URL template puts \{class\} into the path/);
});

// --------------------------------------------------- the transport ----

const START_BODY = JSON.stringify({
  value: { S_FRONT: { ORIGIN: "https://dev.example", PATHNAME: "/sap/bc/z2ui5", SEARCH: "?app_start=zcl_app" } },
});
const EVENT_BODY = (id: string) =>
  JSON.stringify({ value: { S_FRONT: { ID: id, EVENT: "SAVE" } } });
/** One roundtrip as the vendored client hands it to its `transport`. */
const ROUNDTRIP = (body: string, draftId: string | null = null) => ({
  body,
  headers: { "content-type": "application/json", "sap-contextid-accept": "header" },
  signal: AbortSignal.timeout(10_000),
  draftId,
});

test("transport: one request per call, sent as the client built it, with the system's cookies", async () => {
  const sent: Array<Sent & { rawBody?: string }> = [];
  const answers: SystemResponse[] = [
    json(403, "CSRF token validation failed", {
      "x-csrf-token": "Required",
      "set-cookie": ["SAP_SESSIONID_DEV_100=s1; path=/", "__abap2ui5_proxy_50123=tok; Path=/"],
    }),
    json(200, "", { "x-csrf-token": "TOKEN123", "set-cookie": ["sap-XSRF_DEV=abc; path=/; HttpOnly"] }),
    json(200, { S_FRONT: { ID: "D1" } }, { "sap-contextid": "CTX-A", "set-cookie": "sap-XSRF_DEV=; Max-Age=0" }),
  ];
  const transport = createSystemTransport({
    endpoint: () => "https://dev.example:44300/sap/bc/z2ui5?sap-client=100",
    proxyBase: () => PROXY,
    request: async (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers, rawBody: init.body });
      return answers.shift()!;
    },
  });
  // a refusal comes back as it is - the handshake is the client's
  const refused = await transport(ROUNDTRIP(START_BODY));
  assert.equal(refused.status, 403);
  assert.equal(refused.headers?.["x-csrf-token"], "Required");
  assert.equal(sent.length, 1, "no token fetch, no re-send of its own");
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].rawBody, START_BODY);
  // the client's HEAD goes out as a HEAD, without a body, with the cookies
  const head = await transport({ method: "HEAD", headers: { "x-csrf-token": "Fetch" }, signal: AbortSignal.timeout(10_000), draftId: null });
  assert.equal(head.headers?.["x-csrf-token"], "TOKEN123", "the answer's headers reach the client");
  assert.equal(sent[1].method, "HEAD");
  assert.equal(sent[1].rawBody, undefined);
  assert.deepEqual(sent[1].headers, { "x-csrf-token": "Fetch", cookie: "SAP_SESSIONID_DEV_100=s1" }, "the proxy's own cookie is not kept");
  // the client's token and session id are carried as given
  const ok = await transport({
    ...ROUNDTRIP(EVENT_BODY("D0"), "D0"),
    headers: { ...ROUNDTRIP("").headers, "x-csrf-token": "TOKEN123", "sap-contextid": "CTX-0" },
  });
  assert.equal(ok.headers?.["sap-contextid"], "CTX-A");
  assert.deepEqual(sent[2].headers, {
    "content-type": "application/json",
    "sap-contextid-accept": "header",
    "x-csrf-token": "TOKEN123",
    "sap-contextid": "CTX-0",
    cookie: "SAP_SESSIONID_DEV_100=s1; sap-XSRF_DEV=abc",
  });
  // an expired cookie is dropped
  answers.push(json(200, { S_FRONT: { ID: "D2" } }));
  await transport(ROUNDTRIP(EVENT_BODY("D1"), "D1"));
  assert.equal(sent[3].headers.cookie, "SAP_SESSIONID_DEV_100=s1");
});

test("the client's handshakes through the transport: one token fetch, one re-send, the session id per session", async () => {
  const sent: Sent[] = [];
  let token = "";
  let posts = 0;
  const h = harness({
    request: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      sent.push({ url, method: init.method, headers: init.headers, body });
      if (init.method === "HEAD") {
        token = "TOKEN123";
        return json(200, "", { "x-csrf-token": token, "set-cookie": ["sap-XSRF_DEV=abc; path=/"] });
      }
      if (init.headers["x-csrf-token"] !== token || !token) {
        return json(403, "CSRF token validation failed", { "x-csrf-token": "Required", "set-cookie": ["SAP_SESSIONID_DEV_100=s1; path=/"] });
      }
      posts++;
      const view = '<mvc:View xmlns="sap.m" xmlns:mvc="sap.ui.core.mvc"><Page title="T"><Button text="Go" press=".eB([\'GO\'])"/></Page></mvc:View>';
      const start = !body.value.S_FRONT.ID;
      return json(
        200,
        start
          ? { S_FRONT: { ID: `D${posts}`, APP: "ZCL_APP", PROTOCOL: 2, S_ACTION: { T_SYSTEM: [["VIEW_SLOTS", "display", "MAIN", view]] } } }
          : { S_FRONT: { ID: `D${posts}`, APP: "ZCL_APP", PROTOCOL: 2 } },
        start && posts === 1 ? { "sap-contextid": "CTX-A" } : {}
      );
    },
  });
  let snap = snapOf(await h.call("app_start", { app: "zcl_app" }));
  assert.deepEqual(sent.map((s) => s.method), ["POST", "HEAD", "POST"], "one token fetch, one re-send - not two of each");
  assert.deepEqual(sent[2].body, sent[0].body, "the same body once more");
  assert.equal(sent[2].headers["x-csrf-token"], "TOKEN123");
  assert.equal(sent[2].headers.cookie, "SAP_SESSIONID_DEV_100=s1; sap-XSRF_DEV=abc", "the token's session cookie goes with it");
  snap = snapOf(await h.call("app_act", { session: snap.session, event: "GO" }));
  await h.call("app_act", { session: snap.session, event: "GO" });
  assert.equal(sent.length, 5, "no more fetches while the token is accepted");
  assert.deepEqual(sent.slice(3).map((s) => [s.headers["x-csrf-token"], s.headers["sap-contextid"]]), [
    ["TOKEN123", "CTX-A"],
    ["TOKEN123", "CTX-A"],
  ], "the token with every POST, the session id kept through an answer without it");
  // another session of the same system starts without the first one's id
  await h.call("app_start", { app: "zcl_app" });
  assert.equal(sent[5].headers["sap-contextid"], undefined);
  assert.equal(sent[5].headers["x-csrf-token"], "TOKEN123", "the token is the system's, not the session's");
});

test("location: the start names the system's endpoint and the class, never the proxy", () => {
  assert.deepEqual(
    systemLocation("https://dev.example:44300/sap/bc/z2ui5?sap-client=100&sap-language=DE", "zcl_app"),
    {
      origin: "https://dev.example:44300",
      pathname: "/sap/bc/z2ui5",
      search: "?sap-client=100&sap-language=DE&app_start=zcl_app",
    }
  );
  assert.deepEqual(systemLocation("https://dev.example/sap/bc/z2ui5", "/abc/cl_app"), {
    origin: "https://dev.example",
    pathname: "/sap/bc/z2ui5",
    search: "?app_start=%2Fabc%2Fcl_app",
  });
});

test("transport: the body goes out as the client built it; no proxy, no request", async () => {
  let body = "";
  const transport = createSystemTransport({
    endpoint: () => "https://dev.example:44300/sap/bc/z2ui5?sap-client=100",
    proxyBase: () => PROXY,
    request: async (_url, init) => {
      body = init.body ?? "";
      return json(200, { S_FRONT: { ID: "D1" } });
    },
  });
  await transport(ROUNDTRIP(START_BODY));
  assert.equal(body, START_BODY);
  const offline = createSystemTransport({
    endpoint: () => "https://dev.example/sap/bc/z2ui5",
    proxyBase: () => undefined,
    request: async () => {
      throw new Error("must not be called");
    },
  });
  await assert.rejects(offline(ROUNDTRIP(START_BODY)), /auth proxy is not connected to dev\.example/);
});

// ------------------------------------------- end to end, real proxy ----

test("end to end: the real auth proxy and node http carry a recorded session to the system, with the client's handshakes", async () => {
  const http = require("http") as typeof import("http");
  const { SapProxy } = require("../proxy") as typeof import("../proxy");
  const exchanges = fixture("form-381")
    .steps.filter((s) => s.exchange)
    .map((s) => s.exchange as Exchange);
  const seen: Array<{ url: string; auth?: string; origin?: string; body: { value: Exchange["request"] } }> = [];
  const handshake: Array<{ method: string; csrf?: string; context?: string }> = [];
  // a token layer in front of the system, and a stateful app: the first
  // POST is refused for want of a token, the first answer hands out a session id
  const backend = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const csrf = req.headers["x-csrf-token"] as string | undefined;
      handshake.push({ method: String(req.method), csrf, context: req.headers["sap-contextid"] as string | undefined });
      if (req.method === "HEAD") {
        res.writeHead(200, { "x-csrf-token": csrf === "Fetch" ? "T1" : "" });
        res.end();
        return;
      }
      if (csrf !== "T1") {
        res.writeHead(403, { "content-type": "text/plain", "x-csrf-token": "Required" });
        res.end("CSRF token validation failed");
        return;
      }
      seen.push({
        url: String(req.url),
        auth: req.headers.authorization,
        origin: req.headers.origin,
        body: JSON.parse(body),
      });
      const next = exchanges[seen.length - 1];
      res.writeHead(200, {
        "content-type": "application/json",
        ...(seen.length === 1 ? { "sap-contextid": "SID:ANON:e2e" } : {}),
      });
      res.end(JSON.stringify(next.response));
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const port = (backend.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const proxy = new SapProxy();
  try {
    await proxy.start(origin, "agent-user", "s3cret");
    const tools = createAgentAppTools({
      enabled: () => true,
      activeSystem: () => ({
        name: "LOCAL",
        launchUrlFor: (cls) => `${origin}/sap/bc/z2ui5?app_start=${cls}&sap-client=001`,
      }),
      systemNames: () => ["LOCAL"],
      connect: async () => ({ sapClient: "001" }),
      proxyBase: (o) => (proxy.isRunning && proxy.systemOrigin === o ? proxy.origin : undefined),
      searchClasses: async () => [],
      log: () => undefined,
    });
    const call = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.handler(args);
    const steps = fixture("form-381").steps;
    let snap = snapOf(await call("app_start", { app: steps[0].arg }));
    for (const step of steps.slice(1)) {
      snap = snapOf(await call("app_act", { session: snap.session, ...(step.arg as object) }));
    }
    assert.equal(seen.length, exchanges.length);
    assert.deepEqual(
      handshake.map((x) => [x.method, x.csrf ?? null, x.context ?? null]),
      [
        ["POST", null, null],
        ["HEAD", "Fetch", null],
        ["POST", "T1", null],
        ...exchanges.slice(1).map(() => ["POST", "T1", "SID:ANON:e2e"]),
      ],
      "through the proxy: one token fetch and re-send, then the token and the session id with every POST"
    );
    for (const [i, s] of seen.entries()) {
      assert.equal(s.url, "/sap/bc/z2ui5?sap-client=001", "the endpoint, the proxy prefix gone");
      assert.equal(
        s.auth,
        `Basic ${Buffer.from("agent-user:s3cret").toString("base64")}`,
        "the proxy injected the credentials"
      );
      assert.equal(s.origin, undefined, "no Origin - the backend's CSRF gate lets it pass");
      const want = structuredClone(exchanges[i].request);
      if (want.S_FRONT.ORIGIN !== undefined) {
        Object.assign(want.S_FRONT, {
          ORIGIN: origin,
          PATHNAME: "/sap/bc/z2ui5",
          SEARCH: `?sap-client=001&app_start=${steps[0].arg}`,
        });
      }
      assert.deepEqual(s.body.value, want, `request ${i + 1}`);
    }
  } finally {
    await proxy.stop();
    backend.close();
  }
});
