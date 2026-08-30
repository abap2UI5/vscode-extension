import * as vscode from "vscode";

/*
 * The desktop smoke test, run INSIDE a real VS Code extension host by
 * `@vscode/test-electron` (`npm run test:desktop`).
 *
 * The web bundle has had `src/web/test/suite.ts` for a while, and it earned
 * its place immediately: it caught a view check that threw a `TypeError` on
 * every document while every registration assertion stayed green. The desktop
 * side had no equivalent, and it is the larger half - `src/extension.ts`, the
 * `Session` wiring, and `dist/properties.json` being resolved next to the
 * bundle that is actually packaged. `npm test` bundles the `vscode`-free
 * modules for plain Node and cannot activate any of it.
 *
 * So this asserts the three things only a real host can answer:
 *
 *   1. `dist/extension.js` loads and `activate( )` returns without throwing -
 *      a module that newly drags in something the host does not provide, or a
 *      constructor that throws during the wiring, fails here.
 *   2. The desktop-only commands are registered. These are exactly the ones
 *      the web suite CANNOT check, because the web entry deliberately does not
 *      register them.
 *   3. The metadata snapshot was found next to the bundle. There is no probe
 *      API to ask - `activate( )` returns void - so this drives the property
 *      gate end to end and insists on a real diagnostic. A missing
 *      `dist/properties.json` makes the gate run against nothing and find
 *      nothing, silently; that is the exact failure `snapshot.ts` logs about
 *      and nothing else notices. `unknown-property` can only be produced by a
 *      snapshot that loaded, parsed and reached the rules.
 *
 * Deliberately NOT asserted: anything needing a real SAP system, and the
 * render gate (it downloads a Chromium bundle at runtime; `viewCheck.render`
 * is false by default and the workspace this runs in pins it off).
 */

/** Commands the DESKTOP activation must register. Chosen to be the ones the
 *  web entry does not have, so this is not a second copy of the web suite:
 *  F9 and the system plumbing, the workspace-wide check, and the screenshot
 *  command - all of them behind `src/extension.ts` and its `Session`. */
const EXPECTED_COMMANDS = [
  "abap2ui5.run",
  "abap2ui5.activate",
  "abap2ui5.selectSystem",
  "abap2ui5.checkConnection",
  "abap2ui5.checkWorkspace",
  "abap2ui5.screenshot",
  "abap2ui5.showTraffic",
  // Shared with the web host, but the desktop registration is a different
  // code path and has broken on its own before.
  "abap2ui5.checkViews",
  "abap2ui5.newApp",
];

async function waitFor<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs = 30000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

function codesOf(diagnostics: readonly vscode.Diagnostic[]): string[] {
  return diagnostics.map((d) =>
    typeof d.code === "object" && d.code !== null
      ? String((d.code as { value: string | number }).value)
      : String(d.code)
  );
}

export async function run(): Promise<void> {
  // 1. Activation.
  const extension = vscode.extensions.getExtension("abap2ui5.abap2ui5");
  if (!extension) {
    throw new Error("abap2ui5.abap2ui5 is not present in the desktop host");
  }
  await extension.activate();
  if (!extension.isActive) {
    throw new Error("abap2ui5.abap2ui5 did not become active");
  }

  // 2. Registrations.
  const commands = await vscode.commands.getCommands(true);
  const missing = EXPECTED_COMMANDS.filter((id) => !commands.includes(id));
  if (missing.length) {
    throw new Error(
      `the desktop activation did not register: ${missing.join(", ")}`
    );
  }

  // 3. The property gate end to end, over a real file in a real workspace
  // folder - the desktop path, where the check resolves its repo config from
  // the document's own directory (an untitled buffer would skip exactly that).
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error(
      "the test workspace folder is missing - the runner should have opened one"
    );
  }
  const uri = vscode.Uri.joinPath(folder.uri, "smoke.view.xml");
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand("abap2ui5.checkViews");

  const found = await waitFor("the view check to publish a diagnostic", () => {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    return diagnostics.length > 0 ? diagnostics : undefined;
  });

  const codes = codesOf(found);
  if (!codes.includes("unknown-property")) {
    throw new Error(
      `the desktop check published ${found.length} diagnostic(s) but not the ` +
        `expected unknown-property: ${codes.join(", ")}. An empty or missing ` +
        `dist/properties.json next to the bundle looks exactly like this.`
    );
  }
}
