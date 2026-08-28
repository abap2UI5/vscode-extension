import * as vscode from "vscode";

/*
 * The web smoke test, run INSIDE a browser extension host by
 * `@vscode/test-web` (`npm run test:web`).
 *
 * It answers the one question the desktop suite cannot: does the web bundle
 * actually load and WORK in a browser host? A module that newly drags a
 * node builtin into the web graph, a snapshot that stops parsing, a
 * registration that throws - all of it surfaces here instead of in a broken
 * Marketplace build.
 *
 * Asserting the registrations alone was not enough. The view check ran into
 * a `TypeError` on every document (the linter reached for `path.resolve` and
 * `process.cwd`, which the web shims did not have), `webcheck.ts` swallowed
 * it by design - an unparsable buffer mid-edit must not throw out of a
 * listener - and the feature was silently dead in this host while everything
 * here stayed green. So the test now drives a real check and insists on a
 * real diagnostic: the gate has to reach the snapshot, run, and publish.
 *
 * Activation is explicit: the host has no ABAP language extension, so the
 * `onLanguage:abap` event never fires on its own.
 */

/** What a successful web activation must have registered. */
const EXPECTED_COMMANDS = [
  "abap2ui5.checkViews",
  "abap2ui5.showReconstructedXml",
  "abap2ui5.newApp",
  "abap2ui5.openHomepage",
];

/** A view whose one property does not exist - `unknown-property`, an error.
 *  XML rather than ABAP because the host has no `abap` language id to give
 *  an untitled document, while `*.view.xml` is recognised by its name. */
const BAD_VIEW =
  '<mvc:View xmlns:mvc="sap.ui.core.mvc" xmlns="sap.m">\n' +
  '  <Button text="Go" nosuchprop="x"/>\n' +
  "</mvc:View>\n";

async function waitFor<T>(
  what: string,
  probe: () => T | undefined,
  timeoutMs = 10000
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

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("abap2ui5.abap2ui5");
  if (!extension) {
    throw new Error("abap2ui5.abap2ui5 is not present in the web host");
  }
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const id of EXPECTED_COMMANDS) {
    if (!commands.includes(id)) {
      throw new Error(`${id} was not registered by the web activation`);
    }
  }

  // The property gate, end to end: snapshot -> parse -> rules -> diagnostics.
  const uri = vscode.Uri.parse("untitled:/smoke.view.xml");
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc);
  await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), BAD_VIEW));
  await vscode.commands.executeCommand("abap2ui5.checkViews");

  const found = await waitFor("the view check to publish a diagnostic", () => {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    return diagnostics.length > 0 ? diagnostics : undefined;
  });

  const codes = found.map((d) =>
    typeof d.code === "object" && d.code !== null
      ? String((d.code as { value: string | number }).value)
      : String(d.code)
  );
  if (!codes.includes("unknown-property")) {
    throw new Error(
      `the web check published ${found.length} diagnostic(s) but not the ` +
        `expected unknown-property: ${codes.join(", ")}`
    );
  }
}
