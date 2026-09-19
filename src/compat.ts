/*
 * The bundled linter's compatibility record, and what it says about a
 * workspace's framework pin.
 *
 * Three versions are pinned independently across the ecosystem: the abap2UI5
 * release an app's `abaplint.jsonc` clones (`dependencies[].branch`), the
 * linter this extension bundles, and the UI5 release its metadata snapshot
 * was generated at. The linter states its side of that in `data/compat.json`
 * (its `./compat` export): the oldest framework release whose client API its
 * rules assume, the release its mirrors were last synced against, and the
 * UI5 floor and snapshot. A project pinned BELOW that minimum is judged
 * against `z2ui5_cl_ui5_view_builder` and `client->get_event( )` on a release
 * that has neither - findings that cannot be right, and no signal why.
 *
 * `esbuild.js` copies the record next to the bundle, exactly as it does the
 * UI5 snapshot (`snapshot.ts`), because a bundled `.mjs` cannot resolve its
 * own package's data directory. A linter pin older than the record does not
 * ship the file at all, and everything here degrades to "no record": the
 * activation line says so, and nothing else happens. The web build answers
 * null too - its `fs` is a shim.
 *
 * `vscode`-free: the pin parser is shared with `scaffold.ts` (which names the
 * template's pin in the scaffolded guide), and the verdict is data the test
 * suite runs over fixtures.
 */

import * as fs from "fs";
import * as path from "path";

/** The record's shape - `@abap2ui5/linter/compat`'s `Compat`, validated on
 *  read because the file is data. The import of the linter's own typing
 *  waits for a pin that ships the export; until then an older pin would make
 *  `tsc` fail on a module it does not declare. */
export interface CompatRecord {
  /** What the file is, who reads it and how it is regenerated. */
  note?: string;
  /** The linter's version (its package.json). */
  linter: string;
  framework: {
    /** The oldest abap2UI5 release whose released client API the rules assume. */
    minimum: string;
    /** The abap2UI5 release the linter's hand-maintained mirrors were last synced against. */
    mirrored: string;
  };
  ui5: {
    /** The default UI5 version the gate judges against. */
    floor: string;
    /** The version the metadata snapshot was generated at. */
    snapshot: string;
  };
}

const FILE = path.join(__dirname, "compat.json");

let cached: CompatRecord | null | undefined;

/** The record, out of a parsed file - null for anything that is not one. */
export function compatOf(parsed: unknown): CompatRecord | null {
  const o = parsed as Partial<CompatRecord> | null;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (
    !o ||
    typeof o !== "object" ||
    !str(o.linter) ||
    !o.framework ||
    !str(o.framework.minimum) ||
    !str(o.framework.mirrored) ||
    !o.ui5 ||
    !str(o.ui5.floor) ||
    !str(o.ui5.snapshot)
  ) {
    return null;
  }
  return {
    note: typeof o.note === "string" ? o.note : undefined,
    linter: o.linter,
    framework: { minimum: o.framework.minimum, mirrored: o.framework.mirrored },
    ui5: { floor: o.ui5.floor, snapshot: o.ui5.snapshot },
  };
}

/** The bundled linter's compatibility record, read once from next to the
 *  bundle - null when the pinned linter ships none, when the copy is missing
 *  or unreadable, and in the web build. Never a throw: the caller is the
 *  activation itself. */
export function readCompat(): CompatRecord | null {
  if (cached === undefined) {
    try {
      cached = compatOf(JSON.parse(fs.readFileSync(FILE, "utf8")));
    } catch {
      cached = null;
    }
  }
  return cached;
}

// ---------------------------------------------------------------------------
// The framework pin in an abaplint.jsonc
// ---------------------------------------------------------------------------

/** The dependency url that names the framework - with or without `.git`, a
 *  trailing slash, in any case. */
const FRAMEWORK_URL_RE = /abap2ui5\/abap2ui5(\.git)?\/?$/i;

/** Where the pin is in the text - the `branch` value of the dependency whose
 *  url names abap2UI5/abap2UI5, with the offset and length of the value so a
 *  diagnostic lands on it. Undefined when there is no such dependency or it
 *  carries no `branch` (abaplint then clones the default branch). Comments
 *  are what abaplint.jsonc is full of, so the objects are read as flat
 *  `{ ... }` spans: a dependency has no nested object. */
export function frameworkPinAt(
  text: string
): { branch: string; offset: number; length: number } | undefined {
  const objects = /\{[^{}]*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objects.exec(text))) {
    const url = /"url"\s*:\s*"([^"]*)"/.exec(m[0]);
    if (!url || !FRAMEWORK_URL_RE.test(url[1].trim())) {
      continue;
    }
    const branch = /"branch"\s*:\s*"([^"]*)"/.exec(m[0]);
    if (!branch) {
      return undefined;
    }
    // the value ends right before the closing quote - so an empty "" still
    // gets a position, not a lastIndexOf("") past the end
    const value = branch[0].length - 1 - branch[1].length;
    return {
      branch: branch[1],
      offset: m.index + branch.index + value,
      length: branch[1].length,
    };
  }
  return undefined;
}

/** The pin alone - empty when the config has none. */
export function frameworkPinOf(text: string): string {
  return frameworkPinAt(text)?.branch ?? "";
}

// ---------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------

/** `1.144.0` (a leading `v` tolerated) as three numbers - undefined for
 *  anything else: a branch name, a tag with a suffix, an empty pin. */
export function releaseParts(tag: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** -1, 0 or 1 for two release tags; undefined when either is not one, so a
 *  pin on `main` is never "below" anything. */
export function compareRelease(a: string, b: string): -1 | 0 | 1 | undefined {
  const pa = releaseParts(a);
  const pb = releaseParts(b);
  if (!pa || !pb) {
    return undefined;
  }
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export type CompatVerdict = { ok: true } | { ok: false; message: string };

/** Whether a workspace pinned to `pin` is one the bundled linter can judge.
 *  Only a release tag below the record's minimum is a finding: no record
 *  (an older linter), no pin (the default branch, which is newer than any
 *  minimum) and a branch name all compare to nothing. */
export function compatVerdict(compat: CompatRecord | null, pin: string): CompatVerdict {
  if (!compat) {
    return { ok: true };
  }
  const below = compareRelease(pin, compat.framework.minimum);
  if (below === undefined || below >= 0) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `abaplint.jsonc pins abap2UI5 ${pin.trim()}, below the ${compat.framework.minimum} ` +
      `the bundled linter ${compat.linter} assumes - its rules judge against a ` +
      "client API that release does not have. Bump the \"branch\" in " +
      `abaplint.jsonc to ${compat.framework.minimum} or newer and run npm run check.`,
  };
}

/** The finding over a whole abaplint.jsonc: where the pin is and what to say
 *  about it - undefined when there is nothing to say. */
export function compatFinding(
  compat: CompatRecord | null,
  abaplintJsoncText: string
): { offset: number; length: number; message: string } | undefined {
  const pin = frameworkPinAt(abaplintJsoncText);
  if (!pin) {
    return undefined;
  }
  const verdict = compatVerdict(compat, pin.branch);
  return verdict.ok
    ? undefined
    : { offset: pin.offset, length: pin.length, message: verdict.message };
}

/** The one line the output channel and "Show MCP Status" print about the
 *  bundled linter's assumptions. */
export function compatLine(compat: CompatRecord | null): string {
  if (!compat) {
    return "the bundled linter ships no compatibility record";
  }
  return (
    `linter ${compat.linter} assumes abap2UI5 >= ${compat.framework.minimum} ` +
    `(mirrors ${compat.framework.mirrored}), UI5 snapshot ${compat.ui5.snapshot}`
  );
}
