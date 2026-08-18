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
