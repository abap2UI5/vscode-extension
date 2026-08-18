_This project is open source and developed alongside other projects or during free time. Contributions are greatly appreciated!_

Check out the contribution guidelines [here.](https://abap2ui5.github.io/docs/resources/contribution.html)

## Before opening a pull request

```bash
npm ci                 # PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 in a sandbox
npm run lint           # tsc --noEmit && eslint .
npm test               # the vscode-free cores, driven headless
npm run package        # the desktop and web bundles
npm run vsix           # what the marketplace would get
```

Everything the user sees inside VS Code is in English, including command
titles and setting descriptions. [AGENTS.md](AGENTS.md) is the full contract:
the module map, what may import `vscode` and what may not, and the snapshots
(the linter pin, `app-template.json`, `client-api.json`, `repo-dirs.json`)
that must be regenerated rather than edited.
