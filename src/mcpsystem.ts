import * as fs from "fs";
import * as http from "http";
import * as vscode from "vscode";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { describe, severityOf } from "@abap2ui5/linter/findings";
import type { PropertyFinding } from "@abap2ui5/linter/properties";
import { handleMcpMessage, McpTool, textResult } from "./mcprpc";
import { searchClasses } from "./appsearch";
import { isLoopbackHost, type SapProxy } from "./proxy";
import { runGate, VIEW_XML_RE } from "./gate";
import { withParams } from "./urls";
import { CONFIG_SECTION } from "./settings";

/*
 * The abap2UI5 SYSTEM MCP server - real-system tools for AI agents.
 *
 * The MCP server the extension already registers gives agents the dev
 * loop WITHOUT a system (sandbox deploy, transpiled run). This one is the
 * other half: it lives inside the extension, so it holds what only the
 * extension has - the configured systems, the stored credentials and the
 * auth proxy - and lets an agent search classes on the system and run an
 * app against it, screenshot included.
 *
 * Hosted over plain streamable HTTP on 127.0.0.1 with a random path token,
 * and registered through the same MCP definition provider as it.
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
  screenshot(
    className: string,
    url: string,
    viewport?: { width: number; height: number }
  ): Promise<string | undefined>;
  /** The most recent proxy traffic-log lines, oldest first - when the host
   *  keeps them. Without it the `get_traffic` tool is not offered. */
  recentTraffic?(): string[];
  log: (m: string) => void;
}

const findingLine = (f: PropertyFinding): string =>
  `${f.severity ?? severityOf(f)} ${f.type}` +
  (typeof f.line === "number" ? ` line ${f.line}` : "") +
  `: ${f.message ?? describe(f)}`;

function buildTools(deps: SystemMcpDeps): McpTool[] {
  const tools: McpTool[] = [
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
      /* NOT `run_app`: the abap2UI5 MCP server (mcp-server) registers a tool of
       * that name in the same window, and it means something else - a build
       * of the transpiled sandbox, no system involved. Two tools with one
       * name and two semantics is a coin toss for the agent, so this one says
       * which of the two it is. */
      name: "run_app_on_system",
      description:
        "Runs an abap2UI5 app class on the active SAP system (through the " +
        "extension's auth proxy) in headless Chromium and returns a " +
        "screenshot of what it renders. The real-system counterpart of the " +
        "abap2UI5 server's sandbox `run_app`. The optional `viewport` " +
        "renders at a device width (desktop is the default).",
      inputSchema: {
        type: "object",
        properties: {
          class: {
            type: "string",
            description: "The app class name, e.g. ZCL_MY_APP.",
          },
          theme: {
            type: "string",
            description:
              "Optional UI5 theme to render in, e.g. sap_horizon_dark.",
          },
          viewport: {
            type: "string",
            enum: ["desktop", "tablet", "phone"],
            description:
              "Optional viewport to render in: desktop (1280x900, the " +
              "default), tablet (834x1112) or phone (414x896).",
          },
        },
        required: ["class"],
      },
      handler: async (args) => {
        const className = String(args.class ?? "").trim().toUpperCase();
        if (!className) {
          return textResult("class is required", true);
        }
        const theme = String(args.theme ?? "").trim();
        const connection = await deps.connect();
        if (!connection) {
          return textResult(
            "the user cancelled the system/credential picker",
            true
          );
        }
        let url = deps.frameUrlFor(className);
        if (!url) {
          return textResult("could not build a launch URL - is a system configured?", true);
        }
        if (theme) {
          url = withParams(url, { "sap-ui-theme": theme });
        }
        const viewports: Record<string, { width: number; height: number }> = {
          desktop: { width: 1280, height: 900 },
          tablet: { width: 834, height: 1112 },
          phone: { width: 414, height: 896 },
        };
        const viewport =
          viewports[String(args.viewport ?? "desktop")] ?? viewports.desktop;
        const file = await deps.screenshot(className, url, viewport);
        if (!file) {
          return textResult(
            "screenshot failed - likely the render gate's Chromium is not " +
              'installed yet (command "abap2UI5: Install Render Gate")',
            true
          );
        }
        // async: a full-page PNG read and base64-encoded synchronously
        // stalls the extension host for as long as it takes
        const png = (await fs.promises.readFile(file)).toString("base64");
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
    {
      /* Distinct from the stdio server's validation tools on purpose - this
       * one takes SOURCE, not a workspace file, and judges by the editor's
       * settings. */
      name: "check_view_source",
      description:
        "Checks abap2UI5 view source without a system: the bundled property " +
        "gate (the same rules as the editor's static view check) over an " +
        "ABAP app class building views with z2ui5_cl_ui5_view_builder, or a " +
        "*.view.xml. Judged by the VS Code settings (UI5 floor, " +
        "distribution, allow list); a repository's abap2ui5lint.jsonc is " +
        "not read here.",
      inputSchema: {
        type: "object",
        properties: {
          source: {
            type: "string",
            description: "The complete ABAP class or XML view source.",
          },
          filename: {
            type: "string",
            description:
              "Optional file name, e.g. zcl_app.clas.abap or main.view.xml " +
              "- decides whether the source is read as ABAP or XML.",
          },
        },
        required: ["source"],
      },
      handler: async (args) => {
        const source = String(args.source ?? "");
        if (!source.trim()) {
          return textResult("source is required", true);
        }
        const filename = String(args.filename ?? "").trim() || "source.clas.abap";
        const isXml = VIEW_XML_RE.test(filename) || /^\s*</.test(source);
        const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const rules = cfg.get<Record<string, unknown>>("viewCheck.rules");
        const gate = runGate(source, filename, isXml, {
          minUi5: cfg.get<string>("viewCheck.minUi5", "1.71"),
          distribution: cfg.get<string>("viewCheck.distribution", "sapui5"),
          allow: cfg.get<string[]>("viewCheck.allow", []),
          rules: rules && Object.keys(rules).length > 0 ? rules : undefined,
        });
        if (gate.nothingChecked) {
          return textResult(`nothing checked - ${gate.nothingChecked}`);
        }
        if (!gate.findings.length) {
          return textResult(`no findings${gate.helperNote}`);
        }
        return textResult(gate.findings.map(findingLine).join("\n"));
      },
    },
  ];
  if (deps.recentTraffic) {
    const recentTraffic = deps.recentTraffic.bind(deps);
    tools.push({
      name: "get_traffic",
      description:
        "Returns the extension's recent proxy traffic log - every request " +
        "the embedded app made through the auth proxy, with status and " +
        "roundtrip time. Use it to diagnose a run_app_on_system that " +
        "rendered blank or failed.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const lines = recentTraffic();
        return textResult(
          lines.length
            ? lines.join("\n")
            : "no traffic recorded yet - run an app first"
        );
      },
    });
  }
  return tools;
}

const BODY_CAP = 1024 * 1024;

/** Both sides hashed before comparing, so the comparison touches every byte
 *  of the secret whatever the request sent - a plain `===` returns on the
 *  first differing character, which is a timing oracle on the one value that
 *  authorizes acting with the system credentials. */
function pathAuthorized(url: string | undefined, expected: string): boolean {
  const got = createHash("sha256").update(String(url ?? "")).digest();
  const want = createHash("sha256").update(expected).digest();
  return timingSafeEqual(got, want);
}

export interface SystemMcpServer {
  /** Starts (once) and resolves the server's URL, token path included. */
  url(): Promise<string>;
  /** The URL the server currently listens on, or undefined while it is not
   *  running. Unlike `url()` this never starts anything - it exists for
   *  status reporting, and its caller must strip the token path before
   *  showing the value anywhere. */
  currentUrl(): string | undefined;
  /** Closes the listener; a later url() starts a fresh one, new token
   *  included - what turning `abap2ui5.mcp.system` off means. */
  stop(): void;
  dispose(): void;
}

export function createSystemMcpServer(
  deps: SystemMcpDeps,
  version: string
): SystemMcpServer {
  const tools = buildTools(deps);
  const info = { name: "abap2UI5 System", version };
  let token = "";
  let server: http.Server | undefined;
  let starting: Promise<string> | undefined;
  let listeningUrl: string | undefined;

  const handle = async (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> => {
    /*
     * Both halves of the rule every local listener here follows: the secret
     * in the path, AND a `Host` that is loopback. This server acts with the
     * system credentials exactly as the auth proxy does - `run_app_on_system`
     * and `search_apps` go out authenticated - so it owes callers the same
     * refusal of a request that arrived under a name merely RESOLVING to
     * 127.0.0.1, which is what DNS rebinding looks like from this side. The
     * proxy has enforced this since it was written; this one only had the
     * token, which is one half of the invariant and reads as the whole of it.
     */
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(404).end();
      return;
    }
    if (!pathAuthorized(req.url, `/${token}`)) {
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

  let disposed = false;

  const stop = (): void => {
    server?.close();
    server = undefined;
    starting = undefined;
    listeningUrl = undefined;
  };

  return {
    url(): Promise<string> {
      if (disposed) {
        // nothing would ever close a server started after dispose( ) - the
        // extension's own hook has already run
        return Promise.reject(new Error("the system MCP server is disposed"));
      }
      if (!starting) {
        const attempt = new Promise<string>((resolve, reject) => {
          token = randomBytes(16).toString("base64url");
          // captured per attempt: stop( ) can clear the shared `server` while
          // the listen is still in flight, and the callbacks must neither
          // dereference undefined nor leak the socket they just bound
          const srv = http.createServer((req, res) => {
            handle(req, res).catch((err) => {
              deps.log(`mcp-system: ${String(err)}`);
              if (!res.headersSent) {
                res.writeHead(500);
              }
              res.end();
            });
          });
          server = srv;
          srv.once("error", (err) => {
            if (server === srv) {
              server = undefined;
            }
            reject(err);
          });
          srv.listen(0, "127.0.0.1", () => {
            if (server !== srv) {
              srv.close();
              reject(new Error("the system MCP server was stopped while starting"));
              return;
            }
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            const url = `http://127.0.0.1:${port}/${token}`;
            listeningUrl = url;
            deps.log(`mcp-system: listening on 127.0.0.1:${port}`);
            resolve(url);
          });
        });
        // a listen that failed once must not be the answer forever: the
        // setting that turns this on can be toggled, and retrying is free
        const wrapped: Promise<string> = attempt.catch((err) => {
          if (starting === wrapped) {
            starting = undefined;
          }
          throw err;
        });
        starting = wrapped;
      }
      return starting;
    },
    currentUrl(): string | undefined {
      return server ? listeningUrl : undefined;
    },
    stop,
    dispose(): void {
      disposed = true;
      stop();
    },
  };
}
