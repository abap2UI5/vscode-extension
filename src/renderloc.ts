/*
 * Where in the SOURCE a render-gate error belongs.
 *
 * The render gate reports strings ("Cannot add direct child…", "'Emphasised'
 * is of type string, expected sap.m.ButtonType…"), not findings with offsets
 * - they used to land on line 0 of every file, the one place nobody wrote
 * them. The error text almost always quotes the token that caused it (a
 * value, a control, a property), and that token exists in the source; the
 * first quoted token that does is where the squiggle belongs.
 *
 * Best effort by design: an error whose tokens appear nowhere keeps line 0
 * rather than guessing. `vscode`-free, so the token extraction is testable.
 */

/** Candidate needles from a render error message, most specific first:
 *  quoted tokens, then dotted control names, then CamelCase identifiers. */
export function renderErrorNeedles(message: string): string[] {
  const needles: string[] = [];
  const push = (s: string | undefined) => {
    const t = (s ?? "").trim();
    // a needle must be selective: one character, or a generic word, would
    // anchor the error to an arbitrary first hit
    if (t.length >= 3 && !needles.includes(t)) {
      needles.push(t);
    }
  };
  for (const m of message.matchAll(/'([^']+)'|"([^"]+)"|`([^`]+)`/g)) {
    push(m[1] ?? m[2] ?? m[3]);
  }
  for (const m of message.matchAll(/\b(?:sap|z2ui5)(?:\.\w+)+/g)) {
    // the local name is what the builder writes (`tag( \`Button\` )`)
    push(m[0].split(".").pop());
  }
  for (const m of message.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
    push(m[1]);
  }
  return needles;
}

/** The character offset of the first needle found in `text`, or undefined -
 *  the caller keeps its old fallback (line 0) then. */
export function renderErrorOffset(message: string, text: string): number | undefined {
  for (const needle of renderErrorNeedles(message)) {
    const ix = text.indexOf(needle);
    if (ix >= 0) {
      return ix;
    }
  }
  return undefined;
}
