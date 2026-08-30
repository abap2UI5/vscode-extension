/*
 * A minimal MCP server core: the JSON-RPC dispatch for initialize,
 * tools/list and tools/call over the streamable-HTTP transport (plain JSON
 * responses - no SSE needed for request/response tools), plus the front-door
 * decision the HTTP host applies before any of it.
 *
 * Deliberately dependency-free: the extension hosts this over its own
 * `http` server (`mcpsystem.ts`), and the protocol subset three tools need
 * is small enough to own - a full SDK would be the heavier contract. The one
 * import is node's `crypto`, for the constant-time compare of the path token
 * that authorizes acting with the system credentials.
 *
 * `vscode`-free: messages in, responses out - covered by the test suite.
 */

import { createHash, timingSafeEqual } from "crypto";

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

/** The slice of JSON Schema the tools actually declare. */
interface SchemaProperty {
  type?: string;
  enum?: unknown[];
}
interface ToolInputSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

/**
 * Why an argument object does not match the tool's own `inputSchema`, or
 * undefined when it does.
 *
 * Every tool declares a schema and every handler used to re-check it by hand
 * (`String(args.x ?? "")` coercions, an enum re-tested with a comment saying
 * why) - which is one hand-written validation per tool, and a new tool
 * unvalidated by default. Deliberately a SUBSET: required keys, `type:
 * "string"` and `enum` are what these schemas say, and a validator that
 * pretended to more would be the second, wrong description of them. A
 * handler's own checks stay its own - "at least 2 characters", "not only
 * whitespace" - because the schema does not express those.
 */
export function schemaProblem(
  schema: object | undefined,
  args: Record<string, unknown>
): string | undefined {
  const spec = (schema ?? {}) as ToolInputSchema;
  for (const key of spec.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      return `${key} is required`;
    }
  }
  for (const [key, property] of Object.entries(spec.properties ?? {})) {
    const value = args[key];
    if (value === undefined || value === null) {
      continue; // absent is the optional case; `required` above judged it
    }
    if (property?.type === "string" && typeof value !== "string") {
      return `${key} must be a string, got ${typeof value}`;
    }
    if (Array.isArray(property?.enum) && !property.enum.includes(value)) {
      return `${key} must be one of: ${property.enum.join(", ")}`;
    }
  }
  return undefined;
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

  // typeof, not merely falsy: `{"method": 5}` used to reach `method.startsWith`
  // and throw, and the rejection took the WHOLE request down - a batch's valid
  // sibling messages included - with a bodyless 500 instead of this -32600.
  if (typeof method !== "string" || !method) {
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
    const raw = msg.params?.arguments ?? {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return rpcError(id, -32602, `${name}: arguments must be an object`);
    }
    const args = raw as Record<string, unknown>;
    const problem = schemaProblem(tool.inputSchema, args);
    if (problem) {
      // -32602 rather than an isError result: the call never happened, and a
      // uniform message beats each handler inventing its own coercion.
      return rpcError(id, -32602, `${name}: ${problem}`);
    }
    try {
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

/**
 * Dispatches one parsed request body - a single message or a batch - into the
 * answers that need a response body (notifications drop out).
 *
 * Every message is isolated: a `handleMcpMessage` that REJECTS (a bug in this
 * core, never a failing tool - those become isError results) becomes a -32603
 * for that one message. `Promise.all` over the raw calls used to reject as a
 * whole, so one malformed message answered the entire request with a bodyless
 * 500 and took its valid siblings with it.
 */
export async function handleMcpBatch(
  messages: unknown[],
  tools: McpTool[],
  serverInfo: McpServerInfo,
  log?: (m: string) => void
): Promise<object[]> {
  const answers = await Promise.all(
    messages.map((message) =>
      handleMcpMessage(message, tools, serverInfo).catch(
        (err: unknown): object => {
          log?.(`mcp: dispatch failed - ${String(err)}`);
          return rpcError(
            (message as RpcMessage)?.id ?? null,
            -32603,
            err instanceof Error ? err.message : String(err)
          );
        }
      )
    )
  );
  return answers.filter((a): a is object => a !== undefined);
}

// ---------------------------------------------------------------------------
// The HTTP front door
// ---------------------------------------------------------------------------

/** What the host does with one incoming request, before any JSON is read. */
export type McpRequestVerdict =
  /** Authorized: read the body and dispatch it. */
  | "dispatch"
  /** Authorized DELETE - a session teardown, which is a no-op here. */
  | "teardown"
  /** Not authorized, or a path that is not ours: 404, told nothing more. */
  | "not-found"
  /** Authorized, but not a method this transport speaks: 405. */
  | "method-not-allowed";

/** Both sides hashed before comparing, so the comparison touches every byte
 *  of the secret whatever the request sent - a plain `===` returns on the
 *  first differing character, which is a timing oracle on the one value that
 *  authorizes acting with the system credentials. */
export function pathAuthorized(
  url: string | undefined,
  expected: string
): boolean {
  const got = createHash("sha256").update(String(url ?? "")).digest();
  const want = createHash("sha256").update(expected).digest();
  return timingSafeEqual(got, want);
}

/**
 * The whole authorization decision of the system MCP server's HTTP host, as
 * one pure function - so the negative cases (a wrong token, a `Host` that is
 * not loopback, a path nobody handed out) are testable rather than only
 * reviewable.
 *
 * Both halves of the rule every local listener here follows: the secret in
 * the path, AND a `Host` that is loopback. This server acts with the system
 * credentials exactly as the auth proxy does, so it owes callers the same
 * refusal of a request that arrived under a name merely RESOLVING to
 * 127.0.0.1 - which is what DNS rebinding looks like from this side. The
 * loopback predicate is passed in rather than re-derived: `proxy.ts` owns it
 * for every listener (see AGENTS.md), and a second copy is how one of them
 * would end up laxer than the other.
 */
export function authorizeMcpRequest(
  request: { method?: string; url?: string; host?: string },
  expectedPath: string,
  isLoopbackHost: (host: string | undefined) => boolean
): McpRequestVerdict {
  if (!isLoopbackHost(request.host)) {
    return "not-found";
  }
  if (!pathAuthorized(request.url, expectedPath)) {
    return "not-found";
  }
  if (request.method === "DELETE") {
    return "teardown";
  }
  if (request.method !== "POST") {
    return "method-not-allowed";
  }
  return "dispatch";
}
