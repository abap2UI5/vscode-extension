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
 *    compares against and decide nothing about security; `auth` is reserved.
 *    Nothing in a profile switches a check off - certificate trust and the
 *    agent switches are deliberately not profile fields.
 */

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
  /** RESERVED for further logon mechanisms. Only `"basic"` is accepted, and
   *  it changes nothing: basic authentication is what the proxy does. */
  auth?: "basic";
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
  if (auth === "basic") {
    fields.auth = "basic";
  } else if (auth) {
    notes.push(
      `"auth": ${shown(raw.auth)} is ignored - the field is reserved, and "basic" is the ` +
        "only value accepted so far"
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
