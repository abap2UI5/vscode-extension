/**
 * Reading a response body in the auth proxy: the one line of a rejection
 * page worth logging, and the charset handling around a document the hook
 * is planted into. `proxy.ts` re-exports the public part and is the module
 * to import from.
 */
import { redact } from "./report";

/**
 * How much of a rejection body to read. The sentence worth having is at the
 * top of the page; reading further only risks pulling a session id into a log
 * that gets pasted into issues.
 */
export const REJECTION_SNIFF_BYTES = 4096;

/**
 * Tags out, entities and runs of whitespace collapsed.
 *
 * The end tags allow whitespace before the `>` - `</script >` closes a
 * script exactly as `</script>` does, and a pattern that insists on the
 * bare form does not match it, leaves the element unremoved, and then has
 * its tags stripped by the general rule below. What is left is the script
 * BODY, in the one line that goes to the output channel and from there into
 * a pasted bug report - which is the opposite of what the redaction in this
 * file is for.
 */
function flatten(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The one line of a rejection page worth logging.
 *
 * SAP answers a refused logon with a full HTML page whose first line is a
 * doctype, so the naive "first line of the body" says nothing. The title
 * carries the message on the ICF logon error page; anything else falls back
 * to the flattened body. Redacted, because this ends up in the output channel
 * and from there in bug reports.
 */
export function describeRejection(body: string): string | undefined {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const text = flatten(title?.[1] ?? "") || flatten(body);
  return text ? redact(text).slice(0, 200) : undefined;
}

/** The charset a `Content-Type` declares, lowercased, or "" when it is silent. */
function charsetOf(contentType: string): string {
  return (
    /;\s*charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1].toLowerCase() ?? ""
  );
}

/** The labels the Encoding Standard maps to UTF-8 - and "" for a document
 *  that declares nothing, which has always been read as UTF-8 here. */
const UTF8_LABELS = new Set([
  "",
  "utf-8",
  "utf8",
  "unicode-1-1-utf-8",
  "unicode11utf8",
  "unicode20utf8",
  "x-unicode20utf8",
]);

/** The labels the Encoding Standard maps to windows-1252. ISO-8859-1 and
 *  US-ASCII among them: a browser decodes all of these as windows-1252, so a
 *  "latin1" page with a 0x80 in it shows a euro sign, not a control. */
const WINDOWS_1252_LABELS = new Set([
  "ansi_x3.4-1968",
  "ascii",
  "cp1252",
  "cp819",
  "csisolatin1",
  "ibm819",
  "iso-8859-1",
  "iso-ir-100",
  "iso8859-1",
  "iso88591",
  "iso_8859-1",
  "iso_8859-1:1987",
  "l1",
  "latin1",
  "us-ascii",
  "windows-1252",
  "x-cp1252",
]);

/** windows-1252 bytes 0x80-0x9F, from the Encoding Standard's index - the
 *  only range where it differs from ISO-8859-1. Five bytes are unassigned and
 *  map to the C1 control of the same value, as the index says. Written out
 *  because Node's `TextDecoder("windows-1252")` decodes the range as
 *  ISO-8859-1. */
const CP1252_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
];

function decodeWindows1252(body: Buffer): string {
  return body
    .toString("latin1")
    .replace(/[\x80-\x9f]/g, (c) =>
      String.fromCharCode(CP1252_HIGH[c.charCodeAt(0) - 0x80])
    );
}

/**
 * The body of an injectable document as text - or undefined when its charset
 * is one this host cannot decode, and the document has to pass through as it
 * came (unrewritten, without the hook) rather than be mangled.
 *
 * Everything the hook is planted into gets re-encoded as UTF-8, so a document
 * that arrived in another charset has to be decoded as such first, the way a
 * browser would: `toString("utf8")` turned every umlaut on an old ICM's
 * single-byte logon page into a replacement character, and decoding
 * windows-1252 as ISO-8859-1 turned its euro signs and dashes into C1
 * controls. Any other label goes to `TextDecoder`, which knows the Encoding
 * Standard's labels (ISO-8859-2, Shift_JIS, ...).
 */
export function decodeBody(body: Buffer, contentType: string): string | undefined {
  // A header without a charset leaves it to the document's own
  // `<meta charset>` / `http-equiv` - and the body leaves under a header that
  // says UTF-8, which outranks that meta. Read as UTF-8 regardless, an
  // ISO-8859-1 logon page lost every umlaut it had rendered with before.
  const charset =
    charsetOf(contentType) ||
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i
      .exec(body.subarray(0, 1024).toString("latin1"))?.[1]
      ?.toLowerCase() ||
    "";
  if (UTF8_LABELS.has(charset)) {
    return body.toString("utf8");
  }
  if (WINDOWS_1252_LABELS.has(charset)) {
    return decodeWindows1252(body);
  }
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return undefined; // a label this runtime does not know
  }
}

/** The same `Content-Type` with its charset set to UTF-8, which is what the
 *  injected document is encoded in when it leaves. */
export function withUtf8Charset(contentType: string): string {
  if (!contentType) {
    return "text/html; charset=utf-8";
  }
  return charsetOf(contentType)
    ? contentType.replace(/;\s*charset\s*=\s*"?[\w.:-]+"?/i, "; charset=utf-8")
    : `${contentType}; charset=utf-8`;
}
