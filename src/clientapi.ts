/*
 * The z2ui5_if_client method reference - the knowledge behind the `client->`
 * hover and completion.
 *
 * The UI5 controls have the bundled metadata snapshot; the abap2UI5 client
 * API itself (`_bind`, `_event`, `view_display`, the popup family - the
 * methods every app calls) had nothing, so the one thing the linter could
 * only report AFTER the fact (popover_display takes xml, not val) is now
 * offered BEFORE it: signature and ABAP Doc, parsed from the interface
 * source by scripts/generate-client-api.mjs and bundled as JSON.
 *
 * `vscode`-free: pure lookups over the bundled data, so the test suite can
 * drive the cursor logic without an editor.
 */

import api from "./data/client-api.json";

export interface ClientMethod {
  name: string;
  signature: string;
  doc: string;
  /** Set when the interface's own abapdoc declares the method obsolete -
   *  completion strikes it through and sorts it last. */
  obsolete?: boolean;
}

const METHODS: ClientMethod[] = (api as { methods: ClientMethod[] }).methods;
const BY_NAME = new Map(METHODS.map((m) => [m.name.toLowerCase(), m]));

export function clientMethods(): ClientMethod[] {
  return METHODS;
}

export function clientMethod(name: string): ClientMethod | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/** The method name when the cursor sits on `client-><name>` (anywhere within
 *  the name), undefined otherwise. `me->client->x` counts too. */
export function clientCallAt(line: string, character: number): string | undefined {
  const re = /client->(\w+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index + "client->".length;
    const end = start + m[1].length;
    if (character >= start && character <= end) {
      return m[1];
    }
  }
  return undefined;
}

/** True when the cursor is completing a `client->` member (right after the
 *  arrow, or inside the partial name being typed). */
export function isClientCompletion(lineUpToCursor: string): boolean {
  return /client->\w*$/i.test(lineUpToCursor);
}

/** The first line of the signature, for the completion detail column. */
export function signatureHead(method: ClientMethod): string {
  return method.signature.split("\n")[0].replace(/\s+/g, " ").trim();
}

/** The parameter names of a method, in signature order - every `name TYPE …`
 *  line of the declaration (`VALUE(result)` is the returning value, not a
 *  parameter to fill, and does not match). */
export function signatureParameters(method: ClientMethod): string[] {
  const out: string[] = [];
  for (const line of method.signature.split("\n")) {
    const m = /^\s+(\w+)\s+TYPE\b/.exec(line);
    if (m) {
      out.push(m[1]);
    }
  }
  return out;
}

/**
 * The client call whose argument list is OPEN at the end of the line prefix,
 * with the parameter being written (`val` in `client->_event( val = ‸`).
 * Undefined when the innermost open parenthesis is not a `client->` call -
 * signature help inside some other call's arguments would mislead.
 *
 * The prefix should have literals and comments blanked (`blankNonCode`), so
 * an `=` inside a string does not pass for a parameter assignment.
 */
export function clientSignatureContext(
  lineUpToCursor: string
): { method: ClientMethod; parameter?: string } | undefined {
  let depth = 0;
  for (let i = lineUpToCursor.length - 1; i >= 0; i--) {
    const c = lineUpToCursor[i];
    if (c === ")") {
      depth++;
    } else if (c === "(") {
      if (depth === 0) {
        const m = /client->(\w+)\s*$/i.exec(lineUpToCursor.slice(0, i));
        const method = m && clientMethod(m[1]);
        if (!method) {
          return undefined;
        }
        const named = /(\w+)\s*=\s*[^=]*$/.exec(lineUpToCursor.slice(i + 1));
        return { method, parameter: named?.[1].toLowerCase() };
      }
      depth--;
    }
  }
  return undefined;
}

/** The published Client API reference - the docs site's page generated from
 *  the same interface this bundled JSON is parsed from
 *  (docs/scripts/generate-api-reference.mjs). */
export const API_REFERENCE_PAGE =
  "https://abap2ui5.github.io/docs/resources/api.html";

/** The reference page's anchor for one method, or undefined when none can be
 *  derived.
 *
 *  The docs generator writes each method as a `` ### `name` `` heading and
 *  VitePress slugs it with its default slugify: the heading's text content
 *  (the bare name - backticks and the obsolete badge are not part of it),
 *  runs of separator characters (underscore included) collapsed to one
 *  hyphen, leading and trailing separators trimmed, a leading digit guarded
 *  with `_`, all lowercased. Method names are ABAP identifiers
 *  ([A-Za-z0-9_]), for which this is exactly the rule below - so
 *  `view_display` -> `view-display`, `_bind_edit` -> `bind-edit`,
 *  `nest2_view_display` -> `nest2-view-display`, as the deployed page
 *  writes them. */
export function apiReferenceAnchor(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^(\d)/, "_$1");
  return slug === "" ? undefined : slug;
}

/** The reference URL for one method: deep-linked to its heading when an
 *  anchor is derivable, the top of the page otherwise. */
export function apiReferenceUrl(name: string): string {
  const anchor = apiReferenceAnchor(name);
  return anchor === undefined
    ? API_REFERENCE_PAGE
    : `${API_REFERENCE_PAGE}#${anchor}`;
}
