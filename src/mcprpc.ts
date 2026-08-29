/*
 * A minimal MCP server core: the JSON-RPC dispatch for initialize,
 * tools/list and tools/call over the streamable-HTTP transport (plain JSON
 * responses - no SSE needed for request/response tools).
 *
 * Deliberately dependency-free: the extension hosts this over its own
 * `http` server (`mcpsystem.ts`), and the protocol subset three tools need
 * is small enough to own - a full SDK would be the heavier contract.
 *
 * `vscode`-free: messages in, responses out - covered by the test suite.
 */

/** One piece of tool-result content (text or image), MCP shape. */
export interface McpContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  /** JSON schema of the arguments. */
  inputSchema: object;
  handler(args: Record<string, unknown>): Promise<McpToolResult>;
}

export interface McpServerInfo {
  name: string;
  version: string;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** The protocol revisions this server actually implements, newest first. The
 *  spec asks a server to answer `initialize` with one it SUPPORTS - echoing
 *  whatever the client sent claimed support for revisions this minimal core
 *  does not have (elicitation, structured output), which a strict client then
 *  goes on to use. */
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** The revision answered when the client asks for one that is not ours. */
const FALLBACK_PROTOCOL = SUPPORTED_PROTOCOLS[0];

function result(id: number | string | null, payload: unknown): object {
  return { jsonrpc: "2.0", id, result: payload };
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string
): object {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Text-content shorthand for tool handlers. */
export function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: "text", text }], isError: isError || undefined };
}

/**
 * Handles one MCP message. Returns the response object, or undefined for a
 * notification (which gets no response body).
 */
export async function handleMcpMessage(
  message: unknown,
  tools: McpTool[],
  serverInfo: McpServerInfo
): Promise<object | undefined> {
  const msg = message as RpcMessage;
  const id = msg?.id ?? null;
  const method = msg?.method;

  if (!method) {
    return rpcError(id, -32600, "not a JSON-RPC request");
  }
  if (method.startsWith("notifications/")) {
    return undefined;
  }
  if (method === "initialize") {
    const asked = msg.params?.protocolVersion;
    return result(id, {
      protocolVersion:
        typeof asked === "string" && SUPPORTED_PROTOCOLS.includes(asked)
          ? asked
          : FALLBACK_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo,
    });
  }
  if (method === "ping") {
    return result(id, {});
  }
  if (method === "tools/list") {
    return result(id, {
      tools: tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }
  if (method === "tools/call") {
    const name = msg.params?.name;
    if (typeof name !== "string" || !name) {
      // its own message - "unknown tool: undefined" reads like a lookup bug
      return rpcError(id, -32602, "tool name is required");
    }
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return rpcError(id, -32602, `unknown tool: ${name}`);
    }
    try {
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      return result(id, await tool.handler(args));
    } catch (err) {
      // A failed tool run is a RESULT with isError, not a protocol error -
      // that is what lets the model read the reason and react.
      return result(
        id,
        textResult(err instanceof Error ? err.message : String(err), true)
      );
    }
  }
  return rpcError(id, -32601, `method not supported: ${method}`);
}
