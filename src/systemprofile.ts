import { originOf } from "./urls";

/*
 * systemprofile - what one entry of `abap2ui5.systems` may say about its
 * system beyond name and launch URL, and what those words mean.
 *
 * `vscode`-free. The settings are hand-edited JSON and `systems` may come
 * from a workspace, so two rules hold for every field:
 *
 *  - tolerant: a field of the wrong type or with a value nobody knows is
 *    ignored and named in the log (`profileNotes`); the entry survives
 *  - a field can only TIGHTEN what the extension does. `role: "production"`
 *    refuses things; `minUi5` / `distribution` choose what the view check
 *    compares against and decide nothing about security; `auth` only
 *    CHOOSES the logon mechanism - every secret and every file behind it is
 *    the user's own, never the profile's - and a workspace cannot take a
 *    shadowed user profile's mechanism back to a password prompt
 *    (`tightenAuth`). Nothing in a profile switches a check off - certificate
 *    trust and the agent switches are deliberately not profile fields.
 */

/** The logon mechanisms a profile may name (docs/auth.md). Each one is a
 *  case of `strategyFor` (`logon.ts`). */
export const AUTH_KINDS = ["basic", "certificate", "oauth", "browser"] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];

export type SystemRole = "development" | "production";

/** The optional per-system facts of a profile. */
export interface ProfileFields {
  /** `production`: nothing may act on the system on the user's behalf - the
   *  agent app tools refuse `app_start` and `app_act` there. */
  role?: SystemRole;
  /** The UI5 version the system serves, `major.minor[.patch]`. While the
   *  system is active it stands in for `viewCheck.minUi5`. */
  minUi5?: string;
  /** The UI5 distribution the system serves; stands in for
   *  `viewCheck.distribution` while the system is active. */
  distribution?: "sapui5" | "openui5";
  /** How the proxy logs on to the system: `"basic"` (user and password,
   *  the default), `"certificate"` (an X.509 client certificate the user
   *  chooses per host) or `"oauth"` (OAuth 2.0 with a service key the user
   *  loads per host - SAP BTP ABAP Environment) or
   *  `"browser"` (a logon in a browser the extension
   *  starts, its session cookies replayed - `browserlogon.ts`). */
  auth?: AuthKind;
}

/** `a`, `a and b`, `a, b and c`. */
function listOf(words: string[]): string {
  return words.length < 3
    ? words.join(" and ")
    : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

const UI5_VERSION_RE = /^\d+\.\d+(\.\d+)?$/;

function read(entry: unknown): { fields: ProfileFields; notes: string[] } {
  const fields: ProfileFields = {};
  const notes: string[] = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { fields, notes };
  }
  const raw = entry as Record<string, unknown>;
  const shown = (value: unknown): string => {
    const text = typeof value === "string" ? `"${value}"` : JSON.stringify(value) ?? typeof value;
    return text.length > 40 ? `${text.slice(0, 40)}...` : text;
  };
  const word = (key: string): string | undefined => {
    const value = raw[key];
    if (value === undefined || value === null || value === "") {
      return undefined;
    }
    if (typeof value !== "string") {
      notes.push(`"${key}": ${shown(value)} is not a string - ignored`);
      return undefined;
    }
    return value.trim() || undefined;
  };

  const role = word("role")?.toLowerCase();
  if (role === "development" || role === "production") {
    fields.role = role;
  } else if (role) {
    notes.push(
      `"role": ${shown(raw.role)} is not "development" or "production" - ignored`
    );
  }

  const minUi5 = word("minUi5");
  if (minUi5 && UI5_VERSION_RE.test(minUi5)) {
    fields.minUi5 = minUi5;
  } else if (minUi5) {
    notes.push(`"minUi5": ${shown(raw.minUi5)} is not a UI5 version like "1.120" - ignored`);
  }

  const distribution = word("distribution")?.toLowerCase();
  if (distribution === "sapui5" || distribution === "openui5") {
    fields.distribution = distribution;
  } else if (distribution) {
    notes.push(
      `"distribution": ${shown(raw.distribution)} is not "sapui5" or "openui5" - ignored`
    );
  }

  const auth = word("auth")?.toLowerCase();
  if (auth && (AUTH_KINDS as readonly string[]).includes(auth)) {
    fields.auth = auth as AuthKind;
  } else if (auth) {
    notes.push(
      `"auth": ${shown(raw.auth)} is ignored - the values accepted so far are ` +
        listOf(AUTH_KINDS.map((kind) => `"${kind}"`))
    );
  }
  return { fields, notes };
}

/** The profile fields one `systems` entry carries - only the ones that hold
 *  a usable value, so an entry of name and url alone adds nothing. */
export function profileFieldsOf(entry: unknown): ProfileFields {
  return read(entry).fields;
}

/**
 * What was ignored in a `systems` value, one line per field, for the log.
 * Apart from `profilesFrom` on purpose: the profiles are read on every F9,
 * status-bar update and check, the notes once per change of the setting.
 */
export function profileNotes(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  raw.forEach((entry, index) => {
    const name =
      entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string"
        ? `'${String((entry as { name: string }).name).trim()}'`
        : `#${index + 1}`;
    for (const note of read(entry).notes) {
      out.push(`system ${name}: ${note}`);
    }
  });
  return out;
}

/**
 * The profiles in effect, with `production` kept from the settings scopes
 * the effective value SHADOWS.
 *
 * `abap2ui5.systems` is one array, and a workspace's value replaces the
 * user's whole list - so a repository could restate a system the user marked
 * as production without the mark, and loosen it that way. A system on the
 * origin of a shadowed production profile therefore stays production. By
 * origin, not by URL: another client or one more parameter must not be a way
 * around it. Only shadowed scopes count - within one list, two profiles on
 * one host keep what each of them says.
 */
export function tightenRoles<T extends { template: string; role?: SystemRole }>(
  effective: readonly T[],
  shadowed: ReadonlyArray<{ template: string; role?: SystemRole }>
): T[] {
  const production = new Set<string>();
  for (const profile of shadowed) {
    const origin = profile.role === "production" ? originOf(profile.template) : undefined;
    if (origin) {
      production.add(origin);
    }
  }
  if (!production.size) {
    return [...effective];
  }
  return effective.map((profile) => {
    const origin = originOf(profile.template);
    return profile.role !== "production" && origin && production.has(origin)
      ? { ...profile, role: "production" as const }
      : profile;
  });
}

/**
 * The profiles in effect, with a logon mechanism other than basic kept from
 * the settings scopes the effective value SHADOWS - `tightenRoles` for
 * `auth`.
 *
 * A workspace's `systems` list replaces the user's, so without this a
 * repository could restate a certificate (or SSO) host as a plain entry and
 * have the extension prompt for a password on an origin that normally never
 * asks for one - a nudge to type an SSO password into a prompt. A system on
 * the origin of a shadowed profile that names a non-basic mechanism therefore
 * logs on with that mechanism; the nearest shadowed scope wins when two name
 * different ones. By origin, like the roles.
 */
export function tightenAuth<T extends { template: string; auth?: AuthKind }>(
  effective: readonly T[],
  shadowed: ReadonlyArray<{ template: string; auth?: AuthKind }>
): T[] {
  const kept = new Map<string, AuthKind>();
  for (const profile of shadowed) {
    const origin =
      profile.auth && profile.auth !== "basic" ? originOf(profile.template) : undefined;
    if (origin && !kept.has(origin)) {
      kept.set(origin, profile.auth!);
    }
  }
  if (!kept.size) {
    return [...effective];
  }
  return effective.map((profile) => {
    const origin = originOf(profile.template);
    const auth = origin ? kept.get(origin) : undefined;
    return auth && profile.auth !== auth ? { ...profile, auth } : profile;
  });
}

/** The status bar text of the running app: the class, and the role of the
 *  system it runs on when its profile names one. */
export function statusText(className: string, role: SystemRole | undefined): string {
  return `$(play-circle) ${className}` + (role ? ` · ${role}` : "");
}

/** The tooltip's line about the role - "" when the profile names none. */
export function roleLine(role: SystemRole | undefined): string {
  return role === "production"
    ? 'Role: **production** (`"role": "production"` in `abap2ui5.systems`) - the agent app tools refuse to start or operate apps here.'
    : role === "development"
      ? "Role: development"
      : "";
}

/**
 * The `systems` list with the detected UI5 version written into the entry
 * whose `url` is `template` - undefined when no entry carries it (the system
 * then comes from `launchUrlTemplate`, which has no profile to write into)
 * or nothing would change. Every other key of the entry is kept as written.
 */
export function withDetectedUi5(
  list: unknown,
  template: string,
  detected: { minUi5: string; distribution?: string }
): unknown[] | undefined {
  if (!Array.isArray(list)) {
    return undefined;
  }
  const urlOf = (entry: unknown): string => {
    const url = (entry as { url?: unknown } | null)?.url;
    return typeof url === "string" ? url.trim() : "";
  };
  const at = list.findIndex((entry) => !!entry && typeof entry === "object" && urlOf(entry) === template);
  if (at < 0) {
    return undefined;
  }
  const before = list[at] as Record<string, unknown>;
  const after: Record<string, unknown> = { ...before, minUi5: detected.minUi5 };
  if (detected.distribution) {
    after.distribution = detected.distribution;
  }
  if (before.minUi5 === after.minUi5 && before.distribution === after.distribution) {
    return undefined;
  }
  const next = [...list];
  next[at] = after;
  return next;
}

/** Whether `template` is an entry of the `systems` list (as opposed to the
 *  single `launchUrlTemplate`). */
export function isListedSystem(list: unknown, template: string): boolean {
  return (
    Array.isArray(list) &&
    list.some(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as { url?: unknown }).url === "string" &&
        (entry as { url: string }).url.trim() === template
    )
  );
}
