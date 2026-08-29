import { blankComments, blankNonCode } from "./abapscan";

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
 * breakpoint" for every class written that way. The next miss was the comma:
 * `INTERFACES: if_serializable_object, z2ui5_if_app.` lists the app interface
 * anywhere in the chain, so the whole statement is searched - `[^.]` keeps the
 * search inside ONE statement, which only works over blanked source where a
 * period in a literal or comment is already gone.
 */
export const APP_INTERFACE_RE = /\binterfaces\b[^.]*?\bz2ui5_if_app\b/i;

/** True when the source ITSELF writes `INTERFACES z2ui5_if_app`. */
export function isAppClass(source: string): boolean {
  return APP_INTERFACE_RE.test(blankNonCode(source));
}

/**
 * The superclass a class definition names, upper-cased, or undefined for a
 * root class.
 *
 * Read out of the `CLASS … DEFINITION …` statement only - `INHERITING FROM`
 * may not be looked for in the whole file, where a comment or a second class
 * in the same include would answer for the first one. Comments are blanked
 * first for the same reason.
 */
export function superclassOf(source: string): string | undefined {
  const def = classDefinitionIn(blankComments(source));
  return def
    ? /\binheriting\s+from\s+([\w/]+)/i.exec(def.statement)?.[1].toUpperCase()
    : undefined;
}

/**
 * Whether a class is an abap2UI5 app, INCLUDING one that inherits the
 * interface from a superclass.
 *
 * A shared base class carrying `INTERFACES z2ui5_if_app` and the lifecycle
 * methods, with each app redefining them, is a common way to keep a team's
 * apps uniform - and to the editor those apps looked like ordinary classes:
 * F9, the CodeLens, the apps tree and the navigation map all went quiet
 * (abap2UI5/vscode-extension#81).
 *
 * `sourceOf` answers with the source of a class by upper-cased name, or
 * undefined when this window cannot see it - which is the normal case for a
 * base class that lives in another package. Then the answer is "not an app",
 * the same as before, rather than a guess.
 */
export function isAppClassDeep(
  source: string,
  sourceOf: (className: string) => string | undefined,
  maxDepth = 16
): boolean {
  let text: string | undefined = source;
  const seen = new Set<string>();
  for (let depth = 0; depth <= maxDepth && text !== undefined; depth++) {
    if (isAppClass(text)) {
      return true;
    }
    const parent = superclassOf(text);
    // a cycle is not legal ABAP, but a half-written buffer is not legal ABAP
    // either and must not hang the editor
    if (!parent || seen.has(parent)) {
      return false;
    }
    seen.add(parent);
    text = sourceOf(parent);
  }
  return false;
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
const CLASS_DEF_RE = /^[ \t]*class\s+(\S+)\s+definition\b/gim;

/**
 * The first class the source actually DEFINES. A `CLASS lcl_x DEFINITION
 * DEFERRED.` in front of the real definition is only an announcement - taking
 * it for the definition returned the wrong class name and, worse, no
 * superclass at all, so an app inheriting the interface behind such a line
 * went unrecognised.
 */
function classDefinitionIn(
  code: string
): { name: string; index: number; statement: string } | undefined {
  for (const m of code.matchAll(CLASS_DEF_RE)) {
    const dot = code.indexOf(".", m.index);
    const statement = code.slice(m.index, dot < 0 ? code.length : dot);
    if (/\bdeferred\b/i.test(statement)) {
      continue;
    }
    return { name: m[1], index: m.index, statement };
  }
  return undefined;
}

/** Class name from the source, falling back to the file name. Upper case. */
export function classNameOf(source: string, fileName: string): string {
  const def = classDefinitionIn(source);
  if (def) {
    return def.name.toUpperCase();
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
  return classDefinitionIn(source)?.index ?? 0;
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
  // over blanked comments, so a commented-out declaration (`" DATA mv_x TYPE
  // string - the old spot`) is not where the jump lands - same offsets, so
  // every index found here still points into the source
  const code = blankComments(source);

  if (segments.length > 1) {
    const field = segments[segments.length - 1];
    const fieldRe = new RegExp(`\\b(${escape(field)})\\s+TYPE\\b`, "i");
    // both block shapes: the chained `BEGIN OF x, … END OF x` and the
    // statement-per-line `TYPES BEGIN OF x. TYPES f TYPE …. TYPES END OF x.`
    for (const block of code.matchAll(/(BEGIN\s+OF\s+\w+)([\s\S]*?)END\s+OF/gi)) {
      const m = fieldRe.exec(block[2]);
      if (m) {
        const start = block.index + block[1].length + m.index;
        return { start, end: start + field.length };
      }
    }
  }
  const root = segments[0];
  const m = new RegExp(`\\b(${escape(root)})\\s+TYPE\\b`, "i").exec(code);
  return m ? { start: m.index, end: m.index + root.length } : undefined;
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
