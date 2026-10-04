# Make your repository agent-ready

Most abap2UI5 projects are an abapGit repository with a `src/` folder and no
briefing for an AI agent. **Add Agent Setup to Workspace** gives the open
project what makes [abap2UI5/app-template](https://github.com/abap2UI5/app-template)
ready for one - the same files `npm create abap2ui5-app@latest -- --agent-setup`
adds, from the copy bundled with the extension (no network needed):

- `AGENTS.md` - the app-building reference an agent reads first - and `CLAUDE.md`
- `.claude/settings.json` and the four skills (`build-an-app`,
  `view-chain-layout`, `abap-check`, `ui5-check`), `.mcp.json`
- the two gates: `abaplint.jsonc` and `abap2ui5lint.jsonc`, pointed at the
  folder your `.abapgit.xml` names as `STARTING_FOLDER`
- `.github/workflows/check.yml`, `scripts/check-pin.mjs`, `scripts/doctor.mjs`,
  `.nvmrc`

A file you already have is left as it is. `package.json` and `.gitignore` are
**merged**: missing scripts, devDependencies and patterns are added, yours keep
their values. Nothing is written into your source folder. The confirmation
lists every file before anything happens; afterwards run `npm install` and
`npm run check`.

**Only want the agent knowledge, without the gates?** In Claude Code the
abap2UI5 plugin brings the skills and the MCP server to any project:

```
/plugin marketplace add abap2UI5/abap2UI5
/plugin install abap2ui5@abap2ui5
```
