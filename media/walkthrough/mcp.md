# Give your AI agent the abap2UI5 dev loop

The extension offers the [abap2UI5 MCP server](https://github.com/abap2UI5/mcp-server)
to every MCP client in the window — GitHub Copilot agent mode, Claude Code,
or any other extension speaking MCP. The server gives an agent the full
abap2UI5 development loop **without an SAP system**: capability queries,
static view validation, deploy into a local sandbox, build, and a headless
run that returns errors *and a screenshot*.

Clone the `abap2UI5` and `samples-controls` repositories into one folder and point
`abap2ui5.mcp.reposRoot` at it. The server then appears in `MCP: List
Servers` as **abap2UI5**; `abap2ui5.mcp.enabled: false` removes it.

**Using Claude Code?** The abap2UI5 plugin is the alternative there: it
installs the same server together with the four abap2UI5 agent skills
(`build-an-app`, `view-chain-layout`, `abap-check`, `ui5-check`):

```
/plugin marketplace add abap2UI5/abap2UI5
/plugin install abap2ui5@abap2ui5
```

The server alone, outside VS Code:
`claude mcp add abap2ui5 -- npx --yes -p @abap2ui5/mcp-server abap2ui5-mcp`.
From 1.0 on, the server is also listed in the official MCP Registry as
`io.github.abap2UI5/mcp-server`. The setup for every client is on the
[AI page](https://abap2ui5.github.io/docs/get_started/ai.html) of the
documentation.
