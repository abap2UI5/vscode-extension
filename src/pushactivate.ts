import * as vscode from "vscode";
import { classNameOf } from "./abap";
import { isAppSource } from "./appclasses";
import { pushClass, readServerSource, productionRefusal, AdtWriteDeps } from "./adtwrite";
import {
  ActivationMessage,
  CLASS_PARTS,
  ClassPart,
  messagesByFile,
  partFileName,
  partOfFileName,
} from "./adtmessages";
import { nodeRequest } from "./agentapps";
import { ensureCertificateTrust, reportTrustRefusal } from "./certprompt";
import { activateAndReload } from "./launch";
import { postToShownApp, reloadShownApp } from "./preview";
import { isNewer, staleMessage } from "./previewcore";
import { Session } from "./session";
import { allSystems, ensureCredentials, ensureSystem, SystemProfile } from "./systems";
import { originOf, sapClientOf } from "./urls";

/*
 * "abap2UI5: Push and Activate" (T07b) and the activation errors in Problems
 * (T09) - the VS Code plumbing. What is sent and what the answers mean is
 * `adtwrite.ts` / `adtmessages.ts`, `vscode`-free and tested against
 * fixtures; this module decides WHETHER to send and shows the outcome:
 *
 *   - refused in Restricted Mode and on a system whose profile (or any
 *     profile on the same origin) says `role: "production"`, before anything
 *     is asked or sent;
 *   - a modal before the first push of a class to a system in this window;
 *   - a conflict check: the server's `changedAt` against the one seen at the
 *     last push or F9 of that class, with a diff of server vs local on offer
 *     when the server is newer;
 *   - the transport request is asked for when the system wants one, never
 *     made up;
 *   - every request goes to the auth proxy's loopback origin, so the
 *     credentials, the certificate pin and the logon strategy are the
 *     proxy's - no new outgoing connection is opened here.
 *
 * Ctrl+F3 (`abap2ui5.activate`) comes here for a `file:` ABAP class document
 * of an app (`activateOrPush`); an `adt:` document keeps the delegation to
 * the ABAP tooling in `launch.ts`.
 */

const SERVER_SCHEME = "abap2ui5-server";
const REQUEST_TIMEOUT_MS = 120_000;

/** Classes the first-push modal was answered yes for, per system - this
 *  window only. */
const confirmed = new Set<string>();
/** The server's `changedAt` after this window's last push, per system and
 *  class. */
const pushedAt = new Map<string, string>();
/** The texts the diff editor's server side is served from. */
const serverTexts = new Map<string, string>();

let diagnostics: vscode.DiagnosticCollection | undefined;

/** The file of the class that `uri` belongs to, with its part. */
function classFileOf(uri: vscode.Uri): { base: string; part: ClassPart } | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }
  return partOfFileName(uri.fsPath);
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  try {
    return new TextDecoder("utf-8").decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Whether `doc` is a class file on disk whose class is an app - Ctrl+F3's
 *  question. */
async function isAppClassFile(doc: vscode.TextDocument): Promise<boolean> {
  if (doc.languageId !== "abap") {
    return false;
  }
  const file = classFileOf(doc.uri);
  if (!file) {
    return false;
  }
  const main =
    file.part === "main"
      ? doc.getText()
      : await readText(vscode.Uri.file(partFileName(file.base, "main")));
  return main !== undefined && isAppSource(main);
}

/**
 * Ctrl+F3: a `file:` class document of an app is pushed and activated
 * through ADT; everything else (an `adt:` document above all) keeps the
 * delegation to the installed ABAP tooling.
 */
export async function activateOrPush(session: Session): Promise<void> {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc && (await isAppClassFile(doc))) {
    await pushAndActivate(session, doc.uri);
    return;
  }
  await activateAndReload(session);
}

/** Whether `system`, or any profile on the same origin, is a production
 *  system - the workspace's list must not be able to hide one. */
function isProduction(system: SystemProfile, origin: string): boolean {
  if (system.role === "production") {
    return true;
  }
  return allSystems().some((other) => {
    if (other.role !== "production") {
      return false;
    }
    try {
      return new URL(other.template.replace(/\{class\}/gi, "X")).origin === origin;
    } catch {
      return false;
    }
  });
}

function showMessages(base: string, messages: readonly ActivationMessage[]): void {
  if (!diagnostics) {
    return;
  }
  clearClass(base);
  for (const [file, list] of messagesByFile(base, messages)) {
    diagnostics.set(
      vscode.Uri.file(file),
      list.map((m) => {
        const line = Math.max(0, m.line - 1);
        const range = new vscode.Range(line, m.column, line, Number.MAX_SAFE_INTEGER);
        const d = new vscode.Diagnostic(
          range,
          m.text,
          m.severity === "error"
            ? vscode.DiagnosticSeverity.Error
            : m.severity === "warning"
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information
        );
        d.source = "abap2UI5 activation";
        return d;
      })
    );
  }
}

function clearClass(base: string): void {
  for (const part of CLASS_PARTS) {
    diagnostics?.delete(vscode.Uri.file(partFileName(base, part)));
  }
}

/** Opens the diff of the server's source of `part` against the local file. */
async function showServerDiff(
  deps: AdtWriteDeps,
  className: string,
  part: ClassPart,
  local: vscode.Uri,
  system: string,
  sapClient: string | undefined
): Promise<void> {
  const text = (await readServerSource(deps, className, part, sapClient)) ?? "";
  const key = `${className.toLowerCase()}-${part}-${Date.now()}`;
  serverTexts.set(key, text);
  const left = vscode.Uri.from({ scheme: SERVER_SCHEME, path: `/${key}.abap` });
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    local,
    `${className} (${part}): ${system} ↔ local`
  );
}

/**
 * "abap2UI5: Push and Activate" for the class `uri` belongs to (the active
 * editor's when none is given).
 */
export async function pushAndActivate(session: Session, uri?: vscode.Uri): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      "abap2UI5: Push and Activate writes source to the system as you - it is not available in Restricted Mode. Trust the workspace first."
    );
    return;
  }
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  const file = target ? classFileOf(target) : undefined;
  if (!target || !file) {
    vscode.window.showWarningMessage(
      "abap2UI5: Push and Activate works on an ABAP class file on disk (*.clas.abap and its local includes)."
    );
    return;
  }

  // the class's files: save the dirty ones, read every one there is
  const sources: Partial<Record<ClassPart, string>> = {};
  for (const part of CLASS_PARTS) {
    const partUri = vscode.Uri.file(partFileName(file.base, part));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === partUri.toString());
    if (open?.isDirty) {
      await open.save();
    }
    const text = await readText(partUri);
    if (text !== undefined) {
      sources[part] = text;
    }
  }
  const mainUri = vscode.Uri.file(partFileName(file.base, "main"));
  if (sources.main === undefined) {
    vscode.window.showWarningMessage(`abap2UI5: ${mainUri.fsPath} cannot be read - nothing was pushed.`);
    return;
  }
  const className = classNameOf(sources.main, mainUri.fsPath);

  const system = await ensureSystem(session.ctx);
  if (!system) {
    return;
  }
  const externalUrl = session.urlFor(system, className);
  const origin = originOf(externalUrl);
  if (!origin) {
    vscode.window.showErrorMessage(`abap2UI5: the launch URL of ${system.name} is not a valid URL.`);
    return;
  }
  const where = `${system.name} (${new URL(origin).host})`;
  if (isProduction(system, origin)) {
    vscode.window.showWarningMessage(`abap2UI5: ${productionRefusal(where)}`);
    return;
  }
  const sapClient = sapClientOf(externalUrl);
  const key = `${origin}|${sapClient ?? ""}|${className}`;

  const trust = await ensureCertificateTrust(session, origin, { interactive: true });
  if (!trust.trusted) {
    session.log(`push: ${className} not pushed - ${trust.message}`);
    reportTrustRefusal(trust);
    return;
  }
  const creds = await ensureCredentials(session.ctx, origin);
  if (!creds) {
    return;
  }
  try {
    await session.proxy.start(origin, creds.user, creds.pass);
  } catch (err) {
    vscode.window.showErrorMessage(
      `abap2UI5: could not start the proxy - ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const deps: AdtWriteDeps = {
    request: (url, init) =>
      nodeRequest(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    base: session.proxy.origin,
    log: (m) => session.log(m),
    askTransport: async ({ className: cls, reason }) => {
      const answer = await vscode.window.showInputBox({
        title: `abap2UI5: Transport request for ${cls}`,
        prompt: `${reason} Enter the transport request to record the change in (e.g. A4HK900123).`,
        ignoreFocusOut: true,
        validateInput: (v) =>
          /^[A-Za-z0-9]{4,20}$/.test(v.trim()) ? undefined : "A transport request number, e.g. A4HK900123",
      });
      return answer?.trim().toUpperCase() || undefined;
    },
  };

  // the first push of this class to this system in this window: ask
  const COMPARE = "Compare with Server";
  if (!confirmed.has(key)) {
    const pick = await vscode.window.showWarningMessage(
      `abap2UI5: Push ${className} to ${where} and activate it?`,
      {
        modal: true,
        detail:
          `The source of ${className} on ${where} is replaced by the local files ` +
          `(${CLASS_PARTS.filter((p) => sources[p] !== undefined).length} of them) and activated, under your user. ` +
          `You are asked once per class and system in this window.`,
      },
      "Push and Activate",
      COMPARE
    );
    if (pick === COMPARE) {
      await showServerDiff(deps, className, file.part, target, where, sapClient);
      return;
    }
    if (pick !== "Push and Activate") {
      return;
    }
    confirmed.add(key);
  }

  // conflict check: newer on the server than what this window last saw?
  const seen =
    pushedAt.get(key) ??
    (session.currentTarget?.className === className && session.currentTarget.system === system.name
      ? session.watch.shownChangedAt(className)
      : undefined);
  if (seen) {
    let serverChangedAt: string | undefined;
    try {
      serverChangedAt = (await session.proxy.fetchClassState(className, sapClient)).changedAt;
    } catch {
      // no verdict - the push below says what the system answers
    }
    if (serverChangedAt && isNewer(serverChangedAt, seen)) {
      const SHOW = "Show Differences";
      const pick = await vscode.window.showWarningMessage(
        `abap2UI5: ${className} was changed on ${where} since you last pushed or ran it.`,
        {
          modal: true,
          detail: `Server: ${serverChangedAt}, last seen here: ${seen}. Pushing replaces that change with the local files.`,
        },
        SHOW,
        "Push Anyway"
      );
      if (pick === SHOW) {
        await showServerDiff(deps, className, file.part, target, where, sapClient);
        return;
      }
      if (pick !== "Push Anyway") {
        return;
      }
    }
  }

  session.log(`push: ${className} to ${where}`);
  let result;
  try {
    result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `abap2UI5: pushing ${className}` },
      () => pushClass({ className, sources, sapClient }, deps)
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    session.log(`push: ${className} failed - ${reason}`);
    vscode.window.showErrorMessage(`abap2UI5: Push and Activate of ${className} failed - ${reason}`);
    return;
  }

  if (result.outcome === "refused" || result.outcome === "failed") {
    session.log(`push: ${className} ${result.outcome} - ${result.reason}`);
    vscode.window.showErrorMessage(`abap2UI5: ${result.reason}`);
    return;
  }

  const written = result.written.length ? result.written.join(", ") : "nothing changed";
  const transport = result.corrNr ? ` (transport request ${result.corrNr})` : "";
  if (result.outcome === "activation-failed") {
    showMessages(file.base, result.activation.messages);
    const errors = result.activation.messages.filter((m) => m.severity === "error").length;
    session.log(
      `push: ${className} written (${written})${transport}, activation failed - ${errors} error(s)` +
        (result.activation.inactive.length ? `, inactive: ${result.activation.inactive.join(", ")}` : "")
    );
    if (session.currentTarget?.className === className) {
      postToShownApp(session, staleMessage("Not activated - see the Problems view"));
    }
    vscode.window.showErrorMessage(
      `abap2UI5: ${className} was written to ${where} but not activated - ` +
        (errors ? `${errors} error(s), see the Problems view.` : "it is still inactive there.")
    );
    return;
  }

  // activated
  showMessages(file.base, result.activation.messages); // warnings stay, errors are gone
  if (!result.activation.messages.length) {
    clearClass(file.base);
  }
  try {
    const state = await session.proxy.fetchClassState(className, sapClient);
    if (state.changedAt) {
      pushedAt.set(key, state.changedAt);
    }
  } catch {
    pushedAt.delete(key);
  }
  session.log(`push: ${className} written (${written})${transport} and activated`);
  if (session.currentTarget?.className === className && session.currentTarget.system === system.name) {
    reloadShownApp(session, "Reloaded after activation", { bounceFocus: true });
  } else {
    vscode.window.showInformationMessage(`abap2UI5: ${className} activated on ${where}${transport}.`);
  }
}

/** Registers the command, the diagnostic collection and the diff's
 *  server-side documents. */
export function registerPushActivate(context: vscode.ExtensionContext, session: Session): void {
  diagnostics = vscode.languages.createDiagnosticCollection("abap2ui5-activation");
  context.subscriptions.push(
    diagnostics,
    vscode.workspace.registerTextDocumentContentProvider(SERVER_SCHEME, {
      provideTextDocumentContent: (uri) =>
        serverTexts.get(uri.path.replace(/^\//, "").replace(/\.abap$/, "")) ?? "",
    }),
    vscode.commands.registerCommand("abap2ui5.pushActivate", (uri?: vscode.Uri) =>
      pushAndActivate(session, uri instanceof vscode.Uri ? uri : undefined)
    ),
    { dispose: () => serverTexts.clear() }
  );
}
