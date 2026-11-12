import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  ANSWER_CAP_BYTES,
  capText,
  CHAT_TOOLS,
  ChatToolHost,
  chatTools,
  chatToolsOn,
  FINDINGS_TOOL,
  formatFindings,
  formatReconstructedView,
  formatRunningAppModel,
  invokeChatTool,
  manifestEntry,
  MODEL_TOOL,
  VIEW_TOOL,
  whenClauseOf,
} from "../chattools";
import { handleMcpMessage, schemaProblem } from "../mcprpc";

const ROOT = path.join(__dirname, "..");

/** A host that records what it was asked and answers from the given parts. */
function hostOf(parts: Partial<ChatToolHost> = {}): ChatToolHost & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    findings: async (uri) => {
      asked.push(["findings", uri]);
      return parts.findings
        ? parts.findings(uri)
        : { document: "src/zcl_x.clas.abap", findings: [] };
    },
    reconstructedView: async (uri) => {
      asked.push(["view", uri]);
      return parts.reconstructedView
        ? parts.reconstructedView(uri)
        : { document: "src/zcl_x.clas.abap", className: "ZCL_X", xml: "<mvc:View/>\n" };
    },
    runningAppModel: parts.runningAppModel,
  };
}

const toolOf = (name: string, host: ChatToolHost, surface: "desktop" | "web" = "desktop") => {
  const tool = chatTools(surface, host).find((entry) => entry.name === name);
  assert.ok(tool, `${name} is not offered on ${surface}`);
  return tool;
};

test("three read-only tools, named for the contribution point", () => {
  assert.deepEqual(
    CHAT_TOOLS.map((tool) => tool.name),
    [FINDINGS_TOOL, VIEW_TOOL, MODEL_TOOL]
  );
  for (const tool of CHAT_TOOLS) {
    assert.match(tool.name, /^abap2ui5_[\w-]+$/);
    assert.match(tool.toolReferenceName, /^abap2ui5[A-Za-z]+$/);
    assert.ok(tool.displayName.startsWith("abap2UI5 "));
    assert.ok(tool.modelDescription.includes("Read-only"), `${tool.name} must say it only reads`);
    assert.equal((tool.inputSchema as { type?: string }).type, "object");
  }
  assert.equal(new Set(CHAT_TOOLS.map((tool) => tool.toolReferenceName)).size, CHAT_TOOLS.length);
});

test("nothing the system MCP server offers is offered a second time", () => {
  // the decision behind this module: the chat tools complement the MCP
  // servers, so no name of `mcpsystem.ts` / `agentapps.ts` may reappear
  const acting = ["list_systems", "search_apps", "run_app_on_system", "check_view_source",
    "get_traffic", "app_list", "app_start", "app_describe", "app_act"];
  for (const tool of CHAT_TOOLS) {
    for (const name of acting) {
      assert.ok(!tool.name.endsWith(name), `${tool.name} repeats ${name}`);
    }
  }
  const source = fs.readFileSync(path.join(ROOT, "src", "chattools.ts"), "utf8");
  assert.ok(!/from "\.\/(mcpsystem|agentapps)"/.test(source));
  // and no tool asks for a confirmation, because none acts
  const plumbing = fs.readFileSync(path.join(ROOT, "src", "chattoolsview.ts"), "utf8");
  assert.ok(!/prepareInvocation\s*[:(]/.test(plumbing));
});

test("the web surface leaves out the tool that needs the preview", () => {
  assert.deepEqual(chatToolsOn("desktop").map((tool) => tool.name), [
    FINDINGS_TOOL,
    VIEW_TOOL,
    MODEL_TOOL,
  ]);
  assert.deepEqual(chatToolsOn("web").map((tool) => tool.name), [FINDINGS_TOOL, VIEW_TOOL]);
  assert.deepEqual(
    chatTools("web", hostOf()).map((tool) => tool.name),
    [FINDINGS_TOOL, VIEW_TOOL]
  );
});

test("a manifest entry carries the definition and the setting's when clause", () => {
  const [findings, , model] = CHAT_TOOLS;
  assert.equal(whenClauseOf(findings), "config.abap2ui5.chatTools");
  assert.equal(whenClauseOf(model), "config.abap2ui5.chatTools && !isWeb");
  const entry = manifestEntry(model);
  assert.equal(entry.name, MODEL_TOOL);
  assert.equal(entry.canBeReferencedInPrompt, true);
  assert.equal(entry.modelDescription, model.modelDescription);
  assert.deepEqual(entry.inputSchema, model.inputSchema);
});

test("the tools are McpTools: the MCP dispatch lists and calls them unchanged", async () => {
  const tools = chatTools("desktop", hostOf());
  const info = { name: "t", version: "1" };
  const listed = (await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    tools,
    info
  )) as { result: { tools: Array<{ name: string; description: string }> } };
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    CHAT_TOOLS.map((tool) => tool.name)
  );
  assert.equal(listed.result.tools[0].description, CHAT_TOOLS[0].modelDescription);
  // the declared schemas accept what the descriptions promise
  assert.equal(schemaProblem(CHAT_TOOLS[0].inputSchema, {}), undefined);
  assert.equal(schemaProblem(CHAT_TOOLS[0].inputSchema, { uri: "file:///a.clas.abap" }), undefined);
  assert.ok(schemaProblem(CHAT_TOOLS[0].inputSchema, { uri: 1 }));
});

test("findings: the document defaults to the active one, a uri is passed on", async () => {
  const host = hostOf();
  const tool = toolOf(FINDINGS_TOOL, host);
  await invokeChatTool(tool, {});
  await invokeChatTool(tool, { uri: " file:///w/zcl_y.clas.abap " });
  await invokeChatTool(tool, { uri: "" });
  await invokeChatTool(tool, undefined);
  await invokeChatTool(tool, ["not", "an", "object"]);
  assert.deepEqual(host.asked, [
    ["findings", undefined],
    ["findings", "file:///w/zcl_y.clas.abap"],
    ["findings", undefined],
    ["findings", undefined],
    ["findings", undefined],
  ]);
});

test("findings are listed as the Problems panel shows them", () => {
  const text = formatFindings({
    document: "src/zcl_x.clas.abap",
    findings: [
      { rule: "unknown-binding-path", severity: "warning", line: 41, message: "No such\n  path" },
      { rule: "unknown-property", severity: "error", line: 11, message: "Button has no 'txt'" },
      { rule: "deprecated-control", severity: "hint", line: 11, message: "Deprecated" },
    ],
  });
  assert.deepEqual(text.split("\n"), [
    "3 abap2UI5 view-check findings in src/zcl_x.clas.abap (1 error, 1 warning, 1 hint):",
    "line 12 [error] unknown-property: Button has no 'txt'",
    "line 12 [hint] deprecated-control: Deprecated",
    "line 42 [warning] unknown-binding-path: No such path",
  ]);
});

test("no findings is not reported as a clean bill of health", () => {
  const text = formatFindings({ document: "src/zcl_x.clas.abap", findings: [] });
  assert.ok(text.startsWith("No abap2UI5 view-check findings are published for src/zcl_x.clas.abap."));
  assert.ok(text.includes("has not been checked"));
});

test("a long findings list is cut on a whole line and says so", () => {
  const findings = Array.from({ length: 200 }, (_, line) => ({
    rule: "unknown-property",
    severity: "error" as const,
    line,
    message: "x".repeat(40),
  }));
  const text = formatFindings({ document: "a", findings }, 1024);
  const lines = text.split("\n");
  assert.match(lines[lines.length - 1], /^\[Truncated: the first \d+ of 200 findings are shown\.\]$/);
  const shown = Number(/first (\d+)/.exec(lines[lines.length - 1])?.[1]);
  assert.equal(lines.length, shown + 2);
  assert.ok(shown > 0 && shown < 200);
  for (const line of lines.slice(1, -1)) {
    assert.match(line, /^line \d+ \[error\] unknown-property: x{40}$/);
  }
});

test("the reconstructed view is the XML under one naming line", async () => {
  const host = hostOf();
  const answer = await invokeChatTool(toolOf(VIEW_TOOL, host), { uri: "/w/zcl_x.clas.abap" });
  assert.deepEqual(answer.parts, [
    "Reconstructed XML view of ZCL_X (src/zcl_x.clas.abap):\n<mvc:View/>\n",
  ]);
  assert.deepEqual(host.asked, [["view", "/w/zcl_x.clas.abap"]]);
  assert.ok(
    formatReconstructedView({ document: "d", className: "ZCL_X", xml: "" }).startsWith(
      "No view could be reconstructed from ZCL_X (d)"
    )
  );
});

test("a host that has no answer is quoted, not thrown", async () => {
  const host = hostOf({
    findings: async () => ({ unavailable: "No document is active in the editor." }),
    reconstructedView: async () => ({ unavailable: "x.txt is not an ABAP class." }),
  });
  assert.deepEqual((await invokeChatTool(toolOf(FINDINGS_TOOL, host), {})).parts, [
    "No document is active in the editor.",
  ]);
  assert.deepEqual((await invokeChatTool(toolOf(VIEW_TOOL, host), {})).parts, [
    "x.txt is not an ABAP class.",
  ]);
});

test("the running app's model is pretty-printed JSON", async () => {
  const host = hostOf({
    runningAppModel: async () => ({ className: "ZCL_X", text: '{"MT_ITEMS":[{"ID":1}]}' }),
  });
  const [text] = (await invokeChatTool(toolOf(MODEL_TOOL, host), {})).parts;
  const [head, ...json] = text.split("\n");
  assert.equal(head, "Live JSON model of ZCL_X, the app shown in the preview:");
  assert.deepEqual(JSON.parse(json.join("\n")), { MT_ITEMS: [{ ID: 1 }] });
  assert.ok(!text.includes("Truncated"));
});

test("no running app is a plain sentence", async () => {
  const host = hostOf({
    runningAppModel: async () => ({ unavailable: "No app is running in the abap2UI5 preview." }),
  });
  assert.deepEqual((await invokeChatTool(toolOf(MODEL_TOOL, host), {})).parts, [
    "No app is running in the abap2UI5 preview.",
  ]);
  assert.equal(
    formatRunningAppModel({ className: "ZCL_X", text: "" }),
    "ZCL_X is running in the preview, but its model is empty."
  );
});

test("a large model is cut at the cap and the answer says so", () => {
  assert.equal(ANSWER_CAP_BYTES, 50 * 1024);
  const rows = Array.from({ length: 4000 }, (_, id) => ({ ID: id, TEXT: "Größe ✓ " + id }));
  const text = formatRunningAppModel({ className: "ZCL_X", text: JSON.stringify({ rows }) });
  const lines = text.split("\n");
  const note = lines[lines.length - 1];
  assert.match(
    note,
    /^\[Truncated: the model is \d+ KB, only the first 50 KB are shown\.\] The JSON above is incomplete\.$/
  );
  const body = lines.slice(1, -1).join("\n");
  assert.ok(Buffer.byteLength(body, "utf8") <= ANSWER_CAP_BYTES);
  assert.ok(Buffer.byteLength(body, "utf8") > ANSWER_CAP_BYTES - 8);
  // cut on a character boundary - no replacement character at the end
  assert.ok(!body.includes("�"));
  // a dump the page itself cut is not JSON any more - still answered, capped
  const broken = formatRunningAppModel({ className: "ZCL_X", text: '{"A":"' + "y".repeat(100) }, 64);
  assert.ok(broken.includes("[Truncated: the model is"));
});

test("capText counts bytes and never splits a character", () => {
  assert.deepEqual(capText("abc", 3), { text: "abc", truncated: false, totalBytes: 3 });
  assert.deepEqual(capText("aé", 2), { text: "a", truncated: true, totalBytes: 3 });
  assert.deepEqual(capText("a✓b", 3), { text: "a", truncated: true, totalBytes: 5 });
  assert.deepEqual(capText("a✓b", 4), { text: "a✓", truncated: true, totalBytes: 5 });
  assert.deepEqual(capText("abc", 0), { text: "", truncated: true, totalBytes: 3 });
});

test("the model tool without a preview answers with a sentence", async () => {
  // not registered on the web surface - but a host without the preview that
  // is asked anyway must not throw
  const tool = toolOf(MODEL_TOOL, hostOf(), "desktop");
  const [text] = (await invokeChatTool(tool, {})).parts;
  assert.ok(text.includes("desktop build of the extension only"));
});

test("a handler that throws becomes an answer the model can read", async () => {
  const host = hostOf({
    findings: async () => {
      throw new Error("diagnostics unavailable");
    },
  });
  assert.deepEqual((await invokeChatTool(toolOf(FINDINGS_TOOL, host), {})).parts, [
    `${FINDINGS_TOOL} failed: diagnostics unavailable`,
  ]);
});

test("the module stays out of node and vscode - the web bundle carries it", () => {
  const source = fs.readFileSync(path.join(ROOT, "src", "chattools.ts"), "utf8");
  const imports = [...source.matchAll(/^import\s+(type\s+)?.*?from\s+"([^"]+)";/gms)];
  assert.deepEqual(
    imports.map((m) => `${m[1] ? "type " : ""}${m[2]}`).sort(),
    ["./text", "type ./mcprpc"]
  );
  assert.ok(!/\bBuffer\b/.test(source.replace(/\/\/.*$/gm, "")));
});
