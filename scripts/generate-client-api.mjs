#!/usr/bin/env node
/*
 * Builds data/client-api.json - the z2ui5_if_client method reference behind
 * the `client->` hover and completion.
 *
 * The UI5 controls have a full metadata snapshot (dist/properties.json), but
 * the abap2UI5 client API itself - _bind, _event, view_display, the popup
 * family - had nothing: the methods every app calls were the one part of the
 * surface with no editor knowledge. This script parses the interface source
 * (ABAP Doc + METHODS signatures) into a JSON the extension bundles, so the
 * knowledge ships offline like the snapshot does.
 *
 *   node scripts/generate-client-api.mjs /path/to/abap2UI5
 *   node scripts/generate-client-api.mjs            (fetches from GitHub main)
 *   node scripts/generate-client-api.mjs --check    (fail when the committed
 *                                                    JSON is stale - the
 *                                                    drift gate the weekly
 *                                                    bump workflow runs)
 *
 * Regenerate when the interface changes upstream; commit the JSON. The parse
 * is line-based on purpose - the interface is hand-written ABAP with ABAP Doc
 * comments, not a grammar worth a real parser.
 */
import path from "path";
import { fileURLToPath } from "url";
import {
  emitSnapshot,
  invokedDirectly,
  parseArgs,
  readUpstream,
  requireShape,
} from "./lib/snapshot.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// under src/ so tsc (rootDir: src, resolveJsonModule) can import it; esbuild
// inlines it into both bundles, so the web build needs no fs for it either
const OUT = path.join(ROOT, "src", "data", "client-api.json");
const INTF_PATH = "src/02/z2ui5_if_client.intf.abap";
const RAW_URL = `https://raw.githubusercontent.com/abap2UI5/abap2UI5/main/${INTF_PATH}`;

/** ABAP Doc is parsed as HTML - strip the tags, keep the text. */
function plainDoc(lines) {
  return lines
    .map((l) => l.replace(/^\s*"!\s?/, ""))
    .join("\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The part of one ABAP line that is CODE: a full-line `*` comment is dropped,
 * a trailing `" …` comment is cut, and the content of `'…'` / `` `…` ``
 * literals is blanked (the quotes stay, so the line still reads as one).
 *
 * The signature scan counts parens and looks for the terminating period, and
 * it used to do both over the raw line - so a paren inside a `DEFAULT '(x'`
 * or a period inside a trailing comment mis-spanned the METHODS declaration
 * and silently swallowed every declaration that followed it. Only the gross
 * "nothing parsed at all" case was guarded.
 */
export function codeOf(line) {
  if (/^\s*\*/.test(line)) {
    return ""; // a full-line comment - column 1 is ABAP's rule, not an indent
  }
  let out = "";
  let quote;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (quote) {
      if (c === quote) {
        if (line[k + 1] === quote) {
          out += "  "; // a doubled quote is one escaped character, not an end
          k++;
          continue;
        }
        quote = undefined;
        out += c;
        continue;
      }
      out += " ";
      continue;
    }
    if (c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '"') {
      break; // a comment runs to the end of the line
    }
    out += c;
  }
  return out;
}

/** Every METHODS declaration with the ABAP Doc block above it. */
export function parseInterface(source) {
  const lines = source.split("\n");
  const methods = [];
  let doc = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*"!/.test(line)) {
      doc.push(line);
      continue;
    }
    const m = /^\s*METHODS\s+(\w+)/.exec(line);
    if (!m) {
      /* ABAP Doc documents what follows it DIRECTLY - a blank line ends the
       * block, exactly as ABAP's own doc processing reads it. Without this a
       * `"!` block left above an unrelated TYPES became the documentation of
       * the next METHODS several lines down, which hover would then show
       * against the wrong method. */
      doc = [];
      continue;
    }
    // the signature runs to the terminating period at paren depth 0
    const sig = [line];
    let depth = 0;
    let j = i;
    for (;;) {
      const text = codeOf(lines[j] ?? "");
      for (const c of text) {
        if (c === "(") depth++;
        else if (c === ")") depth--;
      }
      if (/\.\s*$/.test(text) && depth <= 0) {
        break;
      }
      j++;
      if (j >= lines.length) {
        break;
      }
      sig.push(lines[j]);
    }
    i = j;
    const docText = plainDoc(doc);
    methods.push({
      name: m[1],
      signature: sig
        .map((l) => l.replace(/\s+$/, ""))
        .join("\n")
        .replace(/^\s+/, ""),
      doc: docText,
      // The interface's own abapdoc is the single source of truth for what
      // is obsolete - carried as data so completion can strike the method
      // through instead of anyone re-learning it from the linter afterwards.
      ...(/^obsolete\b/i.test(docText) ? { obsolete: true } : {}),
    });
    doc = [];
  }
  return methods;
}

const TOOL = "generate-client-api";

if (invokedDirectly(import.meta.url)) {
  const { check, local } = parseArgs();
  const source = await readUpstream({
    tool: TOOL,
    file: INTF_PATH,
    local,
    url: RAW_URL,
  });
  const methods = parseInterface(source);
  requireShape({
    problems: methods.length
      ? []
      : [`${TOOL}: no METHODS parsed - did the interface layout change?`],
  });
  const json = `${JSON.stringify(
    {
      note: "z2ui5_if_client method reference for hover/completion. Generated by scripts/generate-client-api.mjs from the abap2UI5 sources - do not edit.",
      source: INTF_PATH,
      methods,
    },
    null,
    2
  )}\n`;
  emitSnapshot({
    out: OUT,
    json,
    check,
    stale:
      "client-api.json is STALE against the upstream interface - hover/completion now describe an API the core no longer has. Run `npm run client-api` and commit.",
    upToDate: `client-api.json: up to date (${methods.length} methods)`,
    wrote: `client-api.json: ${methods.length} methods from ${local ? path.join(local, INTF_PATH) : RAW_URL}`,
  });
}
