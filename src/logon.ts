import {
  AuthStrategy,
  BasicAuthStrategy,
  CertificateAuthStrategy,
  ClientCertificateMaterial,
  InteractiveLogonRequired,
} from "./authstrategy";
import type { AuthKind } from "./systemprofile";
import { OAuthMaterial, OAuthStrategy } from "./oauth";
import { BrowserLogonStrategy, BrowserSession } from "./browserlogon";

/*
 * logon - which `AuthStrategy` a system profile logs on with.
 *
 * `vscode`-free. `strategyFor` is the ONE place a profile's `auth` word turns
 * into a strategy; every flow that starts the proxy (F9, the connection
 * check, the re-logon, the connect flow of "Run an App from the System" and
 * the MCP tools) goes through it, so no call site assumes a password. Where
 * the secrets come from - prompts, the SecretStorage, a file - is the
 * caller's (`deps`), so each mechanism is one more case below and one more
 * dependency, never a second code path.
 */

/** What a mechanism needs from the host. Each answers undefined when the
 *  user cancelled; a flow without a UI throws {@link InteractiveLogonRequired}
 *  instead of asking. */
export interface LogonDeps {
  /** User and password for `origin` - asking once (basic). */
  basicCredentials(origin: string): Promise<{ user: string; pass: string } | undefined>;
  /** The client certificate chosen for `origin`, read and checked
   *  (certificate) - asking for one when none is chosen yet. */
  clientCertificate(origin: string): Promise<ClientCertificateMaterial | undefined>;
  /** The OAuth logon for `origin` (oauth): the loaded service key and the
   *  tokens - renewed with the stored refresh token, or obtained in the
   *  browser when the flow may ask. */
  oauthLogon(origin: string): Promise<OAuthMaterial | undefined>;
  /** The live browser logon of `origin` (browser) - opening the browser
   *  when there is none; a flow without a UI is refused instead
   *  (`browserLogonNeeded`). */
  browserSession(origin: string): Promise<BrowserSession | undefined>;
}

/** The profile fields the factory reads. */
export interface LogonProfile {
  auth?: AuthKind;
}

/**
 * The strategy `profile` logs on to `origin` with, or undefined when the
 * user cancelled a prompt. A profile without `auth` is basic - what every
 * profile meant before the field existed.
 */
export async function strategyFor(
  profile: LogonProfile,
  origin: string,
  deps: LogonDeps
): Promise<AuthStrategy | undefined> {
  const kind: AuthKind = profile.auth ?? "basic";
  switch (kind) {
    case "certificate": {
      const material = await deps.clientCertificate(origin);
      return material ? new CertificateAuthStrategy(material) : undefined;
    }
    case "oauth": {
      const material = await deps.oauthLogon(origin);
      return material ? new OAuthStrategy(material) : undefined;
    }
    case "browser": {
      const session = await deps.browserSession(origin);
      return session ? new BrowserLogonStrategy(origin, session) : undefined;
    }
    case "basic": {
      const creds = await deps.basicCredentials(origin);
      return creds ? new BasicAuthStrategy(creds.user, creds.pass) : undefined;
    }
    default: {
      // a kind added to AUTH_KINDS without a case here fails `tsc`
      const unknownKind: never = kind;
      throw new Error(`no logon strategy for "${String(unknownKind)}"`);
    }
  }
}

/** The logon mechanism of a profile, as the messages and the bug report
 *  name it. */
export function authKindOf(profile: LogonProfile): AuthKind {
  return profile.auth ?? "basic";
}

/**
 * Every per-origin SecretStorage key of every mechanism - what "Clear Stored
 * SAP Credentials" deletes for an origin. `user`/`pass` are basic auth's
 * (their shape is a contract, see `keysFor` in `systems.ts`); `cert` holds a
 * client certificate's passphrase; `oauth` holds the loaded service key and
 * the refresh token of OAuth (`StoredOAuth` in `oauth.ts`); `session` is
 * reserved for the browser logon (docs/auth.md, section 4).
 */
export function secretKeysFor(origin: string): {
  user: string;
  pass: string;
  cert: string;
  session: string;
  oauth: string;
} {
  return {
    user: `abap2ui5.user:${origin}`,
    pass: `abap2ui5.pass:${origin}`,
    cert: `abap2ui5.cert:${origin}`,
    session: `abap2ui5.session:${origin}`,
    oauth: `abap2ui5.oauth:${origin}`,
  };
}

/** The refusal of a flow without a UI (the MCP tools) for a certificate
 *  nobody has chosen yet - it names the two places that can ask. */
export function certificateNeeded(host: string): InteractiveLogonRequired {
  return new InteractiveLogonRequired(
    `no client certificate is chosen for ${host} - press F9 in VS Code or run ` +
      '"abap2UI5: Choose Client Certificate" first'
  );
}

/** The refusal of a flow without a UI (the MCP tools) for an OAuth system
 *  with no usable logon - no service key loaded, or no refresh token that
 *  still works. It never opens a browser; it names the places that can. */
export function oauthLogonNeeded(host: string, keyLoaded: boolean): InteractiveLogonRequired {
  return new InteractiveLogonRequired(
    keyLoaded
      ? `no valid OAuth logon for ${host} - press F9 in VS Code to log on in the browser first`
      : `no service key is loaded for ${host} - run "abap2UI5: Load Service Key" in VS Code, ` +
          "then press F9 to log on in the browser"
  );
}
