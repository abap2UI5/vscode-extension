/*
 * The vocabulary both halves of the position analysis share: the answer a
 * context call gives (`WriteContext`), the library an undecorated control
 * name belongs to, and how a written name splits into prefix and local part.
 *
 * Split out of `context.ts`, which re-exports it - import from there. A leaf:
 * it imports nothing, so the ABAP side (`contextchain.ts`) and the XML side
 * (`contextxml.ts`) can both build on it without a cycle. `vscode`-free.
 */

/** Which of the three writable positions the cursor sits in. */
export type ContextKind = "control" | "member" | "value" | "namespace";

export interface WriteContext {
  kind: ContextKind;
  /** Library-qualified control, e.g. `sap.m.Button` — when it could be
   *  resolved. For `kind === "control"` this is what is being typed. */
  control?: string;
  /** The member whose value is being written (`kind === "value"`). */
  member?: string;
  /** The library a completed control name would land in (`kind ===
   *  "control"`), derived from the namespace in play. */
  library?: string;
  /** What is already typed inside the literal. */
  prefix: string;
  /** The literal's content span, i.e. the range a completion replaces. */
  start: number;
  end: number;
}

/** The prefix an undecorated control name belongs to when the source declares
 *  no default namespace of its own — every abap2UI5 view starts from sap.m. */
export const DEFAULT_LIBRARY = "sap.m";

/** Library for a namespace prefix, falling back to sap.m for the default one
 *  so a view that never declares anything still completes usefully. */
export function libraryOf(map: Record<string, string>, prefix: string): string {
  return map[prefix] ?? (prefix ? "" : DEFAULT_LIBRARY);
}

/** Splits a written control name into its prefix and local name — the builder
 *  accepts `core:Icon` as well as `ns = \`core\`` + `n = \`Icon\``. */
export function splitName(name: string): { prefix: string; local: string } {
  const ix = name.indexOf(":");
  return ix > 0
    ? { prefix: name.slice(0, ix), local: name.slice(ix + 1) }
    : { prefix: "", local: name };
}
