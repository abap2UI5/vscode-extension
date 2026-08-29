import * as vscode from "vscode";
import { CONFIG_SECTION } from "./settings";
import { isUsableTemplate, originOf, shortUrl } from "./urls";

/*
 * The systems the extension can launch against.
 *
 * A single `launchUrlTemplate` covers exactly one system, which is not how
 * anybody works: there is a sandbox, a development system, and often a second
 * client on one of them. `abap2ui5.systems` holds them as named profiles, the
 * active one lives in the window's state (so two windows can point at two
 * systems at once), and the old single setting keeps working as the profile
 * used when the list is empty.
 *
 * Credentials follow the system, not the extension: they are stored per
 * origin in the SecretStorage, so switching systems does not mean re-entering
 * a password that is already known.
 */

const TEMPLATE_KEY = "launchUrlTemplate";
const SYSTEMS_KEY = "systems";
const ACTIVE_KEY = "abap2ui5.activeSystem";

/** The pre-0.14 secret keys - one user, one password, no origin. They are
 *  migrated to the origin-scoped ones on first use, so an existing install
 *  is not asked for its password again. */
const LEGACY_USER = "abap2ui5.user";
const LEGACY_PASS = "abap2ui5.pass";

export interface SystemProfile {
  /** What the picker and the status bar show. */
  name: string;
  /** URL template with the `{class}` placeholder. */
  template: string;
}

function config() {
  return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

/** The configured profiles. A malformed entry is skipped rather than
 *  breaking the picker - the setting is hand-edited JSON. */
export function systems(): SystemProfile[] {
  const raw = config().get<Array<{ name?: string; url?: string }>>(SYSTEMS_KEY, []);
  const list: SystemProfile[] = [];
  for (const entry of raw ?? []) {
    const template = (entry?.url ?? "").trim();
    if (!isUsableTemplate(template)) {
      continue;
    }
    list.push({ name: (entry.name ?? "").trim() || shortUrl(template), template });
  }
  return list;
}

/** The single-setting profile, i.e. what every version before the list had. */
function singleSystem(): SystemProfile | undefined {
  const template = config().get<string>(TEMPLATE_KEY, "").trim();
  return template ? { name: shortUrl(template), template } : undefined;
}

/** Every profile that can be launched: the list, plus the single setting when
 *  it names a system the list does not already contain. */
export function allSystems(): SystemProfile[] {
  const list = systems();
  const single = singleSystem();
  const all =
    single && !list.some((s) => s.template === single.template)
      ? [single, ...list]
      : list;
  return withUniqueNames(all);
}

/**
 * The name is how a system is addressed - the picker shows it, the active one
 * is remembered by it, and a running app records which one it came from. Two
 * profiles configured with the SAME name therefore both resolved to the first:
 * the second could not be activated at all, and its checkmark sat on its
 * twin. Rather than refuse the configuration, the later one is numbered.
 */
function withUniqueNames(all: SystemProfile[]): SystemProfile[] {
  const seen = new Map<string, number>();
  return all.map((system) => {
    const taken = seen.get(system.name) ?? 0;
    seen.set(system.name, taken + 1);
    return taken ? { ...system, name: `${system.name} (${taken + 1})` } : system;
  });
}

/** The system F9 launches against. */
export function activeSystem(
  context: vscode.ExtensionContext
): SystemProfile | undefined {
  const all = allSystems();
  const chosen = context.workspaceState.get<string>(ACTIVE_KEY);
  return all.find((s) => s.name === chosen) ?? all[0];
}

async function setActive(
  context: vscode.ExtensionContext,
  system: SystemProfile
): Promise<void> {
  await context.workspaceState.update(ACTIVE_KEY, system.name);
}

// ---------------------------------------------------------------------------
// Asking for a launch URL
// ---------------------------------------------------------------------------

/** Asks for a launch URL template and validates it as it is typed. */
export async function askForTemplate(current: string): Promise<string | undefined> {
  const answer = (
    (await vscode.window.showInputBox({
      title: "abap2UI5: Set launch URL",
      prompt: "URL template with {class} as the placeholder",
      value:
        current ||
        "https://host:44300/sap/bc/z2ui5?app_start={class}&sap-client=100",
      ignoreFocusOut: true,
      validateInput: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return "The launch URL must not be empty.";
        }
        if (!/\{class\}/i.test(trimmed)) {
          return "The URL needs the {class} placeholder.";
        }
        return isUsableTemplate(trimmed) ? undefined : "That is not a valid URL.";
      },
    })) ?? ""
  ).trim();
  return answer || undefined;
}

/** Stores a launch URL: into the profile list when one is already in use
 *  (replacing the entry of the given name), into the single setting
 *  otherwise - so the simple case stays simple. */
export async function storeTemplate(name: string, template: string): Promise<void> {
  const cfg = config();
  const list = cfg.get<Array<{ name?: string; url?: string }>>(SYSTEMS_KEY, []) ?? [];
  if (list.length) {
    const next = list.filter((entry) => entry?.name !== name);
    next.push({ name, url: template });
    await cfg.update(SYSTEMS_KEY, next, vscode.ConfigurationTarget.Global);
    return;
  }
  await cfg.update(TEMPLATE_KEY, template, vscode.ConfigurationTarget.Global);
}

/** The launch URL of the active system, asking for one when nothing is
 *  configured yet. */
export async function ensureSystem(
  context: vscode.ExtensionContext
): Promise<SystemProfile | undefined> {
  const active = activeSystem(context);
  if (active) {
    return active;
  }
  const template = await askForTemplate("");
  if (!template) {
    return undefined;
  }
  await storeTemplate(shortUrl(template), template);
  return activeSystem(context);
}

/**
 * The system picker: every configured profile, plus the two ways to get a new
 * one. Also the place a second system is added from, so nobody has to find
 * the JSON setting to do it.
 */
export async function pickSystem(
  context: vscode.ExtensionContext
): Promise<SystemProfile | undefined> {
  const all = allSystems();
  const active = activeSystem(context);
  const items: Array<vscode.QuickPickItem & { system?: SystemProfile; add?: boolean }> =
    all.map((system) => ({
      label: system.name === active?.name ? `$(check) ${system.name}` : system.name,
      description: shortUrl(system.template),
      system,
    }));
  items.push({
    label: "$(add) Add a system...",
    description: "asks for a name and a launch URL",
    add: true,
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: "abap2UI5: system to launch against",
    placeHolder: active ? `Currently: ${active.name}` : "No system configured yet",
    // the host under the name is just as recognisable as the name itself,
    // especially when the profiles are "DEV" and "DEV (2)"
    matchOnDescription: true,
  });
  if (!pick) {
    return undefined;
  }
  if (pick.add) {
    const name = (
      (await vscode.window.showInputBox({
        title: "abap2UI5: name of the system",
        prompt: "Shown in the picker and the status bar, e.g. DEV or Sandbox",
        ignoreFocusOut: true,
      })) ?? ""
    ).trim();
    if (!name) {
      return undefined;
    }
    const template = await askForTemplate("");
    if (!template) {
      return undefined;
    }
    // The name is how the active system is resolved, so a duplicate would
    // activate its TWIN instead of the system just added - numbered here,
    // the same way withUniqueNames presents two configured twins.
    const taken = new Set(allSystems().map((system) => system.name));
    let unique = name;
    for (let i = 2; taken.has(unique); i++) {
      unique = `${name} (${i})`;
    }
    // Adding a second system turns the single setting into the first entry of
    // the list, so both end up in the same place.
    const cfg = config();
    const existing =
      cfg.get<Array<{ name?: string; url?: string }>>(SYSTEMS_KEY, []) ?? [];
    if (!existing.length) {
      const single = singleSystem();
      if (single) {
        existing.push({ name: single.name, url: single.template });
      }
    }
    existing.push({ name: unique, url: template });
    await cfg.update(SYSTEMS_KEY, existing, vscode.ConfigurationTarget.Global);
    const added = { name: unique, template };
    await setActive(context, added);
    return added;
  }
  if (pick.system) {
    await setActive(context, pick.system);
    return pick.system;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Credentials, per system
// ---------------------------------------------------------------------------

/** Secrets are keyed by origin: two clients on one host share a logon, two
 *  hosts do not. */
function keysFor(origin: string): { user: string; pass: string } {
  return { user: `abap2ui5.user:${origin}`, pass: `abap2ui5.pass:${origin}` };
}

export interface Credentials {
  user: string;
  pass: string;
}

/**
 * The credentials for one origin, asking for them once. A pre-0.14 install
 * has them under the old unscoped keys; those are adopted for the first
 * origin asked about and then removed, so nobody is prompted twice for a
 * password the extension already holds.
 */
export async function ensureCredentials(
  context: vscode.ExtensionContext,
  origin: string
): Promise<Credentials | undefined> {
  const secrets = context.secrets;
  const keys = keysFor(origin);
  let user = await secrets.get(keys.user);
  let pass = await secrets.get(keys.pass);

  if (!user && !pass) {
    const legacyUser = await secrets.get(LEGACY_USER);
    const legacyPass = await secrets.get(LEGACY_PASS);
    if (legacyUser && legacyPass) {
      await secrets.store(keys.user, legacyUser);
      await secrets.store(keys.pass, legacyPass);
      await secrets.delete(LEGACY_USER);
      await secrets.delete(LEGACY_PASS);
      // the migrated origin has to be findable for "Reset Credentials" too -
      // without this, credentials of a system later removed from the settings
      // were out of every deletion path's reach
      await rememberOrigin(context, origin);
      user = legacyUser;
      pass = legacyPass;
    }
  }

  if (!user) {
    user = await vscode.window.showInputBox({
      title: `abap2UI5: SAP user for ${originOf(origin) ?? origin}`,
      prompt: "User for logging on to the SAP system (same as in ADT)",
      ignoreFocusOut: true,
    });
    if (!user) {
      return undefined;
    }
    await secrets.store(keys.user, user);
    await rememberOrigin(context, origin);
  }

  if (!pass) {
    pass = await vscode.window.showInputBox({
      title: `abap2UI5: SAP password for ${originOf(origin) ?? origin}`,
      prompt: "Password (stored securely in the VS Code SecretStorage)",
      password: true,
      ignoreFocusOut: true,
    });
    if (!pass) {
      return undefined;
    }
    await secrets.store(keys.pass, pass);
    await rememberOrigin(context, origin);
  }

  return { user, pass };
}

/**
 * Origins this extension has stored credentials for. SecretStorage cannot be
 * enumerated, so a system removed from the settings used to take its password
 * out of reach: "Reset Credentials" only walked the CONFIGURED systems, and
 * nothing else could ever delete it.
 */
const STORED_ORIGINS_KEY = "abap2ui5.credentialOrigins";

async function rememberOrigin(
  context: vscode.ExtensionContext,
  origin: string
): Promise<void> {
  const known = context.globalState.get<string[]>(STORED_ORIGINS_KEY, []);
  if (!known.includes(origin)) {
    await context.globalState.update(STORED_ORIGINS_KEY, [...known, origin]);
  }
}

/** Forgets the credentials of one origin, or of every system this extension
 *  has ever stored some for - configured today or not. */
export async function clearCredentials(
  context: vscode.ExtensionContext,
  origin?: string
): Promise<void> {
  const origins = origin
    ? [origin]
    : [
        ...new Set([
          ...allSystems()
            .map((s) => originOf(s.template))
            .filter((o): o is string => !!o),
          ...context.globalState.get<string[]>(STORED_ORIGINS_KEY, []),
        ]),
      ];
  for (const each of origins) {
    const keys = keysFor(each);
    await context.secrets.delete(keys.user);
    await context.secrets.delete(keys.pass);
  }
  await context.secrets.delete(LEGACY_USER);
  await context.secrets.delete(LEGACY_PASS);
  if (!origin) {
    await context.globalState.update(STORED_ORIGINS_KEY, undefined);
  } else {
    const known = context.globalState.get<string[]>(STORED_ORIGINS_KEY, []);
    await context.globalState.update(
      STORED_ORIGINS_KEY,
      known.filter((each) => each !== origin)
    );
  }
}
