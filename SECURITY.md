# Security policy

## Reporting a vulnerability

Please use the GitHub Security Advisory
["Report a Vulnerability"](https://github.com/abap2UI5/vscode-extension/security/advisories/new)
tab. Do not open a public issue for a security report.

Expect an acknowledgement within a few days. This project is developed
alongside other work, so a fix is agreed rather than promised by a date — the
advisory is where that conversation happens.

## Supported versions

Only the **latest version published to the Marketplace** is supported. A fix
ships as the next release rather than as a patch to an older line.

## What this extension is, from a security point of view

This is the one part of the ecosystem that holds credentials and talks to a
real system, so it is worth being precise about what it does with both:

- **Credentials live in VS Code's `SecretStorage`** (`src/systems.ts`), which is
  the operating system's keychain — not in `settings.json`, not in the
  workspace, and not in any file this extension writes. The command
  *"abap2UI5: Clear Stored SAP Credentials"* removes them.
- **The local proxy listens on loopback only.** `src/proxy.ts` binds
  `127.0.0.1` on an ephemeral port (`listen(0, "127.0.0.1")`), so it is not
  reachable from another machine on the network.
- **It sends HTTP Basic auth to the system you configured**, and rewrites
  `Origin` and `Referer` on the forwarded request so that origin-validating
  CSRF checks on the SAP side see the SAP host rather than the loopback one.
  That rewrite is what makes the preview work; it is also the part of this
  extension a report is most likely to be about, and such a report is very
  welcome.
- **It has no npm `dependencies`.** Nothing is installed alongside it, so the
  supply chain is the VSIX and the toolchain that built it. What the VSIX
  carries beyond the extension's own code is bundled in at build time from
  `devDependencies`: the linter, into the extension bundle; `tar`, the
  render-gate installer's archive library, into its own file next to it. The
  agent client vendored from abap2UI5/mcp-server (`src/vendor/agent/`) is
  bundled into its own file the same way. Both of those are loaded the first
  time they are needed, not on activation (`esbuild.js`).
- **The linter it bundles reads source; it never executes it.** The property
  gate parses ABAP and XML statically. The render gate, which does load a view
  in a browser, is the exception, and it is downloaded by this extension at
  runtime: *"Install Render Gate"* / *"Update Render Gate"* (`src/rendergate.ts`)
  fetch the linter's checker bundle from its immutable per-commit GitHub
  release tag `render-gate-bundle-<sha12>` — the release commit of exactly the
  linter version this build bundles — verify its SHA-256 against the published
  `.sha256` asset and against the digest remembered from the last install,
  refuse a per-commit bundle whose bytes changed, unpack it into the
  extension's global storage and run it locally with a Chromium that
  playwright downloads. Only `abap2ui5.viewCheck.rollingBundle` (off by
  default) switches to the rolling tag that follows the linter's main. That
  download-and-execute path is the second part of this extension a report is
  likely to be about, and such reports are in scope here.

## Out of scope

- What the linter *reports* about your ABAP or your views — that is the
  product, not a vulnerability, and rule questions belong in
  [abap2UI5/linter](https://github.com/abap2UI5/linter/issues).
- The security of the SAP system you point the extension at. Whether an ICF
  node should be reachable, and with which authorisations, is a decision on
  that system.
