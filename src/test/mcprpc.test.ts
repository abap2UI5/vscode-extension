import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcpMessage, McpTool, textResult } from "../mcprpc";

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
