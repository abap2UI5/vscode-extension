/*
 * Launch-URL helpers — pure, `vscode`-free, and therefore covered by the test
 * suite. The launch URL is the one thing that ties the extension to a system,
 * so the handful of string operations around it are worth pinning down.
 */

import { URL } from "url";

/** Collapses duplicate slashes in the path but leaves `://` in the protocol
 *  intact — a template ending in `/` next to a path starting with `/`. The
 *  query and fragment stay untouched: a parameter value legitimately carries
 *  `//` (a URL in a URL), and collapsing there corrupted it. */
export function normalizeUrl(url: string): string {
  const cut = url.search(/[?#]/);
  if (cut === -1) {
    return url.replace(/(?<!:)\/{2,}/g, "/");
  }
  return url.slice(0, cut).replace(/(?<!:)\/{2,}/g, "/") + url.slice(cut);
}

/** `https://host:44300/sap/bc/z2ui5?app_start=X` -> `host:44300/sap/bc/z2ui5` */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host + parsed.pathname;
  } catch {
    return url;
  }
}

/** The launch URL of one app: `{class}` replaced, slashes collapsed. */
export function expandTemplate(template: string, className: string): string {
  return normalizeUrl(
    template.replace(/\{class\}/gi, encodeURIComponent(className.toUpperCase()))
  );
}

/** A query parameter's NAME as a server reads it - `+` is a space and the
 *  percent escapes are decoded - for matching only; the pair itself is never
 *  rewritten from it. */
function paramName(pair: string): string {
  const eq = pair.indexOf("=");
  const raw = (eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, " ");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The URL with its query's `name=value` pairs edited as TEXT: every pair the
 * edit does not touch stays exactly as it was written, and so does
 * everything around the query (scheme, host, path, fragment). `edit` returns
 * the new pair list, or undefined when it changed nothing - the URL then
 * comes back byte-identical. Not a URL at all: back unchanged.
 *
 * Text rather than `URL.searchParams`, because the first mutation of a
 * `URLSearchParams` re-serialises the WHOLE query as form data: setting the
 * theme turned `%20` into `+`, `~` into `%7E`, `/` and `:` into `%2F`/`%3A`,
 * and a bare flag `?debug` into `debug=` - in parameters the user typed and
 * nobody asked to change. A system or an app that reads its own parameters
 * literally saw a different value.
 */
function editQuery(
  url: string,
  edit: (pairs: string[]) => string[] | undefined
): string {
  try {
    new URL(url);
  } catch {
    return url;
  }
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  const next = edit(query ? query.split("&") : []);
  if (!next) {
    return url;
  }
  return base + (next.length ? `?${next.join("&")}` : "") + fragment;
}

/**
 * Adds or replaces query parameters — how the preview switches the UI5 theme
 * and the logon language without touching the configured template. An empty
 * value removes the parameter again, so "back to the system default" is not a
 * special case. Only the named parameters are touched (see `editQuery`): a
 * replaced one keeps its place, a new one goes last, and a URL that needs no
 * change comes back as it was.
 */
export function withParams(
  url: string,
  params: Record<string, string | undefined>
): string {
  return editQuery(url, (pairs) => {
    let out = pairs;
    for (const [key, value] of Object.entries(params)) {
      const first = out.findIndex((pair) => paramName(pair) === key);
      if (!value) {
        out = out.filter((pair) => paramName(pair) !== key);
        continue;
      }
      const pair = `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
      // a replaced parameter keeps its place, a repeated one is folded into
      // it - what `URLSearchParams.set` did, minus re-encoding the rest
      out =
        first === -1
          ? [...out, pair]
          : out.flatMap((p, i) => (i === first ? [pair] : paramName(p) === key ? [] : [p]));
    }
    return out.join("&") === pairs.join("&") && out.length === pairs.length ? undefined : out;
  });
}

/**
 * The same URL without SAP's logon parameters (`sap-user`, `sap-password`) -
 * for a URL that leaves the extension's own hands. The screenshot hands its
 * page to headless Chromium as a command line argument, which every process
 * of this user can read, and a launch URL configured with those two carried
 * them there in clear text. The proxy injects the credentials anyway, so the
 * page loads exactly as before. Byte-identical when there is nothing to take
 * out, and every other parameter byte-identical when there is.
 */
export function withoutLogonParams(url: string): string {
  return editQuery(url, (pairs) => {
    const kept = pairs.filter((pair) => !/^sap-(user|password)$/i.test(paramName(pair)));
    return kept.length === pairs.length ? undefined : kept;
  });
}

/**
 * The launch URL rebased onto the running proxy: same path, query and hash,
 * loaded through `http://127.0.0.1:<port>/__abap2ui5/<token>` instead of the
 * system's origin.
 *
 * Rebuilt from the parsed parts rather than by replacing the origin substring,
 * for two reasons a plain `replace(origin, proxyOrigin)` got wrong:
 *
 * - `URL.origin` is normalised (lowercased host, default port dropped), so a
 *   launch URL written as `https://MyHost:443/...` never contained its own
 *   origin verbatim - the replace was a no-op and the iframe loaded the system
 *   DIRECTLY, where without the injected credentials it has nothing to show.
 * - a launch URL without a path (`https://host?app_start=X`) put the query
 *   right behind the token, making the token the LAST PATH SEGMENT - which the
 *   browser drops when resolving every relative url on the page
 *   (`resources/sap-ui-core.js` against `.../__abap2ui5/<token>?...` is
 *   `.../__abap2ui5/resources/sap-ui-core.js`, token gone). `pathname` is
 *   never empty, so the token always ends up followed by `/` and survives as
 *   a directory.
 */
export function proxiedUrl(
  externalUrl: string,
  proxyOrigin: string
): string | undefined {
  try {
    const parsed = new URL(externalUrl);
    return proxyOrigin + parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return undefined;
  }
}

/** The `sap-client` of a launch URL, needed for the ADT lookups. */
export function sapClientOf(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("sap-client") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Origin of a launch URL, or undefined when it has none worth the name.
 *
 * `host:44300/sap/bc/z2ui5?...` - a template typed without its scheme -
 * PARSES: `host:` is a valid scheme, and such a URL has the origin `"null"`,
 * the string. Truthy, so it went on to become the key the credentials were
 * stored under ("SAP User for null") and the origin the proxy was started
 * for, which is where it finally failed with "Invalid URL".
 */
export function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** True when the template can actually launch something: it has the
 *  placeholder, and it is an http(s) URL - not merely something the URL
 *  parser accepts (see `originOf` for the shape that slipped through). */
export function isUsableTemplate(template: string): boolean {
  const trimmed = template.trim();
  if (!trimmed || !/\{class\}/i.test(trimmed)) {
    return false;
  }
  try {
    const protocol = new URL(trimmed).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The port a URL actually talks to, default ports spelled out - `URL.port`
 *  is empty for 80/443, which makes two spellings of one authority compare
 *  unequal. */
function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/**
 * A `Location` header from the system, rebased onto the proxy when it points
 * back at the system - and left exactly as it is when it does not.
 *
 * This is `proxiedUrl`'s problem a second time, and it had the same wrong
 * answer: `location.replace(target.origin, proxyOrigin)`. `URL.origin` is
 * NORMALISED - lowercased host, default port dropped - so a system answering
 * `Location: https://MyHost:44300/sap/bc/...` (or dropping `:443` where the
 * configured origin kept it) does not contain the origin verbatim, the
 * replace silently does nothing, and the browser follows the redirect to the
 * system DIRECTLY. There it has no injected credentials, so it gets a 401 and
 * the preview stays white - the exact symptom the connection check exists to
 * explain.
 *
 * Compared by host and port rather than by whole origin on purpose: a system
 * that redirects http -> https on the same authority still has to be followed
 * through the proxy, which is the only route that carries the credentials.
 *
 * A relative `Location` (`/sap/bc/...`, `../x`) is already resolved against
 * the proxy's own origin by the browser, so it is returned untouched.
 */
export function rebasedLocation(
  location: string,
  target: URL,
  proxyOrigin: string
): string {
  let parsed: URL;
  try {
    // a relative Location has no origin of its own; resolving it against the
    // target is how we find out whether it would leave the system
    parsed = new URL(location, target);
  } catch {
    return location;
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(location) && !location.startsWith("//")) {
    // Path-relative (`../x`, `x?y=1`): the browser resolves it against the
    // page's own url, prefix and token included - rewriting it would double
    // the prefix. Root-relative (`/sap/bc/x`) resolves against the proxy's
    // BARE origin, where only the cookie authorizes and a browser marks the
    // redirected navigation cross-site (its initiator is the webview, not the
    // page) - so it is rebased onto the token like an absolute one: the
    // redirected document is authorized the way the page was, and its own
    // relative resources keep the prefix.
    return location.startsWith("/")
      ? proxyOrigin + parsed.pathname + parsed.search + parsed.hash
      : location;
  }
  if (
    parsed.hostname !== target.hostname ||
    effectivePort(parsed) !== effectivePort(target)
  ) {
    return location; // somewhere else entirely - not ours to rewrite
  }
  return proxyOrigin + parsed.pathname + parsed.search + parsed.hash;
}
