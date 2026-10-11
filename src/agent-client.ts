/*
 * The vendored agent client (mcp-server's appclient, snapshot and viewxml,
 * `src/vendor/agent/`) as a bundle of its own: `esbuild.js` builds this
 * entry to `dist/agent-client.js`, and `agentapps.ts` loads it the first
 * time an app_* tool of the system MCP server is called. Out of the
 * activation bundle on purpose, like `rendergate-tar.ts`: ~50 KB that every
 * window parsed for four tools that run only with
 * `abap2ui5.agent.enableAppTools` on. The web build has no system MCP
 * server and never loads it.
 */
export * from "./vendor/agent/appclient";
