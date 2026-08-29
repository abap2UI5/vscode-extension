import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import * as fs from "fs";
import * as path from "path";
import { CORPUS_DIRS, VIEW_CHECK_DIRS, SAMPLES_DIRS, SAMPLES_STACK_DIRS, SERVER_DIRS } from "./repolayout";
import { splitCommandLine } from "./checkcore";

/*
 * MCP server registration: exposes the abap2UI5 MCP server
 * (https://github.com/abap2UI5/mcp-server) to every MCP client in this VS Code
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

const PROVIDER_ID = "abap2ui5.mcp";

/** Repo-name -> env var the server resolves it with (see mcp-server
 *  lib/repos.mjs, whose directory lists this mirrors via src/repolayout.ts). */
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

/** Where the stdio server's command came from - part of the status report. */
export type StdioSource = "setting" | "local checkout" | "npx";

/** The command that starts the server: an explicit setting wins; a local
 *  checkout under the repos root is preferred; npx from the npm registry is
 *  the fallback. */
function resolveServerCommand(): { command: string[]; source: StdioSource } {
  const explicit = config().get<string>("mcp.command", "").trim();
  if (explicit) {
    // quotes honoured: a program path with a space in it (the normal shape
    // on Windows, and under "Application Support" on macOS) used to be split
    // into pieces that spawn could only fail on
    return { command: splitCommandLine(explicit), source: "setting" };
  }
  const root = config().get<string>("mcp.reposRoot", "").trim();
  if (root) {
    /* Every name the repository has carried, newest first - it was ai-mcp
     * before 2026-08. A hard-coded directory name here would stop finding a
     * checkout the day upstream renames, and fall back to npx without saying
     * so: the server would still start, from the network, ignoring the local
     * clone the user pointed at on purpose. */
    for (const dir of SERVER_DIRS) {
      const server = path.join(root, dir, "server.mjs");
      if (fs.existsSync(server)) {
        return { command: ["node", server], source: "local checkout" };
      }
    }
  }
  /* The published package, not `github:abap2UI5/mcp-server` - that resolved
   * to whatever main held on the day, cloned the whole repository and ran its
   * install. This is an immutable tarball of a tested release.
   *
   * Deliberately unpinned. The server's compatibility is with the CORPORA it
   * reads, not with this extension, so a version pinned here would express a
   * coupling that does not exist - and would then need a bump workflow and an
   * extension release to follow every server release. `latest` is also no
   * looser than what this line did before. */
  return { command: ["npx", "--yes", "@abap2ui5/mcp-server"], source: "npx" };
}

function serverCommand(): string[] {
  return resolveServerCommand().command;
}

/**
 * What the provider would resolve right now - the answer behind
 * "abap2UI5: Show MCP Status". Reads the same settings the provider reads,
 * so the report cannot drift from what a client actually gets.
 */
export function mcpStatus(): {
  stdioEnabled: boolean;
  stdioCommand: string[];
  stdioSource: StdioSource;
  /** The *_HOME variables handed to the stdio server. */
  env: Record<string, string>;
  systemEnabled: boolean;
} {
  const { command, source } = resolveServerCommand();
  return {
    stdioEnabled: config().get<boolean>("mcp.enabled", true),
    stdioCommand: command,
    stdioSource: source,
    env: serverEnv(),
    systemEnabled: config().get<boolean>("mcp.system", true),
  };
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
  system?: { url(): Promise<string>; stop?(): void }
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
        // "off" has to close the listener, not merely stop advertising it: a
        // client that already holds the URL could otherwise keep calling the
        // credential-backed tools until the window closes.
        if (system?.stop && !config().get<boolean>("mcp.system", true)) {
          system.stop();
          log("mcp: system server stopped (abap2ui5.mcp.system is off)");
        }
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
