import * as vscode from "vscode";
import { promises as fs } from "fs";
import type { AuthStrategy, ClientCertificateMaterial } from "./authstrategy";
import {
  choiceFor,
  CLIENT_CERTIFICATES_KEY,
  ClientCertificateChoice,
  ClientCertificateError,
  describeChoice,
  isPkcs12Path,
  loadClientCertificate,
  withChoice,
} from "./clientcert";
import { certificateNeeded, secretKeysFor, strategyFor } from "./logon";
import {
  BrowserLogonError,
  browserLogonNeeded,
  BrowserSession,
  browserSessions,
  logonUrlOf,
  pickExecutable,
  removeStaleProfiles,
  runBrowserLogon,
} from "./browserlogon";
import { findChromium } from "./screenshot";
import { renderGateBrowsers } from "./rendergate";
import { CONFIG_SECTION } from "./settings";
import * as path from "path";
import { ensureCredentials, ensureSystem, rememberOrigin, SystemProfile } from "./systems";
import { originOf } from "./urls";
import type { Session } from "./session";

/*
 * The plumbing around `logon.ts`: where each mechanism's secret comes from in
 * VS Code. Basic auth asks with `ensureCredentials` (systems.ts), as always.
 * A client certificate is chosen per origin with a file picker; the PATH goes
 * into `globalState` (machine-local, no workspace can write it), the
 * passphrase into the SecretStorage under `abap2ui5.cert:<origin>`, and the
 * file is read whenever the proxy is started with it.
 */

/** Warned about once per origin and window - not on every F9. */
const warnedAbout = new Set<string>();

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * The strategy `system` logs on to `origin` with - asking for what is
 * missing. `mayAsk: false` (the MCP tools) never opens a certificate picker:
 * a certificate nobody chose yet is a refusal naming F9 and the command.
 * Basic auth prompts as it always did, in every flow. Undefined when the user
 * cancelled; a certificate that cannot be used throws its reason.
 */
export async function strategyForSystem(
  context: vscode.ExtensionContext,
  system: SystemProfile,
  origin: string,
  options: { mayAsk: boolean; log?: (message: string) => void }
): Promise<AuthStrategy | undefined> {
  return strategyFor(system, origin, {
    basicCredentials: (o) => ensureCredentials(context, o),
    clientCertificate: (o) => ensureClientCertificate(context, o, options),
    browserSession: (o) => ensureBrowserSession(context, system, o, options),
  });
}

/**
 * The live browser logon of `origin` - in memory, for this window. None (or
 * an expired one): `mayAsk` opens the browser on the profile's launch URL
 * and waits for the user (progress notification with Cancel); a flow
 * without a UI is refused, naming F9 and "Log On in Browser".
 */
async function ensureBrowserSession(
  context: vscode.ExtensionContext,
  system: SystemProfile,
  origin: string,
  options: { mayAsk: boolean; log?: (message: string) => void }
): Promise<BrowserSession | undefined> {
  const live = browserSessions.get(origin);
  if (live) {
    return live;
  }
  if (!options.mayAsk) {
    throw browserLogonNeeded(hostOf(origin));
  }
  return logOnInBrowserFor(context, system, origin, options.log);
}

/** Opens the browser for `origin` and keeps what it hands over. Undefined
 *  when the user cancelled or no browser could be found (both told). */
async function logOnInBrowserFor(
  context: vscode.ExtensionContext,
  system: SystemProfile,
  origin: string,
  log: (message: string) => void = () => undefined
): Promise<BrowserSession | undefined> {
  const configured = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>("logon.browserExecutable", "");
  const picked = pickExecutable(configured, findChromium(renderGateBrowsers(context)));
  if (!picked.executable) {
    log(`logon: ${picked.problem}`);
    const install = "Install Render Gate";
    const settings = "Open Settings";
    void vscode.window
      .showErrorMessage(`abap2UI5: ${picked.problem}.`, install, settings)
      .then((pick) => {
        if (pick === install) {
          void vscode.commands.executeCommand("abap2ui5.installRenderGate");
        } else if (pick === settings) {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "abap2ui5.logon.browserExecutable"
          );
        }
      });
    return undefined;
  }
  const profileRoot = path.join(context.globalStorageUri.fsPath, "logon-profiles");
  removeStaleProfiles(profileRoot);
  const host = hostOf(origin);
  try {
    const cookies = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `abap2UI5: log on to ${host} in the browser window`,
        cancellable: true,
      },
      (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return runBrowserLogon({
          executable: picked.executable!,
          url: logonUrlOf(system.template),
          origin,
          profileRoot,
          signal: abort.signal,
          log,
        });
      }
    );
    const session = new BrowserSession(cookies);
    browserSessions.set(origin, session);
    log(`logon: browser logon for ${host} kept in memory (${session.describe()})`);
    return session;
  } catch (err) {
    if (err instanceof BrowserLogonError && (err.reason === "closed" || err.reason === "aborted")) {
      log(`logon: ${err.message}`);
      return undefined;
    }
    throw err;
  }
}

/**
 * "abap2UI5: Log On in Browser" - for the active system's host, whatever a
 * session there says: the old one is dropped, the browser opens, and a
 * running proxy on that host is restarted with the new logon.
 */
export async function logOnInBrowser(
  session: Session,
  restart: (system: SystemProfile, origin: string) => Promise<void>
): Promise<void> {
  const system = await ensureSystem(session.ctx);
  if (!system) {
    return;
  }
  const origin = originOf(session.urlFor(system, "PROBE"));
  if (!origin) {
    return;
  }
  if ((system.auth ?? "basic") !== "browser") {
    void vscode.window.showInformationMessage(
      `abap2UI5: ${system.name} logs on with "${system.auth ?? "basic"}" - set "auth": "browser" ` +
        "in its abap2ui5.systems entry to log on in the browser."
    );
    return;
  }
  browserSessions.forget(origin);
  if (session.proxy.systemOrigin === origin) {
    await restart(system, origin);
    return;
  }
  try {
    const logged = await logOnInBrowserFor(session.ctx, system, origin, (m) => session.log(m));
    if (logged) {
      void vscode.window.showInformationMessage(
        `abap2UI5: logged on to ${hostOf(origin)} - press F9 to run an app.`
      );
    }
  } catch (err) {
    reportLogonFailure(err, (m) => session.log(m));
  }
}

/** The chosen certificate of `origin`, read and checked - asking for one
 *  first when none is chosen and the flow may ask. */
async function ensureClientCertificate(
  context: vscode.ExtensionContext,
  origin: string,
  options: { mayAsk: boolean; log?: (message: string) => void }
): Promise<ClientCertificateMaterial | undefined> {
  let choice = choiceFor(context.globalState.get<unknown>(CLIENT_CERTIFICATES_KEY), origin);
  if (!choice) {
    if (!options.mayAsk) {
      throw certificateNeeded(hostOf(origin));
    }
    choice = await chooseFor(context, origin);
    if (!choice) {
      return undefined;
    }
  }
  const passphrase = await context.secrets.get(secretKeysFor(origin).cert);
  const loaded = await loadClientCertificate(choice, passphrase, (path) => fs.readFile(path));
  options.log?.(
    `logon: client certificate for ${hostOf(origin)}` +
      (loaded.subject ? ` (${loaded.subject})` : "") +
      (loaded.validTo ? `, valid until ${loaded.validTo.toISOString().slice(0, 10)}` : "")
  );
  if (loaded.warning && !warnedAbout.has(origin)) {
    warnedAbout.add(origin);
    void vscode.window.showWarningMessage(`abap2UI5: ${loaded.warning}.`);
  }
  return loaded.material;
}

/**
 * The picker: a `.pfx`/`.p12` file, or a PEM certificate and then its key,
 * and the passphrase (empty for an unencrypted key). Checked before it is
 * remembered, so a wrong passphrase is told now and not at the next F9.
 */
async function chooseFor(
  context: vscode.ExtensionContext,
  origin: string
): Promise<ClientCertificateChoice | undefined> {
  const host = hostOf(origin);
  const picked = await vscode.window.showOpenDialog({
    title: `abap2UI5: Client Certificate for ${host}`,
    openLabel: "Use This Certificate",
    canSelectMany: false,
    filters: {
      "Client certificate": ["pfx", "p12", "pem", "crt", "cer"],
      "All files": ["*"],
    },
  });
  const file = picked?.[0]?.fsPath;
  if (!file) {
    return undefined;
  }
  let choice: ClientCertificateChoice;
  if (isPkcs12Path(file)) {
    choice = { kind: "pfx", path: file };
  } else {
    const key = await vscode.window.showOpenDialog({
      title: `abap2UI5: Private Key of the Certificate for ${host}`,
      openLabel: "Use This Key",
      canSelectMany: false,
      filters: { "Private key": ["pem", "key"], "All files": ["*"] },
    });
    const keyFile = key?.[0]?.fsPath;
    if (!keyFile) {
      return undefined;
    }
    choice = { kind: "pem", cert: file, key: keyFile };
  }
  const passphrase = await vscode.window.showInputBox({
    title: `abap2UI5: Passphrase of the Certificate for ${host}`,
    prompt:
      "Leave empty when the key is not encrypted (stored securely in the VS Code SecretStorage)",
    password: true,
    ignoreFocusOut: true,
  });
  if (passphrase === undefined) {
    return undefined;
  }
  try {
    await loadClientCertificate(choice, passphrase, (path) => fs.readFile(path));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `abap2UI5: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
  const key = secretKeysFor(origin).cert;
  if (passphrase) {
    await context.secrets.store(key, passphrase);
  } else {
    await context.secrets.delete(key);
  }
  await context.globalState.update(
    CLIENT_CERTIFICATES_KEY,
    withChoice(context.globalState.get<unknown>(CLIENT_CERTIFICATES_KEY), origin, choice)
  );
  // findable for "Clear Stored SAP Credentials" after the system is gone
  await rememberOrigin(context, origin);
  warnedAbout.delete(origin);
  return choice;
}

/**
 * "abap2UI5: Choose Client Certificate" - for the active system's host. A
 * running proxy on that host is restarted with the new certificate.
 */
export async function chooseClientCertificate(
  session: Session,
  restart: (system: SystemProfile, origin: string) => Promise<void>
): Promise<void> {
  const system = await ensureSystem(session.ctx);
  if (!system) {
    return;
  }
  const origin = originOf(session.urlFor(system, "PROBE"));
  if (!origin) {
    return;
  }
  const choice = await chooseFor(session.ctx, origin);
  if (!choice) {
    return;
  }
  session.log(`logon: client certificate for ${hostOf(origin)} set to ${describeChoice(choice)}`);
  const unused =
    (system.auth ?? "basic") !== "certificate"
      ? ` - ${system.name} logs on with "${system.auth ?? "basic"}"; set "auth": "certificate" in its abap2ui5.systems entry to use it`
      : "";
  if (!unused && session.proxy.systemOrigin === origin) {
    await restart(system, origin);
  }
  void vscode.window.showInformationMessage(
    `abap2UI5: client certificate for ${hostOf(origin)} stored${unused}.`
  );
}

/** A certificate problem as the user sees it, with the command that fixes it. */
export function reportLogonFailure(err: unknown, log: (message: string) => void): void {
  const message = err instanceof Error ? err.message : String(err);
  log(`logon: ${message}`);
  const offer = err instanceof ClientCertificateError ? ["Choose Client Certificate"] : [];
  void vscode.window.showErrorMessage(`abap2UI5: ${message}`, ...offer).then((pick) => {
    if (pick === "Choose Client Certificate") {
      void vscode.commands.executeCommand("abap2ui5.chooseClientCertificate");
    }
  });
}
