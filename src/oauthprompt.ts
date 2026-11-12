import * as vscode from "vscode";
import { promises as fs } from "fs";
import { oauthLogonNeeded, secretKeysFor } from "./logon";
import {
  describeLifetime,
  keyOriginMismatch,
  OAuthMaterial,
  OAuthTokenError,
  parseServiceKey,
  readStoredOAuth,
  refreshTokens,
  SERVICE_KEY_MAX_BYTES,
  ServiceKey,
  ServiceKeyError,
  StoredOAuth,
  storedOAuthText,
} from "./oauth";
import { logOnInBrowser, postForm } from "./oauthflow";
import { ensureSystem, rememberOrigin, SystemProfile } from "./systems";
import { originOf } from "./urls";
import type { Session } from "./session";

/*
 * The VS Code plumbing of `auth: "oauth"` (`oauth.ts` decides, `oauthflow.ts`
 * does the I/O): "abap2UI5: Load Service Key", and the logon `strategyFor`
 * asks for. The service key (it carries the client secret) and the refresh
 * token live in ONE SecretStorage entry per origin, `abap2ui5.oauth:<origin>`
 * - never in a setting, `globalState` or a log line. The access token stays
 * in the proxy's strategy, in memory.
 */

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

async function readStored(
  context: vscode.ExtensionContext,
  origin: string
): Promise<StoredOAuth | undefined> {
  return readStoredOAuth(await context.secrets.get(secretKeysFor(origin).oauth));
}

async function writeStored(
  context: vscode.ExtensionContext,
  origin: string,
  stored: StoredOAuth
): Promise<void> {
  await context.secrets.store(secretKeysFor(origin).oauth, storedOAuthText(stored));
}

/** Persists (or forgets) the refresh token beside the key it belongs to. */
async function storeRefreshToken(
  context: vscode.ExtensionContext,
  origin: string,
  serviceKey: unknown,
  refreshToken: string | undefined
): Promise<void> {
  const now = await readStored(context, origin);
  // a key loaded meanwhile is another client: its entry is not touched
  if (!now || JSON.stringify(now.serviceKey) !== JSON.stringify(serviceKey)) {
    return;
  }
  await writeStored(context, origin, { serviceKey, refreshToken });
}

/** One browser logon per origin at a time - a second F9 joins the first. */
const browserLogons = new Map<string, Promise<OAuthMaterial | undefined>>();

/**
 * The OAuth logon of `origin`, for `strategyFor`: the loaded key, renewed
 * with the stored refresh token, else (when the flow may ask) a logon in the
 * user's default browser. `mayAsk: false` (the MCP tools) never opens a
 * browser or a picker: without a key or a refresh token that still works it
 * throws the refusal naming F9. Undefined when the user cancelled.
 */
export async function ensureOAuthLogon(
  context: vscode.ExtensionContext,
  origin: string,
  options: { mayAsk: boolean; log?: (message: string) => void }
): Promise<OAuthMaterial | undefined> {
  const host = hostOf(origin);
  let stored = await readStored(context, origin);
  if (!stored) {
    if (!options.mayAsk) {
      throw oauthLogonNeeded(host, false);
    }
    const loaded = await chooseKeyFor(context, origin);
    if (!loaded) {
      return undefined;
    }
    stored = loaded;
  }
  const serviceKey = stored.serviceKey;
  const key = parseServiceKey(serviceKey);
  const material = (tokens: OAuthMaterial["tokens"]): OAuthMaterial => ({
    key,
    tokens,
    post: postForm,
    onRefreshToken: (token) => storeRefreshToken(context, origin, serviceKey, token),
    log: options.log,
  });

  if (stored.refreshToken) {
    try {
      const tokens = await refreshTokens(key, stored.refreshToken, postForm);
      if (tokens.refreshToken && tokens.refreshToken !== stored.refreshToken) {
        await storeRefreshToken(context, origin, serviceKey, tokens.refreshToken);
      }
      options.log?.(`logon: OAuth token for ${host} renewed, ${describeLifetime(tokens)}`);
      return material({ ...tokens, refreshToken: tokens.refreshToken ?? stored.refreshToken });
    } catch (err) {
      if (!(err instanceof OAuthTokenError) || err.kind === "transient" || err.kind === "malformed") {
        throw err; // the UAA or the network - the logon itself may be fine
      }
      options.log?.(`logon: the stored OAuth logon for ${host} was refused - ${err.message}`);
      await storeRefreshToken(context, origin, serviceKey, undefined);
      if (err.kind === "client") {
        throw new Error(`${err.message} - run "abap2UI5: Load Service Key" with a current key`);
      }
    }
  }
  if (!options.mayAsk) {
    throw oauthLogonNeeded(host, true);
  }
  let pending = browserLogons.get(origin);
  if (!pending) {
    pending = browserLogon(context, origin, serviceKey, key, options.log).then(
      (tokens) => (tokens ? material(tokens) : undefined)
    );
    browserLogons.set(origin, pending);
    void pending.finally(() => browserLogons.delete(origin)).catch(() => undefined);
  }
  return pending;
}

/** The browser logon with a cancellable notification; stores the refresh
 *  token it brings. Undefined when the user cancelled. */
async function browserLogon(
  context: vscode.ExtensionContext,
  origin: string,
  serviceKey: unknown,
  key: ServiceKey,
  log?: (message: string) => void
): Promise<OAuthMaterial["tokens"] | undefined> {
  const host = hostOf(origin);
  const abort = new AbortController();
  try {
    const tokens = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `abap2UI5: log on to ${host} in your browser`,
        cancellable: true,
      },
      (_progress, cancel) => {
        cancel.onCancellationRequested(() => abort.abort());
        return logOnInBrowser({
          key,
          signal: abort.signal,
          openBrowser: (url) => Promise.resolve(vscode.env.openExternal(vscode.Uri.parse(url))),
          // a Remote host forwards the loopback port to the user's machine
          // (verify - docs/auth.md 3.3); identity on the local desktop
          externalRedirect: async (uri) => {
            const external = await vscode.env.asExternalUri(vscode.Uri.parse(uri));
            return external.toString(true);
          },
        });
      }
    );
    log?.(`logon: OAuth logon to ${host} in the browser, ${describeLifetime(tokens)}`);
    await storeRefreshToken(context, origin, serviceKey, tokens.refreshToken);
    return tokens;
  } catch (err) {
    if (abort.signal.aborted) {
      log?.(`logon: OAuth logon to ${host} cancelled`);
      return undefined;
    }
    throw err;
  }
}

/**
 * The picker: a service key JSON file, checked, and - when it was issued for
 * another host than the system's launch URL - a confirmation. Stored whole
 * in the SecretStorage, replacing an earlier key and its refresh token.
 */
async function chooseKeyFor(
  context: vscode.ExtensionContext,
  origin: string
): Promise<StoredOAuth | undefined> {
  const host = hostOf(origin);
  const picked = await vscode.window.showOpenDialog({
    title: `abap2UI5: Service Key for ${host}`,
    openLabel: "Use This Service Key",
    canSelectMany: false,
    filters: { "Service key": ["json", "txt"], "All files": ["*"] },
  });
  const file = picked?.[0]?.fsPath;
  if (!file) {
    return undefined;
  }
  let raw: unknown;
  let key: ServiceKey;
  try {
    const stat = await fs.stat(file);
    if (stat.size > SERVICE_KEY_MAX_BYTES) {
      throw new ServiceKeyError("the file is too large for a service key");
    }
    const text = (await fs.readFile(file, "utf8")).replace(/^﻿/, "");
    key = parseServiceKey(text);
    raw = JSON.parse(text);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `abap2UI5: cannot use this file as a service key - ${err instanceof Error ? err.message : String(err)}.`
    );
    return undefined;
  }
  const mismatch = keyOriginMismatch(key, origin);
  if (mismatch) {
    const use = `Use It for ${host}`;
    const pick = await vscode.window.showWarningMessage(
      `abap2UI5: ${mismatch}. On SAP BTP ABAP Environment the HTTP services can be served ` +
        "from another host of the same instance. Use this key's logon for the launch URL's host?",
      { modal: true },
      use
    );
    if (pick !== use) {
      return undefined;
    }
  }
  const stored: StoredOAuth = { serviceKey: raw };
  await writeStored(context, origin, stored);
  // findable for "Clear Stored SAP Credentials" after the system is gone
  await rememberOrigin(context, origin);
  return stored;
}

/**
 * "abap2UI5: Load Service Key" - for the active system's host. A running
 * proxy on that host is restarted, which logs on with the new key.
 */
export async function loadServiceKey(
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
  const stored = await chooseKeyFor(session.ctx, origin);
  if (!stored) {
    return;
  }
  session.log(`logon: service key for ${hostOf(origin)} loaded`);
  const kind = system.auth ?? "basic";
  const unused =
    kind !== "oauth"
      ? ` - ${system.name} logs on with "${kind}"; set "auth": "oauth" in its abap2ui5.systems entry to use it`
      : "";
  void vscode.window.showInformationMessage(
    `abap2UI5: service key for ${hostOf(origin)} stored${unused}.`
  );
  if (!unused && session.proxy.systemOrigin === origin) {
    await restart(system, origin);
  }
}
