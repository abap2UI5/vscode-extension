import * as vscode from "vscode";
import { classNameOf } from "./abap";
import { inflateCode, MAX_SOURCE, OpenRequest, parseOpenUri, readCapped } from "./openlink";

/*
 * The URI handler: vscode://abap2ui5.abap2ui5/open?code=…&name=… or ?src=…
 * opens the class it carries as an unsaved `.clas.abap` document and offers
 * F9 for it. What the link means is decided in `openlink.ts`; this module
 * only fetches, opens and asks.
 */

const FETCH_TIMEOUT_MS = 20_000;

export function registerOpenLink(
  context: vscode.ExtensionContext,
  deps: { log: (line: string) => void; run: (className: string) => Promise<void> }
): void {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => openFromLink(uri.toString(), deps),
    })
  );
}

async function openFromLink(
  uri: string,
  deps: { log: (line: string) => void; run: (className: string) => Promise<void> }
): Promise<void> {
  const request = parseOpenUri(uri);
  if (request.kind === "error") {
    deps.log(`open link: refused - ${request.message}`);
    void vscode.window.showErrorMessage(`abap2UI5: ${request.message}`);
    return;
  }
  let source: string;
  try {
    source = await sourceOf(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`open link: ${request.name} - ${message}`);
    void vscode.window.showErrorMessage(`abap2UI5: cannot open ${request.name}: ${message}`);
    return;
  }
  deps.log(`open link: ${request.name} (${request.kind === "url" ? request.url : "from the link"})`);

  // An untitled document under the class's file name - in the first
  // workspace folder when there is one, so Save offers the right place.
  const folder = vscode.workspace.workspaceFolders?.[0];
  const target = folder
    ? vscode.Uri.joinPath(folder.uri, request.name).with({ scheme: "untitled" })
    : vscode.Uri.parse(`untitled:${request.name}`);
  const doc = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  await editor.edit((edit) => {
    const all = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(all, source);
  });
  if (doc.languageId !== "abap") {
    // an ABAP language extension that knows .clas.abap may come later than
    // the document; where none is installed this throws and plain text stays
    await vscode.languages.setTextDocumentLanguage(doc, "abap").then(undefined, () => undefined);
  }

  const className = classNameOf(source, request.name);
  const RUN = "Run App (F9)";
  const choice = await vscode.window.showInformationMessage(
    `abap2UI5: ${className} opened from a link, not saved. F9 runs it on the system once the class is there and active.`,
    RUN
  );
  if (choice === RUN) {
    await deps.run(className);
  }
}

async function sourceOf(request: Exclude<OpenRequest, { kind: "error" }>): Promise<string> {
  if (request.kind === "inline") {
    return inflateCode(request.code);
  }
  const res = await fetch(request.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) {
    throw new Error(`${request.url} answered ${res.status}`);
  }
  return readCapped(res, MAX_SOURCE, request.url);
}
