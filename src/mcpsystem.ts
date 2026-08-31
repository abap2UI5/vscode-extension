import * as fs from "fs";
import * as http from "http";
import { randomBytes } from "crypto";
import { handleMcpMessage, McpTool, textResult } from "./mcprpc";
import { searchClasses } from "./appsearch";
import type { SapProxy } from "./proxy";

/*
 * The abap2UI5 SYSTEM MCP server - real-system tools for AI agents.
 *
 * The mcp-server server the extension already registers gives agents the dev
 * loop WITHOUT a system (sandbox deploy, transpiled run). This one is the
 * other half: it lives inside the extension, so it holds what only the
 * extension has - the configured systems, the stored credentials and the
 * auth proxy - and lets an agent search classes on the system and run an
 * app against it, screenshot included.
 *
 * Hosted over plain streamable HTTP on 127.0.0.1 with a random path token,
 * and registered through the same MCP definition provider as mcp-server.
 */

export interface SystemMcpDeps {
  /** The configured launch systems, no prompting. */
  listSystems(): { active?: string; systems: Array<{ name: string; host: string }> };
  /**
   * The connect flow F9 uses: pick/keep the system, ensure credentials,
   * start the proxy. May prompt the user; undefined when they back out.
   */
  connect(): Promise<{ sapClient?: string } | undefined>;
  proxy: SapProxy;
  /** Launch URL of a class through the running proxy. */
  frameUrlFor(className: string): string | undefined;
  /** Headless screenshot of a URL; resolves to the PNG path. */
  screenshot(className: string, url: string): Promise<string | undefined>;
  log: (m: string) => void;
}

function buildTools(deps: SystemMcpDeps): McpTool[] {
  return [
    {
      name: "list_systems",
      description:
        "Lists the abap2UI5 launch systems configured in this VS Code " +
        "window, and which one is active. No system contact.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const { active, systems } = deps.listSystems();
        if (!systems.length) {
          return textResult(
            "No systems configured. The user adds one with the command " +
              '"abap2UI5: Select System" or the abap2ui5.systems setting.'
          );
        }
        return textResult(
          systems
            .map(
              (s) =>
                `${s.name === active ? "* " : "  "}${s.name}  (${s.host})`
            )
            .join("\n") + "\n\n* = active system"
        );
      },
    },
    {
      name: "search_apps",
      description:
        "Searches class names on the active SAP system (ADT quick search). " +
        "Use it to find abap2UI5 app classes to run. May ask the user for " +
        "credentials on first contact.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Part of the class name, e.g. 'z2ui5' or 'zcl_travel'.",
          },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const query = String(args.query ?? "").trim();
        if (query.length < 2) {
          return textResult("query needs at least 2 characters", true);
        }
        const connection = await deps.connect();
        if (!connection) {
          return textResult(
            "the user cancelled the system/credential picker",
            true
          );
        }
        const names = await searchClasses(deps.proxy, query, connection.sapClient);
        return textResult(
          names.length
            ? names.join("\n")
            : `no class matching "${query}" on the system`
        );
      },
    },
    {
      name: "run_app",
      description:
        "Runs an abap2UI5 app class on the active SAP system (through the " +
        "extension's auth proxy) in headless Chromium and returns a " +
        "screenshot of what it renders. The real-system counterpart of the " +
        "sandbox run_app.",
      inputSchema: {
        type: "object",
        properties: {
          class: {
            type: "string",
            description: "The app class name, e.g. ZCL_MY_APP.",
          },
        },
        required: ["class"],
      },
      handler: async (args) => {
        const className = String(args.class ?? "").trim().toUpperCase();
        if (!className) {
          return textResult("class is required", true);
        }
        const connection = await deps.connect();
        if (!connection) {
          return textResult(
            "the user cancelled the system/credential picker",
            true
          );
        }
        const url = deps.frameUrlFor(className);
        if (!url) {
          return textResult("could not build a launch URL - is a system configured?", true);
        }
        const file = await deps.screenshot(className, url);
        if (!file) {
          return textResult(
            "screenshot failed - likely the render gate's Chromium is not " +
              'installed yet (command "abap2UI5: Install Render Gate")',
            true
          );
        }
        const png = fs.readFileSync(file).toString("base64");
        return {
          content: [
            {
              type: "text",
              text: `${className} rendered on the active system (${file})`,
            },
            { type: "image", data: png, mimeType: "image/png" },
          ],
        };
      },
    },
  ];
}

const BODY_CAP = 1024 * 1024;

export interface SystemMcpServer {
  /** Starts (once) and resolves the server's URL, token path included. */
  url(): Promise<string>;
  dispose(): void;
}

export function createSystemMcpServer(
  deps: SystemMcpDeps,
  version: string
): SystemMcpServer {
  const tools = buildTools(deps);
  const info = { name: "abap2UI5 System", version };
  const token = randomBytes(16).toString("base64url");
  let server: http.Server | undefined;
  let starting: Promise<string> | undefined;

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    if (req.url !== `/${token}`) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end(); // stateless - a session teardown is a no-op
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    for await (const chunk of req) {
      body += chunk;
      if (body.length > BODY_CAP) {
        res.writeHead(413).end();
        return;
      }
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "parse error" },
        })
      );
      return;
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const answers = (
      await Promise.all(
        messages.map((m) => handleMcpMessage(m, tools, info))
      )
    ).filter((a): a is object => a !== undefined);
    if (!answers.length) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
  };

  return {
    url(): Promise<string> {
      if (!starting) {
        starting = new Promise((resolve, reject) => {
          server = http.createServer((req, res) => {
            handle(req, res).catch((err) => {
              deps.log(`mcp-system: ${String(err)}`);
              if (!res.headersSent) {
                res.writeHead(500);
              }
              res.end();
            });
          });
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const addr = server!.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            const url = `http://127.0.0.1:${port}/${token}`;
            deps.log(`mcp-system: listening on 127.0.0.1:${port}`);
            resolve(url);
          });
        });
      }
      return starting;
    },
    dispose(): void {
      server?.close();
      server = undefined;
      starting = undefined;
    },
  };
}
