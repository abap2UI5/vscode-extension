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
  systemMessage,
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
  assert.equal(
    systemMessage('x - is it running? backend { action: "status" } says'),
    'x - is the system reachable? "abap2UI5: Check System Connection" says'
  );
});

test("a backend error page is the refusal, with the backend's text", async () => {
  const h = harness({
    request: async () => json(500, "<html><pre>Class ZCL_APP does not implement z2ui5_if_app</pre></html>"),
  });
  const r = await h.call("app_start", { app: "zcl_app" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /the backend refused the roundtrip - HTTP 500: Class ZCL_APP does not implement z2ui5_if_app/);
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

// --------------------------------------------------- the transport ----

const START_BODY = JSON.stringify({
  value: { S_FRONT: { ORIGIN: "http://x", PATHNAME: "/", SEARCH: "?app_start=zcl_app" } },
});
const EVENT_BODY = (id: string) =>
  JSON.stringify({ value: { S_FRONT: { ID: id, EVENT: "SAVE" } } });
const INIT = (body: string) => ({
  method: "POST",
  headers: { "content-type": "application/json", "sap-contextid-accept": "header" },
  body,
});

test("transport: a CSRF token layer is answered with HEAD + Fetch and ONE re-send", async () => {
  const sent: Sent[] = [];
  let posts = 0;
  const fetchImpl = createSystemTransport({
    endpoint: () => "https://dev.example:44300/sap/bc/z2ui5?sap-client=100",
    proxyBase: () => PROXY,
    request: async (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers });
      if (init.method === "HEAD") {
        return json(200, "", { "x-csrf-token": "TOKEN123", "set-cookie": ["sap-XSRF_DEV=abc; path=/; HttpOnly"] });
      }
      posts++;
      return posts === 1
        ? json(403, "CSRF token validation failed", {
            "x-csrf-token": "Required",
            "set-cookie": ["SAP_SESSIONID_DEV_100=s1; path=/", "__abap2ui5_proxy_50123=tok; Path=/"],
          })
        : json(200, { S_FRONT: { ID: "D1" } });
    },
  });
  const res = await fetchImpl("ignored", INIT(START_BODY));
  assert.equal(res.ok, true);
  assert.deepEqual(sent.map((s) => s.method), ["POST", "HEAD", "POST"]);
  assert.equal(sent[1].headers["x-csrf-token"], "Fetch");
  assert.equal(sent[1].headers.cookie, "SAP_SESSIONID_DEV_100=s1", "the proxy's own cookie is not kept");
  assert.equal(sent[2].headers["x-csrf-token"], "TOKEN123");
  assert.equal(sent[2].headers.cookie, "SAP_SESSIONID_DEV_100=s1; sap-XSRF_DEV=abc");
  // a layer that keeps refusing ends in its refusal, not in a loop
  const refusing = createSystemTransport({
    endpoint: () => "https://dev.example/sap/bc/z2ui5",
    proxyBase: () => PROXY,
    request: async (_url, init) =>
      init.method === "HEAD" ? json(200, "", {}) : json(403, "no", { "x-csrf-token": "Required" }),
  });
  const refused = await refusing("ignored", INIT(START_BODY));
  assert.equal(refused.status, 403);
});

test("transport: a stateful session's sap-contextid follows its own draft ids", async () => {
  const sent: Sent[] = [];
  const answers: SystemResponse[] = [
    json(200, { S_FRONT: { ID: "D1" } }, { "sap-contextid": "CTX-A" }),
    json(200, { S_FRONT: { ID: "D2" } }),
    json(200, { S_FRONT: { ID: "E1" } }),
  ];
  const fetchImpl = createSystemTransport({
    endpoint: () => "https://dev.example/sap/bc/z2ui5",
    proxyBase: () => PROXY,
    request: async (url, init) => {
      sent.push({ url, method: init.method, headers: init.headers });
      return answers.shift()!;
    },
  });
  await fetchImpl("ignored", INIT(START_BODY));
  await fetchImpl("ignored", INIT(EVENT_BODY("D1")));
  await fetchImpl("ignored", INIT(EVENT_BODY("D2")));
  assert.equal(sent[0].headers["sap-contextid"], undefined, "a start has no session yet");
  assert.equal(sent[1].headers["sap-contextid"], "CTX-A");
  assert.equal(sent[2].headers["sap-contextid"], "CTX-A", "inherited by the next draft of the same session");
});

test("transport: the start's location is the system's endpoint; no proxy, no request", async () => {
  let body = "";
  const fetchImpl = createSystemTransport({
    endpoint: () => "https://dev.example:44300/sap/bc/z2ui5?sap-client=100&sap-language=DE",
    proxyBase: () => PROXY,
    request: async (_url, init) => {
      body = init.body ?? "";
      return json(200, { S_FRONT: { ID: "D1" } });
    },
  });
  await fetchImpl("ignored", INIT(START_BODY));
  assert.deepEqual(JSON.parse(body).value.S_FRONT, {
    ORIGIN: "https://dev.example:44300",
    PATHNAME: "/sap/bc/z2ui5",
    SEARCH: "?sap-client=100&sap-language=DE&app_start=zcl_app",
  });
  const offline = createSystemTransport({
    endpoint: () => "https://dev.example/sap/bc/z2ui5",
    proxyBase: () => undefined,
    request: async () => {
      throw new Error("must not be called");
    },
  });
  await assert.rejects(offline("ignored", INIT(START_BODY)), /auth proxy is not connected to dev\.example/);
});

// ------------------------------------------- end to end, real proxy ----

test("end to end: the real auth proxy and node http carry a recorded session to the system", async () => {
  const http = require("http") as typeof import("http");
  const { SapProxy } = require("../proxy") as typeof import("../proxy");
  const exchanges = fixture("form-381")
    .steps.filter((s) => s.exchange)
    .map((s) => s.exchange as Exchange);
  const seen: Array<{ url: string; auth?: string; origin?: string; body: { value: Exchange["request"] } }> = [];
  const backend = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        url: String(req.url),
        auth: req.headers.authorization,
        origin: req.headers.origin,
        body: JSON.parse(body),
      });
      const next = exchanges[seen.length - 1];
      res.writeHead(200, { "content-type": "application/json" });
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
