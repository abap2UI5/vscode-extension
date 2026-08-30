import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleMcpBatch,
  handleMcpMessage,
  McpTool,
  schemaProblem,
  textResult,
} from "../mcprpc";

const INFO = { name: "abap2UI5 System", version: "1.0.0" };

const TOOLS: McpTool[] = [
  {
    name: "echo",
    description: "echoes",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    handler: async (args) => textResult(`echo: ${String(args.text)}`),
  },
  {
    name: "boom",
    description: "throws",
    inputSchema: { type: "object" },
    handler: async () => {
      throw new Error("kaputt");
    },
  },
];

test("initialize answers a revision it implements", async () => {
  const res = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    },
    TOOLS,
    INFO
  )) as { result: { protocolVersion: string; serverInfo: object } };
  assert.equal(res.result.protocolVersion, "2025-06-18");
  assert.deepEqual(res.result.serverInfo, INFO);
});

test("notifications get no response", async () => {
  assert.equal(
    await handleMcpMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      TOOLS,
      INFO
    ),
    undefined
  );
});

test("tools/list carries name, description and schema", async () => {
  const res = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    TOOLS,
    INFO
  )) as { result: { tools: Array<{ name: string; handler?: unknown }> } };
  assert.deepEqual(
    res.result.tools.map((t) => t.name),
    ["echo", "boom"]
  );
  assert.equal(res.result.tools[0].handler, undefined); // never leaks
});

test("tools/call runs the handler", async () => {
  const res = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hi" } },
    },
    TOOLS,
    INFO
  )) as { result: { content: Array<{ text: string }> } };
  assert.equal(res.result.content[0].text, "echo: hi");
});

test("a throwing tool becomes an isError result, not a protocol error", async () => {
  const res = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    },
    TOOLS,
    INFO
  )) as { result: { isError?: boolean; content: Array<{ text: string }> } };
  assert.equal(res.result.isError, true);
  assert.equal(res.result.content[0].text, "kaputt");
});

test("a tools/call without a name says so, not 'unknown tool: undefined'", async () => {
  const res = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { arguments: {} } },
    TOOLS,
    INFO
  )) as { error: { code: number; message: string } };
  assert.equal(res.error.code, -32602);
  assert.equal(res.error.message, "tool name is required");
});

test("unknown tools and methods answer JSON-RPC errors", async () => {
  const unknownTool = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } },
    TOOLS,
    INFO
  )) as { error: { code: number } };
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 6, method: "resources/list" },
    TOOLS,
    INFO
  )) as { error: { code: number } };
  assert.equal(unknownMethod.error.code, -32601);
});

test("a method that is not a string is a -32600, not a crash", async () => {
  // `method.startsWith(...)` threw on this, and the rejection travelled out
  // through the host's Promise.all: the whole request - a batch's valid
  // siblings included - was answered with a bodyless 500.
  for (const method of [5, null, {}, ["tools/list"], true]) {
    const res = (await handleMcpMessage(
      { jsonrpc: "2.0", id: 8, method },
      TOOLS,
      INFO
    )) as { error: { code: number; message: string } };
    assert.equal(res.error.code, -32600, `method ${JSON.stringify(method)}`);
    assert.equal(res.error.message, "not a JSON-RPC request");
  }
});

test("one broken message in a batch cannot take the batch down", async () => {
  // a tool whose name cannot even be read: tools/list throws while mapping it,
  // which is the shape of any bug inside the dispatch
  const exploding: McpTool = {
    get name(): string {
      throw new Error("boom");
    },
    description: "unreadable",
    inputSchema: { type: "object" },
    handler: async () => textResult("never"),
  };
  const logged: string[] = [];
  const answers = (await handleMcpBatch(
    [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ],
    [exploding],
    INFO,
    (m) => logged.push(m)
  )) as Array<{ id: number; error?: { code: number }; result?: object }>;
  assert.equal(answers.length, 2);
  assert.equal(answers[0].id, 1);
  assert.equal(answers[0].error?.code, -32603);
  assert.equal(answers[1].id, 2);
  assert.deepEqual(answers[1].result, {}); // the sibling still got its answer
  assert.equal(logged.length, 1);
});

test("a batch drops the notifications and keeps the order", async () => {
  const answers = (await handleMcpBatch(
    [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ],
    TOOLS,
    INFO
  )) as Array<{ id: number }>;
  assert.deepEqual(
    answers.map((a) => a.id),
    [2]
  );
});

test("the schema decides required, type and enum", () => {
  const schema = {
    type: "object",
    properties: {
      class: { type: "string" },
      viewport: { type: "string", enum: ["desktop", "tablet", "phone"] },
    },
    required: ["class"],
  };
  assert.equal(schemaProblem(schema, { class: "ZCL_APP" }), undefined);
  assert.equal(
    schemaProblem(schema, { class: "ZCL_APP", viewport: "tablet" }),
    undefined
  );
  assert.equal(schemaProblem(schema, {}), "class is required");
  assert.equal(
    schemaProblem(schema, { class: 42 }),
    "class must be a string, got number"
  );
  assert.equal(
    schemaProblem(schema, { class: "ZCL_APP", viewport: "watch" }),
    "viewport must be one of: desktop, tablet, phone"
  );
  // an absent optional is not a problem, and a schema without either keyword
  // accepts everything - a tool taking no arguments must stay callable
  assert.equal(schemaProblem({ type: "object", properties: {} }, {}), undefined);
  assert.equal(schemaProblem(undefined, { anything: 1 }), undefined);
});

test("tools/call validates the arguments against the tool's own schema", async () => {
  const strict: McpTool[] = [
    {
      name: "run",
      description: "runs",
      inputSchema: {
        type: "object",
        properties: {
          class: { type: "string" },
          viewport: { type: "string", enum: ["desktop", "phone"] },
        },
        required: ["class"],
      },
      handler: async (args) => textResult(`ran ${String(args.class)}`),
    },
  ];
  const missing = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "run" } },
    strict,
    INFO
  )) as { error: { code: number; message: string } };
  assert.equal(missing.error.code, -32602);
  assert.equal(missing.error.message, "run: class is required");

  const wrongEnum = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "run", arguments: { class: "ZCL_A", viewport: "watch" } },
    },
    strict,
    INFO
  )) as { error: { code: number; message: string } };
  assert.equal(wrongEnum.error.code, -32602);
  assert.match(wrongEnum.error.message, /^run: viewport must be one of/);

  const notAnObject = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "run", arguments: "ZCL_A" },
    },
    strict,
    INFO
  )) as { error: { code: number; message: string } };
  assert.equal(notAnObject.error.message, "run: arguments must be an object");

  const good = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "run", arguments: { class: "ZCL_A" } },
    },
    strict,
    INFO
  )) as { result: { content: Array<{ text: string }> } };
  assert.equal(good.result.content[0].text, "ran ZCL_A");
});

test("a protocol revision we do not implement is not claimed back", async () => {
  // the spec asks for a revision the SERVER supports; echoing the client's
  // told a strict client it could use features this core does not have
  const res = (await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    },
    TOOLS,
    INFO
  )) as { result: { protocolVersion: string } };
  assert.equal(res.result.protocolVersion, "2025-06-18");
});
