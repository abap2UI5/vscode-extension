/*
 * ABAP source helpers.
 *
 * Everything here is a pure function over source text — no `vscode` import,
 * on purpose: these are the pieces the test suite can exercise directly, and
 * they are also the pieces that used to be one-off regexes scattered across
 * `extension.ts` and `viewcheck.ts`, where they drifted apart.
 */

/**
 * What makes a class an abap2UI5 app. The colon is what the first version of
 * this regex missed: `INTERFACES: z2ui5_if_app.` is the chained form and just
 * as common as the plain one, and F9 silently fell through to "toggle
 * breakpoint" for every class written that way. `\s` covers the newline, so
 * the interface may sit on the line after the colon.
 */
export const APP_INTERFACE_RE = /\binterfaces\s*:?\s*z2ui5_if_app\b/i;

/** True when the source implements `z2ui5_if_app` — the F9 launch condition. */
export function isAppClass(source: string): boolean {
  return APP_INTERFACE_RE.test(source);
}

/**
 * The generic builder, the only one the linter reconstructs views from.
 * `z2ui5_cl_xml_view` — the typed builder — is on its way out of abap2UI5 and
 * deliberately not checked.
 */
export const BUILDER_FACTORY_RE = /z2ui5_cl_ui5_view_builder\s*=>\s*factory/i;

/** True when the source builds its view with the generic builder. */
export function usesBuilder(source: string): boolean {
  return BUILDER_FACTORY_RE.test(source);
}

/*
 * The class name, upper-cased — what the launch URL's `{class}` is replaced
 * with. Anchored at the start of a line (leading whitespace allowed) so that
 * a `CLASS … DEFINITION` quoted inside a comment does not win over the real
 * one: both ABAP comment forms (`*` in column 1 and a leading `"`) put a
 * character other than whitespace in front of the keyword.
 */
const CLASS_DEF_RE = /^[ \t]*class\s+(\S+)\s+definition/im;

/** Class name from the source, falling back to the file name. Upper case. */
export function classNameOf(source: string, fileName: string): string {
  const match = source.match(CLASS_DEF_RE);
  if (match) {
    return match[1].toUpperCase();
  }
  const base = fileName.replace(/^.*[\\/]/, "");
  return base
    .replace(/\.clas\.abap$/i, "")
    .replace(/\.abap$/i, "")
    .toUpperCase();
}

/**
 * Character offset of the class definition, for the CodeLens anchor. Returns
 * 0 when the source has none, so the lens still lands somewhere sensible.
 */
export function classDefinitionOffset(source: string): number {
  const match = CLASS_DEF_RE.exec(source);
  return match?.index ?? 0;
}

/**
 * Where a binding path is declared in the class - the target of Go to
 * Definition on `{/MT_TRAVELS/STATUS}`.
 *
 * Deliberately shallow: a path with more than one segment looks for the
 * LAST segment as a field inside any `TYPES BEGIN OF … END OF` block (that
 * is where the row fields live), and falls back to - or starts with, for a
 * single segment - the root variable's `… TYPE …` declaration. Following
 * the type chain precisely is the linter's business; for the jump, the
 * declaration line of the name under the cursor is what helps.
 */
export function declarationSpan(
  source: string,
  path: string
): { start: number; end: number } | undefined {
  const segments = path.split("/").filter(Boolean);
  if (!segments.length) {
    return undefined;
  }
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if (segments.length > 1) {
    const field = segments[segments.length - 1];
    for (const block of source.matchAll(/BEGIN OF \w+\s*,([\s\S]*?)END OF/gi)) {
      const m = new RegExp(`\\b(${escape(field)})\\s+TYPE\\b`, "i").exec(block[1]);
      if (m) {
        const start = (block.index ?? 0) + block[0].indexOf(block[1]) + m.index;
        return { start, end: start + field.length };
      }
    }
  }
  const root = segments[0];
  const m = new RegExp(`\\b(${escape(root)})\\s+TYPE\\b`, "i").exec(source);
  return m ? { start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + root.length } : undefined;
}

/**
 * Every METHOD implementation in the source, with the offset of its name -
 * what the workspace symbol search and "go to method" navigate to. ABAP
 * method names may carry `~` (interface implementations) and `/` (namespaced
 * interfaces), so the name class is wider than `\w`.
 */
export function methodImplementations(
  source: string
): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  for (const m of source.matchAll(/^[ \t]*METHOD\s+([\w~/]+)\s*[.\n]/gim)) {
    const start = m.index + m[0].indexOf(m[1]);
    out.push({ name: m[1], start, end: start + m[1].length });
  }
  return out;
}

/**
 * Tokens in a runtime error message worth looking up in the class: binding
 * paths (`/MT_TRAVELS/STATUS`) and quoted names - the pieces UI5 error texts
 * carry that also appear verbatim in the source. Longest first, so the most
 * specific token is tried before its fragments; de-duplicated.
 */
export function errorTokens(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(/\/[A-Z0-9_]{2,}(?:\/[A-Z0-9_]+)*/g)) {
    out.add(m[0]);
  }
  for (const m of message.matchAll(/['"]([^'"\n]{3,60})['"]/g)) {
    out.add(m[1]);
  }
  return [...out].sort((a, b) => b.length - a.length);
}
