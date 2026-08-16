import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { CORPUS_DIRS, VIEW_CHECK_DIRS, SAMPLES_DIRS, SAMPLES_STACK_DIRS } from "./repolayout";

/*
 * MCP server registration: exposes the abap2UI5 MCP server
 * (https://github.com/abap2UI5/ai-mcp) to every MCP client in this VS Code
 * window - Copilot agent mode, Claude Code, or any other extension speaking
 * MCP. The server gives agents the full abap2UI5 dev loop without an SAP
 * system: capability queries, static view validation, deploy, transpiled
 * build, headless run with screenshot.
 *
 * The server orchestrates sibling checkouts (abap2UI5, samples-controls,
 * samples, samples-stack, linter). Point `abap2ui5.mcp.reposRoot` at the
 * folder containing them and the matching *_HOME environment variables are
 * passed along.
 */

const CONFIG_SECTION = "abap2ui5";
const PROVIDER_ID = "abap2ui5.mcp";

/** Repo-name -> env var the server resolves it with (see ai-mcp lib/repos.mjs,
 *  whose CORPUS_DIRS / VIEW_CHECK_DIRS this mirrors via src/repolayout.ts). */
const HOME_VARS: ReadonlyArray<readonly [string, string]> = [
  ["abap2UI5", "A2UI5_HOME"],
  ...CORPUS_DIRS.map((d) => [d, "SAMPLES_CONTROLS_HOME"] as const),
  ...VIEW_CHECK_DIRS.map((d) => [d, "AI_VIEW_CHECK_HOME"] as const),
  /* The `examples` tool searches THREE sample catalogues, and until it did,
   * only the corpus needed an env var here. A checkout the extension does not
   * point at is not an error over there - the tool answers from the ones it
   * can read - so a missing one costs a third of the answer silently, which
   * is exactly why both are passed whenever they are present. */
  ...SAMPLES_DIRS.map((d) => [d, "SAMPLES_HOME"] as const),
  ...SAMPLES_STACK_DIRS.map((d) => [d, "SAMPLES_STACK_HOME"] as const),
];

function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/** The command that starts the server: an explicit setting wins; a local
 *  checkout under the repos root is preferred; npx from GitHub is the
 *  fallback. */
function serverCommand(): string[] {
  const explicit = config().get<string>("mcp.command", "").trim();
  if (explicit) {
    return explicit.split(/\s+/);
  }
  const root = config().get<string>("mcp.reposRoot", "").trim();
  if (root) {
    const server = path.join(root, "ai-mcp", "server.mjs");
    if (fs.existsSync(server)) {
      return ["node", server];
    }
  }
  return ["npx", "--yes", "github:abap2UI5/ai-mcp"];
}

function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const root = config().get<string>("mcp.reposRoot", "").trim();
  if (root) {
    for (const [repo, envVar] of HOME_VARS) {
      if (env[envVar]) {
        continue; // first match wins - the new directory name over the legacy one
      }
      const dir = path.join(root, repo);
      if (fs.existsSync(dir)) {
        env[envVar] = dir;
      }
    }
  }
  return env;
}

export function registerMcp(
  context: vscode.ExtensionContext,
  log: (m: string) => void,
  /** The in-extension system server (mcpsystem.ts), when the host has one. */
  system?: { url(): Promise<string> }
): void {
  // The MCP API arrived in VS Code 1.101 - keep working (minus MCP) on older
  // builds instead of failing activation.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== "function") {
    log("mcp: this VS Code has no MCP server definition API - skipping");
    return;
  }

  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    changed,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.mcp`)) {
        changed.fire();
      }
    }),
    vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, {
      onDidChangeMcpServerDefinitions: changed.event,
      provideMcpServerDefinitions: async () => {
        const definitions: vscode.McpServerDefinition[] = [];
        if (config().get<boolean>("mcp.enabled", true)) {
          const [command, ...args] = serverCommand();
          definitions.push(
            new vscode.McpStdioServerDefinition(
              "abap2UI5",
              command,
              args,
              serverEnv()
            )
          );
          log(`mcp: providing server definition - ${command} ${args.join(" ")}`);
        }
        // The system server: real-system tools, hosted by the extension
        // itself over HTTP (see mcpsystem.ts).
        if (
          system &&
          config().get<boolean>("mcp.system", true) &&
          typeof vscode.McpHttpServerDefinition === "function"
        ) {
          try {
            const url = await system.url();
            definitions.push(
              new vscode.McpHttpServerDefinition(
                "abap2UI5 System",
                vscode.Uri.parse(url)
              )
            );
            log("mcp: providing the system server definition");
          } catch (err) {
            log(`mcp: system server failed to start - ${String(err)}`);
          }
        }
        return definitions;
      },
    })
  );
  log("mcp: server definition provider registered");
}
